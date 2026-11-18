/* Source Bridge frontend (with compiler support).
 * POST /send    multipart fields: message, source_language, language. Streams NDJSON
 *               events (chunk / error / complete) because the request sends
 *               "Accept: application/x-ndjson". The server compiles + runs the source first.
 * POST /execute JSON { code, language, inputs, eof } -> runs C, C++, Python or Java.
 * Uploaded files are read locally into the source editor.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const form = $("form");
  const source = $("message");
  const output = $("translatedCode");
  const language = $("language");
  const sourceLanguage = $("sourceLanguage");
  const translateButton = $("translateButton");
  const sidebar = $("sidebar");
  const sidebarToggle = $("sidebarToggle");
  const mobileQuery = window.matchMedia("(max-width: 900px)");
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const keys = {
    preferences: "sourceBridge.preferences.v1",
    saved: "sourceBridge.saved.v1",
    sidebar: "sourceBridge.sidebarCollapsed"
  };
  const endpoints = { execute: document.body.dataset.executeUrl || "/execute" };
  // Languages compiler.py can build and run -> the name /execute expects.
  const executableLanguages = { python: "python", java: "java", c: "c", "c++": "cpp" };
  const extensionMap = {
    python: "py", java: "java", c: "c", "c++": "cpp", javascript: "js",
    typescript: "ts", "c#": "cs", go: "go", rust: "rs", php: "php",
    swift: "swift", kotlin: "kt", ruby: "rb", sql: "sql", html: "html",
    css: "css", json: "json", xml: "xml", bash: "sh", shell: "sh",
    r: "r", lua: "lua", scala: "scala", dart: "dart"
  };

  // Storage can be unavailable in private/restricted browsers. The UI still works.
  function readStorage(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch (_) { return fallback; }
  }
  function writeStorage(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  }

  const storedPreferences = readStorage(keys.preferences, {});
  const preferences = {
    theme: ["light", "dark", "system"].includes(storedPreferences?.theme) ? storedPreferences.theme : "light",
    fontSize: [13, 14, 15, 16, 18].includes(storedPreferences?.fontSize) ? storedPreferences.fontSize : 15,
    lineNumbers: storedPreferences?.lineNumbers !== false
  };
  const storedSaved = readStorage(keys.saved, []);
  let saved = Array.isArray(storedSaved) ? storedSaved.filter((entry) =>
    entry && typeof entry.id === "string" && typeof entry.source === "string" &&
    typeof entry.output === "string" && typeof entry.language === "string"
  ).slice(0, 30) : [];
  let desktopCollapsed = readStorage(keys.sidebar, false) === true;
  let mobileOpen = false;
  let activeController = null;
  let completedTranslation = null;
  let sourceFileName = "";
  let toastTimer;
  let sourceHintTimer;
  let sourceHintDismissed = false;
  let fileReadVersion = 0;
  // Welcome -> language selection -> workspace. The confirmed pair lives in the
  // (hidden) sourceLanguage / language selects, which is what /send receives.
  let languagesConfirmed = false;
  let pendingSource = "";
  let pendingTarget = "";
  let setupView = "welcome";

  function notify(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").hidden = false;
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 3400);
  }

  function setStatus(message, isError = false) {
    $("statusMessage").textContent = message;
    $("statusMessage").classList.toggle("is-error", isError);
  }

  // The mobile drawer always starts closed, irrespective of the desktop preference.
  function updateSidebar() {
    const mobile = mobileQuery.matches;
    document.body.classList.toggle("sidebar-collapsed", !mobile && desktopCollapsed);
    document.body.classList.toggle("sidebar-open", mobile && mobileOpen);
   
    sidebar.inert = mobile && !mobileOpen;
    if (mobile && !mobileOpen) sidebar.setAttribute("aria-hidden", "true");
    else sidebar.removeAttribute("aria-hidden");
    const expanded = mobile ? mobileOpen : !desktopCollapsed;
    const label = mobile ? (mobileOpen ? "Close navigation" : "Open navigation") :
      (desktopCollapsed ? "Expand sidebar" : "Collapse sidebar");
    sidebarToggle.setAttribute("aria-expanded", String(expanded));
    sidebarToggle.setAttribute("aria-label", label);
    sidebarToggle.title = label;
    // Keep page controls outside the mobile drawer out of the keyboard order.
    $("mainContent").inert = mobile && mobileOpen;
    document.querySelector(".header-actions").inert = mobile && mobileOpen;
    document.querySelector(".brand").inert = mobile && mobileOpen;
  }

  function closeSidebar(returnFocus = false) {
    mobileOpen = false;
    updateSidebar();
    if (returnFocus) sidebarToggle.focus();
  }

  sidebarToggle.addEventListener("click", () => {
    if (mobileQuery.matches) {
      mobileOpen = !mobileOpen;
      updateSidebar();
      if (mobileOpen) $("sidebarClose").focus();
    } else {
      desktopCollapsed = !desktopCollapsed;
      writeStorage(keys.sidebar, desktopCollapsed);
      updateSidebar();
    }
  });
  $("sidebarClose").addEventListener("click", () => closeSidebar(true));
  $("sidebarBackdrop").addEventListener("click", () => closeSidebar(true));
  mobileQuery.addEventListener("change", () => {
    const focusWasInside = sidebar.contains(document.activeElement);
    mobileOpen = false;
    updateSidebar();
    if (mobileQuery.matches && focusWasInside) sidebarToggle.focus();
  });

  document.addEventListener("keydown", (event) => {
    if (!mobileQuery.matches || !mobileOpen) return;
    if (event.key === "Escape") { event.preventDefault(); closeSidebar(true); }
    if (event.key === "Tab") {
      const items = [sidebarToggle, ...sidebar.querySelectorAll("button:not(:disabled)")];
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });

  /* ---------- Theme switching with smooth transition ----------
   * 1) Primary: View Transitions API (GPU cross-fade of two full-screen snapshots, 650ms).
   * 2) Fallback: .theme-switching class (300ms CSS transition + soft blur overlay).
   * Respects prefers-reduced-motion (instant switch). */
  const THEME_VT_MS = 650;        // view-transition cross-fade length (keep in sync with CSS)
  const THEME_FALLBACK_MS = 300;  // fallback transition length (keep in sync with CSS)
  const THEME_ICON_DELAY = THEME_FALLBACK_MS / 2; // icon/label swap lands mid-fade (150ms)
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const rootEl = document.documentElement;
  let themeCleanupTimer = 0;
  let themeIconTimer = 0;

  function wantsDark() {
    return preferences.theme === "dark" || (preferences.theme === "system" && darkQuery.matches);
  }

  // Flips every CSS design token (via data-theme) + browser UI colour.
  function commitTheme(dark) {
    rootEl.dataset.theme = dark ? "dark" : "light";
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    const page = getComputedStyle(rootEl).getPropertyValue("--page").trim();
    if (page) meta.setAttribute("content", page);
  }

  // Moon/Sun icon + labels. When animating, wait ~150ms so the swap happens mid-fade.
  function syncThemeButton(dark, animate) {
    const button = $("themeToggle");
    const icon = button.querySelector(".icon");
    const label = `Switch to ${dark ? "light" : "dark"} mode`;
    const swap = () => {
      $("themeIcon").setAttribute("href", dark ? "#i-sun" : "#i-moon");
      button.setAttribute("aria-label", label);
      button.title = label;
      icon.classList.remove("theme-icon-turn");
    };
    clearTimeout(themeIconTimer);
    if (animate) {
      icon.classList.add("theme-icon-turn"); // smooth 90deg rotation
      themeIconTimer = setTimeout(swap, THEME_ICON_DELAY);
    } else {
      swap();
    }
  }

  function applyTheme(animate) {
    const dark = wantsDark();
    const next = dark ? "dark" : "light";
    const changed = rootEl.dataset.theme !== next;
    $("themeSetting").value = preferences.theme;

    // First paint, no real change, or user prefers reduced motion -> instant.
    if (!animate || !changed || reducedMotionQuery.matches) {
      commitTheme(dark);
      syncThemeButton(dark, false);
      return;
    }

    syncThemeButton(dark, true);
    clearTimeout(themeCleanupTimer);

    if (typeof document.startViewTransition === "function") {
      // Primary engine: freeze old screen, flip tokens, cross-fade old -> new on the GPU.
      rootEl.classList.add("theme-vt"); // disables per-element transitions so nothing fights the fade
      const transition = document.startViewTransition(() => commitTheme(dark));
      const done = () => rootEl.classList.remove("theme-vt");
      transition.finished.then(done, done);
    } else {
      // Fallback: synchronized 300ms CSS transition + soft blur overlay.
      rootEl.classList.add("theme-switching");
      commitTheme(dark);
      themeCleanupTimer = setTimeout(() => rootEl.classList.remove("theme-switching"), THEME_FALLBACK_MS + 50);
    }
  }

  function applyPreferences(animateTheme = false) {
    applyTheme(animateTheme);
    rootEl.style.setProperty("--code-size", `${preferences.fontSize}px`);
    rootEl.style.setProperty("--code-line", `${Math.round(preferences.fontSize * 1.73)}px`);
    document.body.classList.toggle("hide-line-numbers", !preferences.lineNumbers);
    $("fontSizeSetting").value = String(preferences.fontSize);
    $("lineNumbersSetting").checked = preferences.lineNumbers;
    syncScroll(source, $("sourceLines"));
    syncScroll(output, $("outputLines"));
  }
  function savePreferences(animateTheme = false) { applyPreferences(animateTheme); writeStorage(keys.preferences, preferences); }
  $("themeToggle").addEventListener("click", () => {
    preferences.theme = rootEl.dataset.theme === "dark" ? "light" : "dark";
    savePreferences(true);
  });
  $("themeSetting").addEventListener("change", (event) => { preferences.theme = event.target.value; savePreferences(true); });
  $("fontSizeSetting").addEventListener("change", (event) => { preferences.fontSize = Number(event.target.value); savePreferences(); });
  $("lineNumbersSetting").addEventListener("change", (event) => { preferences.lineNumbers = event.target.checked; savePreferences(); });
  // Live OS theme sync: same smooth transition when the device theme changes.
  darkQuery.addEventListener("change", () => { if (preferences.theme === "system") applyPreferences(true); });

  document.querySelectorAll("[data-dialog]").forEach((button) => {
    button.addEventListener("click", () => {
      if (mobileOpen) closeSidebar(true);
      $(button.dataset.dialog).showModal();
    });
  });
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      const rect = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
    });
  });

  /* =========================================
     NAVIGATION AND PAGE TRANSITIONS
  ========================================= */

  let currentView = "welcome";

  const viewOrder = {
    welcome: 0,
    languages: 1,
    translate: 2,
    saved: 3
  };


  /* RESTART CSS ANIMATION ON EVERY CLICK */

  function restartAnimation(item, className) {
    item.classList.remove(className);

    // Force browser to recalculate animation
    void item.offsetWidth;

    item.classList.add(className);
  }


  /* ACTIVE AND INACTIVE NAVIGATION ICONS */

  function selectNavigationItem(item) {

    const previous = document.querySelector(".nav-item.active");

    // Animate previous active icon
    if (previous && previous !== item) {

      previous.classList.remove("active", "animate");

      previous.removeAttribute("aria-current");

      restartAnimation(previous, "leave");
    }

    // Activate new navigation icon
    item.classList.remove("leave");

    item.classList.add("active");

    item.setAttribute("aria-current", "page");

    restartAnimation(item, "animate");
  }


  /* PAGE SWITCHING WITH EXIT AND ENTRY ANIMATIONS */

  function showView(view) {

    // Until languages are confirmed, the Translate tab leads to the welcome / selection steps.
    if (view === "translate" && !languagesConfirmed) {
      view = setupView;
    }

    if (!Object.prototype.hasOwnProperty.call(viewOrder, view)) {
      return;
    }

    if (view === currentView) {
      return;
    }

    if (view === "languages") {
      prepareLanguageView();
    }

    const goingDown =
      viewOrder[view] > viewOrder[currentView];
          // Welcome, language selection and workspace are steps, so they slide sideways
    const sideways = view !== "saved" && currentView !== "saved";
    const main = $("mainContent");

    currentView = view;


    /* COMPLETE PAGE SWITCH */

    function finishSwitch() {

      $("welcomeView").hidden = view !== "welcome";

      $("languageView").hidden = view !== "languages";

      $("translateView").hidden = view !== "translate";

      $("savedView").hidden = view !== "saved";

      // Welcome, language selection and the workspace all sit under the Translate tab.
      const tab = view === "saved" ? "saved" : "translate";

      [$("translateNav"), $("savedNav")].forEach(button => {

        const current = button.dataset.view === tab;

        button.classList.toggle("active", current);

        if (current) {
          button.setAttribute("aria-current", "page");
        } else {
          button.removeAttribute("aria-current");
        }
      });

      // Refresh saved translations
      if (view === "saved") {
        renderSaved();
      }

      // Line gutters cannot be measured while the workspace is hidden
      if (view === "translate") {
        syncScroll(source, $("sourceLines"));
        syncScroll(output, $("outputLines"));
      }

      window.scrollTo(0, 0);

      // Close mobile sidebar
      if (mobileOpen) {
        closeSidebar();
      }
    }


    /* ACCESSIBILITY CHECK */

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {

      finishSwitch();

      main.focus({ preventScroll: true });

      return;
    }


    /* DETERMINE TRANSITION DIRECTION */

        const exitClass = sideways
      ? (goingDown ? "view-exit-left" : "view-exit-right")
      : (goingDown ? "view-exit-up" : "view-exit-down");

    const enterClass = sideways
      ? (goingDown ? "view-enter-from-right" : "view-enter-from-left")
      : (goingDown ? "view-enter-from-bottom" : "view-enter-from-top");


    /* REMOVE PREVIOUS TRANSITION CLASSES */

    main.classList.remove(
      "view-exit-up",
      "view-exit-down",
      "view-enter-from-bottom",
      "view-enter-from-top",
      "view-exit-left",
      "view-exit-right",
      "view-enter-from-right",
      "view-enter-from-left"
    );


    /* START EXIT ANIMATION */

    main.classList.add(exitClass);


    /* WAIT FOR EXIT ANIMATION TO FINISH */

    main.addEventListener("animationend", function onExit(event) {

      if (event.target !== main) return;

      main.removeEventListener("animationend", onExit);

      main.classList.remove(exitClass);


      /* CHANGE THE ACTUAL PAGE */

      finishSwitch();


      /* START NEW PAGE ENTRANCE ANIMATION */

      main.classList.add(enterClass);


      main.addEventListener("animationend", function onEnter(event) {

        if (event.target !== main) return;

        main.removeEventListener("animationend", onEnter);

        main.classList.remove(enterClass);

        main.focus({ preventScroll: true });

      });

    });

  }


  /* =========================================
     NAVIGATION CLICK EVENTS
  ========================================= */

  document.querySelectorAll("[data-view]").forEach(button => {

    button.addEventListener("click", () => {

      const navItem = button.classList.contains("nav-item")
        ? button
        : document.querySelector(
            `.nav-item[data-view="${button.dataset.view}"]`
          );

      if (navItem) {
        selectNavigationItem(navItem);
      }

      showView(button.dataset.view);

    });

  });


  /* CLEAN UP ICON ANIMATION CLASSES */

  document.querySelectorAll(".nav-item[data-view]").forEach(item => {

    item.addEventListener("animationend", event => {

      if (event.target === item.querySelector(".icon")) {

        item.classList.remove("animate", "leave");

      }

    });

  });

  function syncScroll(editor, gutter) { gutter.style.transform = `translateY(${-editor.scrollTop}px)`; }
  function updateLines(editor, gutter) {
    const count = Math.max(5, editor.value.split("\n").length);
    if (gutter.dataset.count !== String(count)) {
      gutter.textContent = Array.from({ length: count }, (_, index) => index + 1).join("\n");
      gutter.dataset.count = String(count);
    }
    syncScroll(editor, gutter);
  }
  [[source, $("sourceLines")], [output, $("outputLines")]].forEach(([editor, gutter]) => {
    editor.addEventListener("scroll", () => syncScroll(editor, gutter), { passive: true });
    updateLines(editor, gutter);
  });

  function targetLanguage() { return language.value.trim(); }
  function updateSourceRunHint() {
    const hint = $("runSourceHint");
    if (!source.value) {
      clearTimeout(sourceHintTimer);
      sourceHintTimer = null;
      sourceHintDismissed = false;
      hint.classList.remove("is-hiding");
      hint.hidden = true;
    } else if (hint.hidden && !sourceHintDismissed) {
      hint.hidden = false;
      hint.classList.remove("is-hiding");
      sourceHintTimer = setTimeout(() => {
        hint.classList.add("is-hiding");
        sourceHintTimer = setTimeout(() => {
          hint.hidden = true;
          hint.classList.remove("is-hiding");
          sourceHintDismissed = true;
          sourceHintTimer = null;
        }, 220);
      }, 5000);
    }
  }
  function refreshButtons() {
    const loading = Boolean(activeController);
    translateButton.disabled = !loading && (!source.value.trim() || !targetLanguage());
    $("copySource").disabled = !source.value;
    $("runSource").disabled = loading || !source.value.trim();
    $("runOutput").disabled = loading || !output.value.trim();
    $("copyOutput").disabled = !output.value;
    $("downloadButton").disabled = !completedTranslation || loading;
    $("saveButton").disabled = !completedTranslation || loading;
    const alreadySaved = completedTranslation && saved.some((entry) => entry.source === completedTranslation.source &&
      entry.output === completedTranslation.output && entry.language === completedTranslation.language);
    $("saveButton").classList.toggle("is-saved", Boolean(alreadySaved));
    $("saveButton").setAttribute("aria-pressed", String(Boolean(alreadySaved)));
    $("saveButton").title = alreadySaved ? "Translation saved in this browser" : "Save translation in this browser";
    $("saveButton").setAttribute("aria-label", $("saveButton").title);
  }
  function setLoading(loading) {
    document.body.classList.toggle("is-translating", loading);
    document.querySelector(".output-card").setAttribute("aria-busy", String(loading));
    source.readOnly = loading;
    language.disabled = loading;
    sourceLanguage.disabled = loading;
    $("changeLanguages").disabled = loading;
    $("uploadButton").disabled = loading;
    $("attachment").disabled = loading;
    $("translateLabel").textContent = loading ? "Stop" : "Translate";
    translateButton.setAttribute("aria-label", loading ? "Stop translation" : "Translate code");
    refreshButtons();
  }
  // The target list never offers the language the code is already written in.
  function updateTargetLanguageOptions() {
    const sourceValue = sourceLanguage.value.trim().toLowerCase();
    const options = Array.from(language.options);
    for (const option of options) {
      const same = option.value.trim().toLowerCase() === sourceValue;
      option.hidden = same;
      option.disabled = same;
    }
    if (language.selectedOptions[0]?.disabled) {
      const next = options.find((option) => !option.disabled);
      if (next) language.value = next.value;
    }
  }
  function languageChanged() {
    updateTargetLanguageOptions();
    updateLanguageLabels();
    refreshButtons();
  }

  // Shows the confirmed pair in the workspace: centre column, panel badges and placeholders.
  function updateLanguageLabels() {
    const from = languagesConfirmed ? sourceLanguage.value : "";
    const to = languagesConfirmed ? language.value : "";
    $("sourceLanguageLabel").textContent = from || "Source";
    $("targetLanguageLabel").textContent = to || "Target";
    $("sourceLanguageBadge").textContent = from;
    $("sourceLanguageBadge").hidden = !from;
    $("targetLanguageBadge").textContent = to;
    $("targetLanguageBadge").hidden = !to;
    source.placeholder = from ? `Paste your ${from} code here...` : "Paste your code here...";
    output.placeholder = to ? `Your ${to} code will appear here...` : "Your translated code will appear here...";
  }

  // Step 1 picks the source language, step 2 the target. The chosen source is
  // not offered as a target.
  function renderLanguageChoices() {
    document.querySelectorAll('input[name="sourceChoice"]').forEach((input) => {
      input.checked = input.value === pendingSource;
      input.closest(".language-option").classList.toggle("is-selected", input.checked);
    });
    document.querySelectorAll('input[name="targetChoice"]').forEach((input) => {
      const option = input.closest(".language-option");
      const isSource = input.value === pendingSource;
      input.disabled = !pendingSource || isSource;
      input.checked = !input.disabled && input.value === pendingTarget;
      option.classList.toggle("is-selected", input.checked);
      option.classList.toggle("is-disabled", input.disabled);
      option.title = isSource ? "Already selected as the source language" : "";
    });
    $("targetStep").classList.toggle("is-locked", !pendingSource);
    $("targetStepHelp").textContent = pendingSource ? `The language to translate your ${pendingSource} code into.` : "Select a source language first.";
    $("continueButton").disabled = !(pendingSource && pendingTarget);
    $("languagePrompt").textContent = !pendingSource ? "Start by selecting the language your code is written in." :
      !pendingTarget ? "Now select the language you want to translate into." :
      `${pendingSource} to ${pendingTarget}. Continue when you're ready.`;
  }
  // Opening the selection screen from the workspace preselects the current pair.
  function prepareLanguageView() {
    setupView = "languages";
    pendingSource = languagesConfirmed ? sourceLanguage.value : "";
    pendingTarget = languagesConfirmed && language.value !== pendingSource ? language.value : "";
        // Back is only offered on the first visit (it returns to the welcome screen)
    $("languageBack").hidden = languagesConfirmed;
    renderLanguageChoices();
  }
  document.querySelectorAll('input[name="sourceChoice"]').forEach((input) => {
    input.addEventListener("change", () => {
      pendingSource = input.value;
      if (pendingTarget === pendingSource) pendingTarget = "";
      renderLanguageChoices();
    });
  });
  document.querySelectorAll('input[name="targetChoice"]').forEach((input) => {
    input.addEventListener("change", () => { pendingTarget = input.value; renderLanguageChoices(); });
  });
  // Same language logos the workspace used; an option simply shows no logo if the CDN is unreachable.
  document.querySelectorAll(".language-option").forEach((option) => {
    const slug = { python: "python", java: "java", c: "c", "c++": "cplusplus" }[option.querySelector("input").value.toLowerCase()];
    if (!slug) return;
    const logo = new Image();
    logo.className = "language-option-icon";
    logo.alt = "";
    logo.setAttribute("aria-hidden", "true");
    logo.onerror = () => logo.remove();
    logo.src = `https://cdn.jsdelivr.net/gh/devicons/devicon/icons/${slug}/${slug}-original.svg`;
    option.insertBefore(logo, option.querySelector("span"));
  });
  $("getStartedButton").addEventListener("click", () => showView("languages"));
  $("languageBack").addEventListener("click", () => showView(languagesConfirmed ? "translate" : "welcome"));
  $("changeLanguages").addEventListener("click", () => { if (!activeController) showView("languages"); });
  $("continueButton").addEventListener("click", () => {
    if (!pendingSource || !pendingTarget || activeController) return;
    const hadLanguages = languagesConfirmed;
    const sourceChanged = !hadLanguages || sourceLanguage.value !== pendingSource;
    const targetChanged = !hadLanguages || language.value !== pendingTarget;
    sourceLanguage.value = pendingSource;
    updateTargetLanguageOptions();
    language.value = pendingTarget;
    languagesConfirmed = true;
    // A result in the previous target language no longer matches the workspace.
    if (hadLanguages && targetChanged && output.value) {
      const panel = $("outputRunOutput");
      const stopRun = liveStops.get(panel);
      if (stopRun) stopRun();
      cancelPanelAnim(panel);
      panel.hidden = true;
      panel.textContent = "";
      output.value = "";
      completedTranslation = null;
      updateLines(output, $("outputLines"));
    }
    languageChanged();
    showView("translate");
    if (sourceChanged || targetChanged) setStatus(source.value.trim() ? `Ready to translate ${sourceLanguage.value} to ${language.value}.` : "");
  });

  source.addEventListener("input", () => {
    fileReadVersion += 1;
    updateLines(source, $("sourceLines"));
    updateSourceRunHint();
    refreshButtons();
    if (completedTranslation) setStatus("Source updated. Translate again to refresh the result.");
    else setStatus("");
  });
  function isAltEnter(event, shiftKey = false) {
    return event.key === "Enter" && event.shiftKey === shiftKey &&
      (event.altKey || event.getModifierState("AltGraph"));
  }
  source.addEventListener("keydown", (event) => {
    if (isAltEnter(event)) {
      event.preventDefault();
      $("runSource").click();
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!activeController) form.requestSubmit();
    }
  });
  if (/Mac|iPhone|iPad/.test(navigator.platform)) $("shortcutModifier").textContent = "⌘";

  function appendOutput(text) {
    const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 45;
    const previousTop = output.scrollTop;
    output.value += text;
    output.scrollTop = atBottom ? output.scrollHeight : previousTop;
    updateLines(output, $("outputLines"));
    $("copyOutput").disabled = !output.value;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (activeController) { activeController.abort(); return; }
    if (!source.value.trim()) { setStatus("Paste or upload some code first.", true); source.focus(); return; }
    const target = targetLanguage();
    if (!target) { setStatus("Choose a target language.", true); language.focus(); return; }

    // Keep the same form field names and the same streaming endpoint as server.py.
    const originalSource = source.value;
    const originalFileName = sourceFileName;
    const data = new FormData();
    data.append("message", originalSource);
    data.append("source_language", sourceLanguage.value);
    data.append("language", target);
    const controller = new AbortController();
    activeController = controller;
    completedTranslation = null;
    output.value = "";
    output.scrollTop = 0;
    updateLines(output, $("outputLines"));
    setLoading(true);
    setStatus(`Translating to ${target}…`);

    try {
      const response = await fetch(form.action, {
        method: "POST", body: data, signal: controller.signal, credentials: "same-origin",
        headers: { Accept: "application/x-ndjson" }
      });
      if (!response.ok) throw new Error(`Translation failed (${response.status}). Please try again.`);
      if (response.headers.get("content-type")?.includes("text/html")) throw new Error("The server returned a page instead of code. Please try again.");
      // NDJSON: one JSON event per line. Falls back to plain text if the server ignores Accept.
      const events = response.headers.get("content-type")?.includes("application/x-ndjson");
      let pendingText = "";
      let completed = false;
      function consumeLine(line) {
        if (!line.trim()) return;
        let item;
        try { item = JSON.parse(line); }
        catch (_) { throw new Error("The translation stream was interrupted. Please try again."); }
        if (item.type === "chunk" && typeof item.text === "string") appendOutput(item.text);
        else if (item.type === "error") throw new Error(item.message || "Translation failed. Please try again.");
        else if (item.type === "complete") completed = true;
      }
      function consumeText(text) {
        if (!events) { appendOutput(text); return; }
        pendingText += text;
        let end;
        while ((end = pendingText.indexOf("\n")) !== -1) {
          const line = pendingText.slice(0, end);
          pendingText = pendingText.slice(end + 1);
          consumeLine(line);
        }
      }
      if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            consumeText(decoder.decode(value, { stream: true }));
          }
          consumeText(decoder.decode());
        } catch (error) {
          try { await reader.cancel(); } catch (_) { /* already closed */ }
          throw error;
        } finally { reader.releaseLock(); }
      } else { consumeText(await response.text()); }
      if (events) {
        if (pendingText.trim()) consumeLine(pendingText);
        if (!completed && !output.value.trim()) throw new Error("The translation stopped before completion. Please try again.");
      }
      if (controller.signal.aborted) throw new DOMException("Translation stopped", "AbortError");
      // Existing server.py returns upstream errors as plain text with HTTP 200.
      if (/^\s*Error:\s*/i.test(output.value)) throw new Error(output.value.trim());
      if (!output.value.trim()) throw new Error("No code was returned. Please try translating again.");
      completedTranslation = { source: originalSource, output: output.value, language: target, sourceLanguage: sourceLanguage.value, fileName: originalFileName };
      setStatus(`Translated to ${target}. Ready to run, copy, save, or download.`);
    } catch (error) {
      if (error.name === "AbortError") setStatus("Translation stopped. Any partial result is shown above.");
      else {
        const message = error instanceof TypeError ? "Could not reach the server. Check your connection and try again." : error.message;
        setStatus(message || "Translation failed. Please try again.", true);
        if (/^\s*Error:\s*/i.test(output.value)) output.value = "";
      }
    } finally {
      activeController = null;
      updateLines(output, $("outputLines"));
      setLoading(false);
    }
  });

  // File contents, rather than an attachment, become the existing message field.
  function updateFileLabel() {
    $("fileHelp").textContent = sourceFileName || "Supports .py, .java, .cpp, .c, .js, .txt & more";
    $("fileHelp").classList.toggle("has-file", Boolean(sourceFileName));
    $("fileHelp").title = sourceFileName;
  }
  async function loadFile(file) {
    if (!file || activeController) return;
    if (file.size > 1024 * 1024) { notify("Please choose a code file smaller than 1 MB."); return; }
    if (/^(image|audio|video)\//.test(file.type) || /\.(pdf|docx?|zip|exe|xlsx?|pptx?)$/i.test(file.name)) {
      notify("Choose a text-based code file, such as .py, .java, .cpp, or .txt."); return;
    }
    const version = ++fileReadVersion;
    try {
      const text = await file.text();
      if (version !== fileReadVersion || activeController) return;
      if (text.includes("\u0000")) { notify("This file isn't UTF-8 text. Please upload a plain-text code file."); return; }
      source.value = text.replace(/^\uFEFF/, "");
      updateSourceRunHint();
      sourceFileName = file.name;
      source.scrollTop = 0;
      updateFileLabel();
      updateLines(source, $("sourceLines"));
      refreshButtons();
      source.focus();
      setStatus(source.value.trim() ? "File loaded. Choose a language and translate." : "This file is empty.");
    } catch (_) { notify("This file couldn't be read. Please try another file."); }
  }
  $("uploadButton").addEventListener("click", () => $("attachment").click());
  $("attachment").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    await loadFile(file);
  });
  const sourceCard = document.querySelector(".source-card");
  sourceCard.addEventListener("dragover", (event) => {
    if (Array.from(event.dataTransfer.types).includes("Files")) {
      event.preventDefault();
      if (!activeController) sourceCard.classList.add("is-drag-over");
    }
  });
  sourceCard.addEventListener("dragleave", (event) => {
    if (!sourceCard.contains(event.relatedTarget)) sourceCard.classList.remove("is-drag-over");
  });
  sourceCard.addEventListener("drop", (event) => {
    sourceCard.classList.remove("is-drag-over");
    if (event.dataTransfer.files.length) {
      event.preventDefault();
      if (event.dataTransfer.files.length > 1) notify("Opening the first file. Upload one code file at a time.");
      loadFile(event.dataTransfer.files[0]);
    }
  });

  async function copyText(text, button) {
    if (!text) return;
    try {
      try { await navigator.clipboard.writeText(text); }
      catch (_) {
        // Fallback for non-HTTPS local network development servers.
        const previous = document.activeElement;
        const temporary = document.createElement("textarea");
        temporary.value = text;
        temporary.className = "sr-only";
        document.body.appendChild(temporary);
        temporary.select();
        let copied = false;
        try { copied = document.execCommand("copy"); }
        finally { temporary.remove(); previous?.focus({ preventScroll: true }); }
        if (!copied) throw new Error("Clipboard unavailable");
      }
      const icon = button.querySelector("use");
      icon.setAttribute("href", "#i-check");
      notify("Code copied to clipboard.");
      setTimeout(() => icon.setAttribute("href", "#i-copy"), 1700);
    } catch (_) { notify("Couldn't copy automatically. Select the code and copy it manually."); }
  }
  $("copySource").addEventListener("click", () => copyText(source.value, $("copySource")));
  $("copyOutput").addEventListener("click", () => copyText(output.value, $("copyOutput")));

  // ---------- RUN WITH LABELLED INPUT (nothing stays running on the server) ----------
  //  1. Run sends the WHOLE program to /execute with the answers typed so far (none at first).
  //  2. If the program needs more input it stops itself and the server answers "needs_input"
  //     with what was printed so far and which variable asks (e.g. "a, b").
  //  3. The page shows an input box for that variable; on Send the answer is stored and step 1
  //     repeats with the longer list of answers.
  //  4. When no more input is needed the final output is shown.
  // `at` = the exact spot inside the output where the answer was asked for, so the terminal can
  // show every typed answer in the right place (the re-run output has no echo).
  const liveStops = new WeakMap();   // panel -> function that stops its current run
  let activeCompilerPanel = null;
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.target instanceof Element && event.target.closest("dialog[open]")) return;

    if (isAltEnter(event, true)) {
      let focusedPanel = event.target instanceof Element ?
        event.target.closest(".run-output.is-terminal:not([hidden])") : null;
      if (!focusedPanel && event.target === source) focusedPanel = $("sourceRunOutput");
      if (!focusedPanel && event.target === output) focusedPanel = $("outputRunOutput");
      if (!focusedPanel || focusedPanel.hidden || focusedPanel.classList.contains("is-leaving")) {
        focusedPanel = activeCompilerPanel;
      }
      if (!focusedPanel || focusedPanel.hidden || focusedPanel.classList.contains("is-leaving")) {
        const visiblePanels = document.querySelectorAll(".run-output.is-terminal:not([hidden]):not(.is-leaving)");
        focusedPanel = visiblePanels[visiblePanels.length - 1] || null;
      }
      const rerunButton = focusedPanel?.querySelector(".term-rerun:not(:disabled)");
      if (rerunButton) {
        event.preventDefault();
        rerunButton.click();
      }
      return;
    }
    if (event.key !== "Escape") return;

    let panel = event.target instanceof Element ? event.target.closest(".run-output.is-terminal") : null;
    if (!panel || panel.hidden || panel.classList.contains("is-leaving")) panel = activeCompilerPanel;
    if (!panel || panel.hidden || panel.classList.contains("is-leaving")) {
      const visiblePanels = document.querySelectorAll(".run-output.is-terminal:not([hidden]):not(.is-leaving)");
      panel = visiblePanels[visiblePanels.length - 1] || null;
    }
    const closeButton = panel?.querySelector(".term-close:not(:disabled)");
    if (!closeButton) return;
    event.preventDefault();
    closeButton.click();
  });

  function withAnswers(stdout, answers) {
    let text = "";
    let last = 0;
    for (const answer of answers) {
      const at = Math.min(Math.max(answer.at, last), stdout.length);
      text += stdout.slice(last, at) + answer.value + "\n";
      last = at;
    }
    return text + stdout.slice(last);
  }

  function freshPrompt(stdout, from) {
    const fresh = stdout.slice(Math.min(from, stdout.length));
    let tail = fresh.slice(fresh.lastIndexOf("\n") + 1).trim();
    if (!tail) {
      const lines = fresh.split("\n").map((line) => line.trim()).filter(Boolean);
      tail = lines.length ? lines[lines.length - 1] : "";
    }
    return tail.slice(-120);
  }

  async function postExecute(payload, signal) {
    const response = await fetch(endpoints.execute, {
      method: "POST", credentials: "same-origin", cache: "no-store", signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload)
    });
    let data;
    try { data = await response.json(); }
    catch (_) {
      const error = new Error(`The server returned an unexpected response (${response.status}). Please try again.`);
      error.status = response.status;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status}). Please try again.`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function makeEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------- PANEL HEIGHT ANIMATION (open, close AND every change in between) ----------
  // The panel is always `height: auto`. Whenever its content changes size (output grows, the input
  // row appears or goes away, a button is shown or hidden, the run finishes ...) a MutationObserver
  // notices before the browser paints, and the height is animated from the old size to the new one
  // with the Web Animations API. Opening animates 0 -> real height, closing real height -> 0.
  // When an animation ends nothing is left behind, so the panel is back to plain auto height.
  const panelAnims = new WeakMap();   // panel -> the animation that is running now
  const panelState = new WeakMap();   // panel -> { last: last settled height, target: where the running animation ends, margin }
  const OPEN_MS = 380, CLOSE_MS = 300, RESIZE_MS = 280;
  const EASE_OPEN = "cubic-bezier(.22, .61, .36, 1)", EASE_CLOSE = "cubic-bezier(.4, 0, .2, 1)";

  function motionAllowed() {
    return typeof Element.prototype.animate === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  // Height the panel WANTS to have: its borders + its children. Unlike getBoundingClientRect it is not
  // affected by an animation that is running, so it is safe to read at any time.
  function naturalHeight(panel) {
    let height = panel.offsetHeight - panel.clientHeight;
    for (const child of panel.children) height += child.offsetHeight;
    return height;
  }
  function stateOf(panel) {
    let state = panelState.get(panel);
    if (!state) {
      state = { last: 0, target: 0, margin: 0 };
      panelState.set(panel, state);
      new MutationObserver(() => onPanelChange(panel)).observe(panel, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ["class", "hidden"]
      });
      // Keeps `last` right when the height changes by itself (window resized, text re-wrapped).
      if ("ResizeObserver" in window) {
        new ResizeObserver(() => {
          if (!panelAnims.get(panel) && !panel.hidden) state.last = naturalHeight(panel);
        }).observe(panel);
      }
    }
    return state;
  }
  function cancelPanelAnim(panel) {
    const running = panelAnims.get(panel);
    if (running) stateOf(panel).last = panel.getBoundingClientRect().height;   // where it visibly is now
    panelAnims.delete(panel);
    panel.classList.remove("is-entering", "is-leaving");
    if (running) running.cancel();
  }
  function revealPanel(panel) {
    // Make sure the whole terminal is on screen once it has finished opening.
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // One animation from `from` to `to` px. Used for opening and for every later size change.
  function growPanel(panel, o) {
    const state = stateOf(panel);
    const anim = panel.animate(
      [
        { height: `${o.from}px`, marginTop: `${o.fromMargin}px`, opacity: o.fromOpacity },
        { height: `${o.to}px`, marginTop: `${state.margin}px`, opacity: 1 }
      ],
      { duration: o.duration, easing: EASE_OPEN }
    );
    panelAnims.set(panel, anim);
    state.target = o.to;
    anim.onfinish = () => {
      if (panelAnims.get(panel) !== anim) return;
      panelAnims.delete(panel);
      panel.classList.remove("is-entering");
      state.last = naturalHeight(panel);
      if (o.opening) revealPanel(panel);
    };
  }

  // Runs (before paint) after ANY change inside the panel.
  function onPanelChange(panel) {
    if (panel.hidden || panel.classList.contains("is-leaving")) return;
    const state = stateOf(panel);
    const to = naturalHeight(panel);
    if (!motionAllowed()) { state.last = to; return; }

    const running = panelAnims.get(panel);
    if (running) {
      // Content changed while it was still opening/resizing: continue smoothly from where it is now.
      if (Math.abs(to - state.target) < 1) return;
      const style = getComputedStyle(panel);
      const from = panel.getBoundingClientRect().height;
      const opacity = parseFloat(style.opacity);
      const margin = parseFloat(style.marginTop) || 0;
      const opening = panel.classList.contains("is-entering");
      panelAnims.delete(panel);
      running.cancel();
      growPanel(panel, {
        from, to, fromOpacity: Number.isFinite(opacity) ? opacity : 1, fromMargin: margin,
        duration: opening ? OPEN_MS * 0.7 : RESIZE_MS, opening
      });
      return;
    }
    const from = state.last;
    if (!from || Math.abs(to - from) < 1) { state.last = to; return; }
    state.margin = parseFloat(getComputedStyle(panel).marginTop) || 0;
    growPanel(panel, { from, to, fromOpacity: 1, fromMargin: state.margin, duration: RESIZE_MS, opening: false });
  }

  function openPanel(panel) {
    cancelPanelAnim(panel);
    const state = stateOf(panel);
    const to = naturalHeight(panel);
    state.margin = parseFloat(getComputedStyle(panel).marginTop) || 0;
    if (!motionAllowed()) { state.last = to; return; }
    panel.classList.add("is-entering");
    growPanel(panel, { from: 0, to, fromOpacity: 0, fromMargin: 0, duration: OPEN_MS, opening: true });
  }

  function closePanel(panel, done) {
    if (panel.hidden) { if (done) done(); return; }
    // Measure BEFORE cancelling, so closing during another animation starts from what is on screen.
    const style = getComputedStyle(panel);
    const height = panel.getBoundingClientRect().height;
    const margin = parseFloat(style.marginTop) || 0;
    const opacity = parseFloat(style.opacity);
    cancelPanelAnim(panel);
    const finishClose = () => { panel.hidden = true; if (done) done(); };
    if (!motionAllowed()) { finishClose(); return; }
    panel.classList.add("is-leaving");
    const anim = panel.animate(
      [
        { height: `${height}px`, marginTop: `${margin}px`, opacity: Number.isFinite(opacity) ? opacity : 1 },
        { height: "0px", marginTop: "0px", opacity: 0 }
      ],
      { duration: CLOSE_MS, easing: EASE_CLOSE, fill: "forwards" }
    );
    panelAnims.set(panel, anim);
    anim.onfinish = () => {
      if (panelAnims.get(panel) !== anim) return;
      panelAnims.delete(panel);
      finishClose();
      anim.cancel();
      panel.classList.remove("is-leaving");
    };
  }

  async function runCode(code, execLanguage, button, panel) {
    if (!code.trim() || button.disabled) return;

    const previousStop = liveStops.get(panel);
    if (previousStop) previousStop();
    activeCompilerPanel = panel;

    button.disabled = true;
    stateOf(panel);                          // starts watching the panel for size changes
    const wasHidden = panel.hidden;          // only a panel that was closed animates open
    cancelPanelAnim(panel);
    panel.hidden = false;
    panel.classList.remove("has-error");
    panel.classList.add("is-terminal");
    panel.textContent = "";

    // Control bar: always visible at the top of the terminal, so Rerun / Close never need a scroll up.
    const bar = makeEl("div", "term-bar");
    const barTitle = makeEl("span", "term-title");
    barTitle.append(makeEl("span", "term-title-text", `Terminal${execLanguage ? " · " + execLanguage : ""}`));
    const barState = makeEl("span", "term-state", "Running");
    barState.setAttribute("role", "status");
    const barActions = makeEl("div", "term-bar-actions");
    function barButton(className, label, iconId, text) {
      const b = makeEl("button", `term-btn ${className}`);
      b.type = "button";
      b.title = label;
      b.setAttribute("aria-label", label);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "icon");
      svg.setAttribute("aria-hidden", "true");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", iconId);
      svg.append(use);
      b.append(svg, makeEl("span", "term-btn-text", text));
      return b;
    }
    const rerunButton = barButton("term-rerun", "Run again (Alt+Shift+Enter)", "#i-play", "Rerun");
    rerunButton.querySelector(".icon").remove();
    const rerunShortcut = makeEl("span", "term-rerun-shortcut");
    rerunShortcut.setAttribute("aria-hidden", "true");
    ["Alt", "⇧", "↵"].forEach((key) => rerunShortcut.append(makeEl("kbd", "term-rerun-key", key)));
    rerunButton.insertBefore(rerunShortcut, rerunButton.firstChild);
    const closeButton = barButton("term-close", "Close terminal (Esc)", "#i-close", "Close");
    closeButton.querySelector(".icon").remove();
    const closeShortcut = makeEl("kbd", "term-esc-hint", "Esc");
    closeShortcut.setAttribute("aria-hidden", "true");
    closeButton.insertBefore(closeShortcut, closeButton.firstChild);
    barActions.append(rerunButton, closeButton);
    bar.append(barTitle, barState, barActions);

    const screen = makeEl("pre", "term-screen");
    const row = makeEl("form", "term-row");
    row.hidden = true;
    const caret = makeEl("span", "term-caret", "›");
    const label = makeEl("span", "term-label");          // names the variable being asked for
    label.hidden = true;
    const input = makeEl("input", "term-input");
    input.type = "text";
    input.placeholder = "Type the value, press Enter";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", "Program input");
    const sendButton = makeEl("button", "term-send", "Send");
    sendButton.type = "submit";
    // For programs that read until end of input (while (cin >> x), hasNext(), ...).
    const endButton = makeEl("button", "term-stop", "End input");
    endButton.type = "button";
    endButton.title = "No more input (Ctrl+D)";
    endButton.hidden = true;
    const status = makeEl("span", "term-status");
    status.setAttribute("aria-live", "polite");
    const stopButton = makeEl("button", "term-stop", "Stop");
    stopButton.type = "button";
    row.append(caret, label, input, sendButton, endButton, status, stopButton);

    function setBusy(text) {
      row.classList.add("is-idle");
      label.hidden = true;
      endButton.hidden = true;
      status.textContent = text || "Running…";
      if (typeof setState === "function") setState((text || "Running").replace("…", ""), "busy");
    }
    setBusy("Compiling…");
    panel.append(bar, screen, row);

    function setState(text, kind) {
      barState.textContent = text;
      barState.className = `term-state${kind ? " is-" + kind : ""}`;
    }
    setState("Compiling", "busy");
    closeButton.addEventListener("click", () => {
      const stop = liveStops.get(panel);
      if (stop) stop();
      closeButton.disabled = true;           // no double clicks while it collapses
      rerunButton.disabled = true;
      button.disabled = false;
      refreshButtons();
      button.focus({ preventScroll: true });
      closePanel(panel, () => {
        panel.textContent = "";
        panel.classList.remove("has-error", "is-terminal");
      });
    });
    rerunButton.addEventListener("click", () => runCode(code, execLanguage, button, panel));

    function showText(text) {
      screen.textContent = text;
      screen.scrollTop = screen.scrollHeight;
    }

    if (!execLanguage) {
      panel.classList.add("has-error");
      showText("This language can't be compiled and run here. Only C, C++, Python and Java are supported.");
      setState("Unsupported", "error");
      rerunButton.hidden = true;
      row.hidden = true;
      button.disabled = false;
      if (wasHidden) openPanel(panel);
      return;
    }

    const answers = [];        // [{label, value, line, at}] everything typed so far, in order
    let pending = null;        // the question currently shown
    let lastStdout = "";
    let controller = null;     // request in flight, so Stop can cancel it
    let finished = false;

    function finish(text, isError, stopped) {
      if (finished) return;
      finished = true;
      if (controller) controller.abort();
      if (typeof text === "string") showText(text);
      if (isError) panel.classList.add("has-error");
      setState(stopped ? "Stopped" : isError ? "Failed" : "Finished", stopped ? "stopped" : isError ? "error" : "done");
      row.hidden = true;
      button.disabled = false;
      refreshButtons();
      liveStops.delete(panel);
    }
    function stopRun() {
      if (finished) return;
      finish(withAnswers(lastStdout, answers) + "\n[stopped]", false, true);
    }
    liveStops.set(panel, stopRun);
    stopButton.addEventListener("click", stopRun);

    // The program is waiting for the user: glide the page to the input row and pulse it, so it is
    // obvious that this is where to type. It waits until the panel has finished growing, otherwise
    // the scroll would aim at a spot that is still moving.
    function bringInputIntoView() {
      row.classList.remove("is-attention");
      void row.offsetWidth;                                  // restart the pulse if it is already running
      row.classList.add("is-attention");
      setTimeout(() => row.classList.remove("is-attention"), 1500);
      const started = performance.now();
      (function settle() {
        if (finished || !pending) return;
        if (panelAnims.get(panel) && performance.now() - started < 900) { requestAnimationFrame(settle); return; }
        const header = document.querySelector(".topbar");
        const top = (header ? header.getBoundingClientRect().bottom : 0) + 24;
        const rect = row.getBoundingClientRect();
        const comfortable = rect.top >= top && rect.bottom <= window.innerHeight - 24;
        if (!comfortable) row.scrollIntoView({ block: "center", behavior: motionAllowed() ? "smooth" : "auto" });
      })();
    }

    function askFor(data) {
      const request = data.input_request;
      const previousAt = answers.length ? answers[answers.length - 1].at : 0;
      const question = freshPrompt(data.stdout || "", previousAt);
      pending = {
        label: request.var || question || `input ${answers.length + 1}`,
        line: request.line || 0,
        at: Number.isInteger(data.stdout_units) ? data.stdout_units : (data.stdout || "").length
      };
      lastStdout = data.stdout || "";
      showText(withAnswers(lastStdout, answers));
      label.textContent = pending.label;
      label.title = request.line ? `${pending.label}  (line ${request.line})` : pending.label;
      label.hidden = false;
      endButton.hidden = false;
      input.placeholder = request.var ? `Value for ${request.var}` : (question || "Type the value, press Enter");
      input.setAttribute("aria-label", `Input for ${pending.label}`);
      row.classList.remove("is-idle");
      status.textContent = "";
      setState("Waiting for input", "input");
      input.focus({ preventScroll: true });                 // focus without an abrupt jump; we scroll smoothly below
      bringInputIntoView();
    }

    function showFinal(data) {
      let text = withAnswers(data.stdout || "", answers);
      const stderr = data.stderr || "";
      if (stderr) text += (text && !text.endsWith("\n") ? "\n" : "") + stderr;
      if (data.phase === "run" && data.status === "success") {
        text += `${text && !text.endsWith("\n") ? "\n" : ""}\n[process finished with exit code ${data.exit_code}]`;
      }
      finish(text, data.status !== "success");
    }

    // One run of the whole program with every answer so far. No state is kept on the server.
    async function execute(eof) {
      if (finished) return;
      pending = null;
      setBusy(answers.length ? "Running…" : "Compiling…");
      const mine = new AbortController();
      controller = mine;
      try {
        const data = await postExecute({
          code, language: execLanguage,
          inputs: answers.map(({ label: name, value }) => ({ label: name, value })),
          eof: eof === true
        }, mine.signal);
        if (finished || controller !== mine) return;
        if (data.needs_input && data.input_request) askFor(data);
        else showFinal(data);
      } catch (error) {
        if (error.name === "AbortError" || finished) return;
        let message;
        if (error.status === 401) message = "The server asked for a sign-in before running code. Sign-in isn't available in this version, so the /execute route must not require a login.";
        else if (error.status === 429) message = "Too many runs in a short time. Wait a few seconds and try again.";
        else if (error instanceof TypeError) message = "Could not reach the server. Check your connection and try again.";
        else message = error.message || "The compiler failed. Please try again.";
        finish((answers.length ? withAnswers(lastStdout, answers) + "\n" : "") + message, true);
      }
    }

    function sendAnswer(event) {
      event.preventDefault();
      if (finished || !pending) return;
      const value = input.value.replace(/[\r\n]+/g, " ");
      input.value = "";
      answers.push({ label: pending.label, value, line: pending.line, at: pending.at });
      showText(withAnswers(lastStdout, answers));   // the typed value appears at once
      execute(false);
    }
    function endInput() {
      if (finished || !pending) return;
      showText(withAnswers(lastStdout, answers) + "^D\n");
      execute(true);                                // the program now sees end-of-input
    }
    row.addEventListener("submit", sendAnswer);
    endButton.addEventListener("click", endInput);
    input.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.key.toLowerCase() === "d") { event.preventDefault(); endInput(); }
    });

    showText("");
    row.hidden = false;
    if (wasHidden) openPanel(panel);         // measured here, after the panel's content is built
    execute(false);
  }

  $("runSource").addEventListener("click", () => {
    runCode(source.value, executableLanguages[sourceLanguage.value.trim().toLowerCase()] || null, $("runSource"), $("sourceRunOutput"));
  });
  $("runOutput").addEventListener("click", () => {
    // Run the language the translation was made in, even if the dropdown changed since.
    const lang = completedTranslation ? completedTranslation.language : targetLanguage();
    runCode(output.value, executableLanguages[lang.trim().toLowerCase()] || null, $("runOutput"), $("outputRunOutput"));
  });
  output.addEventListener("keydown", (event) => {
    if (isAltEnter(event)) {
      event.preventDefault();
      $("runOutput").click();
    }
  });

  function downloadName(translation) {
    const extension = extensionMap[translation.language.toLowerCase()] || "txt";
    let stem = translation.fileName ? translation.fileName.replace(/\.[^.]+$/, "") : "translated_code";
    stem = stem.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/, "").slice(0, 100) || "translated_code";
    // A Java public class needs a matching filename to compile.
    if (extension === "java") {
      const match = translation.output.match(/\bpublic\s+(?:(?:abstract|final|sealed|non-sealed)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/);
      if (match) stem = match[1];
    }
    return `${stem}.${extension}`;
  }
  $("downloadButton").addEventListener("click", () => {
    if (!completedTranslation) return;
    const blob = new Blob([completedTranslation.output], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = downloadName(completedTranslation);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  function makeIcon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function renderSaved() {
    $("savedCount").textContent = String(saved.length);
    $("savedCount").hidden = saved.length === 0;
    $("savedEmpty").hidden = saved.length !== 0;
    const fragment = document.createDocumentFragment();
    saved.forEach((entry) => {
      const card = element("article", "saved-card");
      const top = element("div", "saved-card-top");
      const date = new Date(entry.createdAt);
      const formattedDate = Number.isNaN(date.getTime()) ? "Saved translation" : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
      top.append(element("span", "saved-language", entry.language), element("span", "saved-date", formattedDate));
      const title = typeof entry.fileName === "string" && entry.fileName ? entry.fileName : entry.source.trim().split("\n")[0].slice(0, 70) || "Untitled translation";
      const actions = element("div", "saved-card-actions");
      const openButton = element("button", "text-button saved-open", "Open translation");
      openButton.type = "button";
      openButton.appendChild(makeIcon("arrow"));
      openButton.addEventListener("click", () => openSaved(entry));
      const deleteButton = element("button", "icon-button delete-saved");
      deleteButton.type = "button";
      deleteButton.setAttribute("aria-label", `Delete saved translation: ${title}`);
      deleteButton.title = "Delete saved translation";
      deleteButton.appendChild(makeIcon("trash"));
      deleteButton.addEventListener("click", () => {
        saved = saved.filter((item) => item.id !== entry.id);
        const persisted = writeStorage(keys.saved, saved);
        renderSaved(); refreshButtons();
        notify(persisted ? "Saved translation removed." : "Removed for this session. Browser storage couldn't be updated.");
      });
      actions.append(openButton, deleteButton);
      card.append(top, element("h2", "", title), element("pre", "saved-preview", entry.output.slice(0, 240)), actions);
      fragment.appendChild(card);
    });
    $("savedList").replaceChildren(fragment);
  }
  function openSaved(entry) {
    if (activeController) { notify("Stop the current translation before opening a saved one."); return; }
    fileReadVersion += 1;
    source.value = entry.source;
    updateSourceRunHint();
    output.value = entry.output;
    sourceFileName = typeof entry.fileName === "string" ? entry.fileName : "";
    const hasOption = (select, value) => Array.from(select.options).some((option) => option.value === value);
    if (typeof entry.sourceLanguage === "string" && hasOption(sourceLanguage, entry.sourceLanguage)) sourceLanguage.value = entry.sourceLanguage;
    updateTargetLanguageOptions();
    language.value = hasOption(language, entry.language) ? entry.language : "Python";
    completedTranslation = { ...entry, fileName: sourceFileName };
    languagesConfirmed = true;
    source.scrollTop = 0; output.scrollTop = 0;
    languageChanged(); updateFileLabel();
    updateLines(source, $("sourceLines")); updateLines(output, $("outputLines"));
    showView("translate");
    setStatus(`Saved ${entry.language} translation opened.`);
  }
  $("saveButton").addEventListener("click", () => {
    if (!completedTranslation || activeController) return;
    const duplicate = saved.some((entry) => entry.source === completedTranslation.source &&
      entry.output === completedTranslation.output && entry.language === completedTranslation.language);
    if (duplicate) { notify("This translation is already in Saved."); return; }
    if (saved.length >= 30) { notify("Your 30 saved slots are full. Remove a translation to save another."); return; }
    saved.unshift({ ...completedTranslation, id: window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`, createdAt: new Date().toISOString() });
    const persisted = writeStorage(keys.saved, saved);
    renderSaved(); refreshButtons();
    notify(persisted ? "Translation saved in this browser." : "Saved for this session. Browser storage is unavailable or full.");
  });

  // Retain the original Alt-drag convenience without rendering code as HTML.
  function setDragMode(on) {
    document.body.classList.toggle("drag-mode", on);
    source.draggable = on && Boolean(source.value) && !activeController;
    output.draggable = on && Boolean(output.value);
  }
  document.addEventListener("keydown", (event) => { if (event.key === "Alt") setDragMode(true); });
  document.addEventListener("keyup", (event) => { if (event.key === "Alt") setDragMode(false); });
  window.addEventListener("blur", () => setDragMode(false));
  [source, output].forEach((editor) => {
    editor.addEventListener("dragstart", (event) => {
      if (!document.body.classList.contains("drag-mode")) return;
      event.dataTransfer.setData("text/plain", editor.value);
      event.dataTransfer.effectAllowed = "copy";
    });
  });

  applyPreferences();
  updateSidebar();
  languageChanged();
  renderLanguageChoices();
  renderSaved();
  refreshButtons();
})();

/* Animated page scrollbar: slides in from the right when the page becomes
   scrollable, slides out when it stops. Desktop (mouse) only; touch devices
   keep their native overlay scrollbar. */
(() => {
  "use strict";
  if (!window.matchMedia("(pointer: fine)").matches) return;

  const root = document.documentElement;
  const body = document.body;
  const MIN_THUMB = 64;   // px, keeps the pill long
  const TOLERANCE = 2;    // px of overflow ignored (sub-pixel / dvh rounding)
  const SETTLE = 90;      // ms a new state must stay stable before animating

  const track = document.createElement("div");
  track.className = "page-scrollbar";
  track.setAttribute("aria-hidden", "true");
  const thumb = document.createElement("div");
  thumb.className = "page-scrollbar-thumb";
  track.appendChild(thumb);
  body.appendChild(track);
  root.classList.add("has-custom-scrollbar");

  let shown = false;
  let settleTimer = 0, trailTimer = 0, frame = 0;
  let trackH = 0, thumbH = 0, range = 1;
  let dragging = null;

  // Scrolling locked by CSS (e.g. body.sidebar-open sets overflow: hidden)
  const isLocked = () => [body, root].some((el) => {
    const overflow = getComputedStyle(el).overflowY;
    return overflow === "hidden" || overflow === "clip";
  });

  // Uses layout height (offsetHeight), which ignores transform animations,
  // unlike scrollHeight which grows while content is mid-animation.
  function measure() {
    const viewH = root.clientHeight;
    const docH = Math.max(root.offsetHeight, body.offsetHeight);
    return { viewH, docH, scrollable: !isLocked() && docH - viewH > TOLERANCE };
  }

  function place(m) {
    trackH = track.clientHeight;
    range = Math.max(1, m.docH - m.viewH);
    thumbH = Math.min(trackH, Math.max(MIN_THUMB, (trackH * m.viewH) / m.docH));
    const ratio = Math.min(1, Math.max(0, root.scrollTop / range));
    thumb.style.height = thumbH + "px";
    thumb.style.transform = "translateY(" + ratio * (trackH - thumbH) + "px)";
  }

  function setShown(value) {
    shown = value;
    track.classList.toggle("is-visible", value);   // slide in / out
  }

  function sync() {
    frame = 0;
    const m = measure();
    if (m.scrollable) place(m);                    // keep the thumb live while visible
    if (m.scrollable === shown) {                  // nothing to animate; cancel any pending flip
      clearTimeout(settleTimer);
      settleTimer = 0;
      return;
    }
    if (settleTimer) return;                       // a flip is already waiting to be confirmed
    settleTimer = setTimeout(() => {
      settleTimer = 0;
      const n = measure();                         // confirm the state is still the same
      if (n.scrollable) place(n);
      if (n.scrollable !== shown) setShown(n.scrollable);
    }, SETTLE);
  }

  // Check now (next frame) and again after any animation could have finished
  function kick() {
    if (!frame) frame = requestAnimationFrame(sync);
    clearTimeout(trailTimer);
    trailTimer = setTimeout(sync, 450);
  }

  // Drag the pill
  thumb.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    thumb.setPointerCapture(event.pointerId);
    dragging = { y: event.clientY, top: root.scrollTop };
    track.classList.add("is-dragging");
  });
  thumb.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const free = trackH - thumbH;
    if (free <= 0) return;
    const next = dragging.top + (event.clientY - dragging.y) * (range / free);
    root.scrollTop = Math.min(range, Math.max(0, next));
  });
  const endDrag = (event) => {
    if (!dragging) return;
    dragging = null;
    track.classList.remove("is-dragging");
    try { thumb.releasePointerCapture(event.pointerId); } catch (_) { /* already released */ }
  };
  thumb.addEventListener("pointerup", endDrag);
  thumb.addEventListener("pointercancel", endDrag);

  // Click on the empty track to jump there
  track.addEventListener("pointerdown", (event) => {
    if (event.target !== track) return;
    const free = trackH - thumbH;
    if (free <= 0) return;
    const rect = track.getBoundingClientRect();
    const ratio = (event.clientY - rect.top - thumbH / 2) / free;
    root.scrollTo({ top: Math.min(1, Math.max(0, ratio)) * range, behavior: "smooth" });
  });

  // Everything that can change scrollability or thumb position
  window.addEventListener("scroll", kick, { passive: true });
  window.addEventListener("resize", kick);
  window.addEventListener("load", kick);
  window.addEventListener("pageshow", kick);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
  ["animationend", "animationcancel", "transitionend", "transitioncancel"].forEach((name) => {
    document.addEventListener(name, (event) => {
      if (!track.contains(event.target)) kick();   // ignore the scrollbar's own transitions
    }, true);
  });
  if ("ResizeObserver" in window) {
    const resizeObserver = new ResizeObserver(kick);
    resizeObserver.observe(body);
    resizeObserver.observe(root);
  }
  new MutationObserver(kick).observe(body, {
    attributes: true,
    subtree: true,
    attributeFilter: ["class", "hidden", "style"],
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(kick);

  // Safety net: if anything ever slips through, it self-corrects within a second
  setInterval(sync, 1000);

  kick();
})();

/* Custom themed dropdown for the language selects (Translate from / to).
   The native <select> stays in the DOM as the source of truth, so existing
   code that reads select.value, option.disabled or listens for "change" keeps working. */
(() => {
  "use strict";

  const ICON_SLUGS = {
    "python": "python", "java": "java", "c": "c", "c++": "cplusplus", "cpp": "cplusplus",
    "javascript": "javascript", "js": "javascript", "typescript": "typescript", "ts": "typescript",
    "c#": "csharp", "csharp": "csharp", "go": "go", "golang": "go", "rust": "rust",
    "php": "php", "swift": "swift", "kotlin": "kotlin", "ruby": "ruby", "sql": "mysql",
    "mysql": "mysql", "node": "nodejs", "nodejs": "nodejs", "r": "r", "dart": "dart",
    "scala": "scala", "perl": "perl", "haskell": "haskell", "lua": "lua",
    "html": "html5", "css": "css3", "bash": "bash", "shell": "bash"
  };
  const iconUrl = (value) => {
    const slug = ICON_SLUGS[(value || "").trim().toLowerCase()];
    return slug ? `https://cdn.jsdelivr.net/gh/devicons/devicon/icons/${slug}/${slug}-original.svg` : "";
  };

  const instances = [];
  const closeAll = (except) => instances.forEach((inst) => { if (inst !== except) inst.close(false); });

  document.querySelectorAll(".language-select").forEach(enhance);

  // Click outside or resize closes any open list
  document.addEventListener("pointerdown", (event) => {
    instances.forEach((inst) => { if (!inst.wrap.contains(event.target)) inst.close(false); });
  });
  window.addEventListener("resize", () => closeAll());

  function enhance(wrap) {
    const select = wrap.querySelector("select");
    if (!select) return;

    const menuId = `${select.id || "lang"}Menu`;
    const menu = document.createElement("ul");
    menu.className = "lang-menu";
    menu.id = menuId;
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", select.getAttribute("aria-label") || "Language");
    wrap.appendChild(menu);
    wrap.classList.add("has-menu");

    select.setAttribute("aria-haspopup", "listbox");
    select.setAttribute("aria-expanded", "false");
    select.setAttribute("aria-controls", menuId);

    let items = [];
    let active = -1;
    let isOpen = false;
    let typed = "";
    let typedTimer = 0;

    function build() {
      menu.textContent = "";
      items = [];
      Array.from(select.options).forEach((option) => {
        if (option.disabled || option.hidden) return;   // e.g. the language already chosen as source
        const li = document.createElement("li");
        li.className = "lang-option";
        li.id = `${menuId}-${items.length}`;
        li.setAttribute("role", "option");
        li.dataset.value = option.value;
        li.setAttribute("aria-selected", String(option.value === select.value));

        const url = iconUrl(option.value);
        if (url) {
          const img = new Image();
          img.className = "lang-option-icon";
          img.alt = "";
          img.setAttribute("aria-hidden", "true");
          img.onerror = () => img.remove();
          img.src = url;
          li.appendChild(img);
        }
        const label = document.createElement("span");
        label.className = "lang-option-label";
        label.textContent = option.textContent;
        li.appendChild(label);

        const check = document.createElement("span");
        check.innerHTML = '<svg class="icon lang-check" aria-hidden="true"><use href="#i-check"/></svg>';
        li.appendChild(check.firstChild);

        items.push(li);
        menu.appendChild(li);
      });
    }

    function setActive(index) {
      if (!items.length) return;
      active = Math.max(0, Math.min(items.length - 1, index));
      items.forEach((li, i) => li.classList.toggle("is-active", i === active));
      select.setAttribute("aria-activedescendant", items[active].id);
      items[active].scrollIntoView({ block: "nearest" });
    }

    function open() {
      if (select.disabled || isOpen) return;
      closeAll(inst);
      build();
      if (!items.length) return;
      // Flip upward when there is not enough room below
      const rect = wrap.getBoundingClientRect();
      const need = Math.min(menu.scrollHeight, 320) + 16;
      const below = window.innerHeight - rect.bottom;
      wrap.classList.toggle("opens-up", below < need && rect.top > below);
      isOpen = true;
      wrap.classList.add("is-open");
      select.setAttribute("aria-expanded", "true");
      select.focus({ preventScroll: true });
      const selected = items.findIndex((li) => li.getAttribute("aria-selected") === "true");
      setActive(selected >= 0 ? selected : 0);
    }

    function close(returnFocus = true) {
      if (!isOpen) return;
      isOpen = false;
      wrap.classList.remove("is-open");
      select.setAttribute("aria-expanded", "false");
      select.removeAttribute("aria-activedescendant");
      if (returnFocus) select.focus({ preventScroll: true });
    }

    function choose(index) {
      const li = items[index];
      if (!li) return;
      const changed = select.value !== li.dataset.value;
      select.value = li.dataset.value;
      close();
      if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Mouse / touch
    wrap.addEventListener("click", (event) => {
      const li = event.target.closest(".lang-option");
      if (li && menu.contains(li)) { choose(items.indexOf(li)); return; }
      if (menu.contains(event.target)) return;
      isOpen ? close() : open();
    });
    menu.addEventListener("pointermove", (event) => {
      const li = event.target.closest(".lang-option");
      if (li) { const i = items.indexOf(li); if (i !== active) setActive(i); }
    });

    // Keyboard (the select keeps focus, so Tab order and labels are unchanged)
    select.addEventListener("keydown", (event) => {
      const key = event.key;
      if (!isOpen) {
        if (["ArrowDown", "ArrowUp", "Enter", " ", "F4"].includes(key)) {
          event.preventDefault();
          open();
        }
        return;
      }
      if (key === "ArrowDown") { event.preventDefault(); setActive(active + 1); }
      else if (key === "ArrowUp") { event.preventDefault(); setActive(active - 1); }
      else if (key === "Home") { event.preventDefault(); setActive(0); }
      else if (key === "End") { event.preventDefault(); setActive(items.length - 1); }
      else if (key === "Enter" || key === " ") { event.preventDefault(); choose(active); }
      else if (key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      else if (key === "Tab") { close(false); }
      else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        typed += key.toLowerCase();
        clearTimeout(typedTimer);
        typedTimer = setTimeout(() => { typed = ""; }, 600);
        const hit = items.findIndex((li) => li.textContent.trim().toLowerCase().startsWith(typed));
        if (hit >= 0) setActive(hit);
      }
    });
        // Pressing an option must not blur the select. Blurring closes the list
    // before the click lands, so the choice would never register.
    let pressingMenu = false;
    menu.addEventListener("pointerdown", () => { pressingMenu = true; });
    menu.addEventListener("mousedown", (event) => event.preventDefault());   // keep focus on the select
    const releaseMenu = () => { setTimeout(() => { pressingMenu = false; }, 0); };
    document.addEventListener("pointerup", releaseMenu);
    document.addEventListener("pointercancel", releaseMenu);
    select.addEventListener("blur", () => { if (!pressingMenu) close(false); });

    // Close if the select gets disabled (e.g. while a translation is running)
    new MutationObserver(() => { if (select.disabled) close(false); })
      .observe(select, { attributes: true, attributeFilter: ["disabled"] });

    const inst = { wrap, close };
    instances.push(inst);
  }
})();