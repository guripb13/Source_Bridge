/* Source Bridge frontend. The Python backend is unchanged.
 * /send receives multipart form fields named message and language, then
 * streams plain text. Uploaded files are read locally into the source editor.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const form = $("form");
  const source = $("message");
  const output = $("translatedCode");
  const language = $("language");
  const customLanguage = $("customLanguage");
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
  let fileReadVersion = 0;

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
    $("sidebarBackdrop").hidden = !(mobile && mobileOpen);
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

  function applyPreferences() {
    const dark = preferences.theme === "dark" || (preferences.theme === "system" && darkQuery.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.setProperty("--code-size", `${preferences.fontSize}px`);
    document.documentElement.style.setProperty("--code-line", `${Math.round(preferences.fontSize * 1.73)}px`);
    document.body.classList.toggle("hide-line-numbers", !preferences.lineNumbers);
    $("themeIcon").setAttribute("href", dark ? "#i-sun" : "#i-moon");
    const label = `Switch to ${dark ? "light" : "dark"} mode`;
    $("themeToggle").setAttribute("aria-label", label);
    $("themeToggle").title = label;
    $("themeSetting").value = preferences.theme;
    $("fontSizeSetting").value = String(preferences.fontSize);
    $("lineNumbersSetting").checked = preferences.lineNumbers;
    syncScroll(source, $("sourceLines"));
    syncScroll(output, $("outputLines"));
  }
  function savePreferences() { applyPreferences(); writeStorage(keys.preferences, preferences); }
  $("themeToggle").addEventListener("click", () => {
    preferences.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    savePreferences();
  });
  $("themeSetting").addEventListener("change", (event) => { preferences.theme = event.target.value; savePreferences(); });
  $("fontSizeSetting").addEventListener("change", (event) => { preferences.fontSize = Number(event.target.value); savePreferences(); });
  $("lineNumbersSetting").addEventListener("change", (event) => { preferences.lineNumbers = event.target.checked; savePreferences(); });
  darkQuery.addEventListener("change", () => { if (preferences.theme === "system") applyPreferences(); });

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

  function showView(view) {
    $("translateView").hidden = view !== "translate";
    $("savedView").hidden = view !== "saved";
    [$("translateNav"), $("savedNav")].forEach((button) => {
      const current = button.dataset.view === view;
      button.classList.toggle("active", current);
      if (current) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    if (view === "saved") renderSaved();
    if (mobileOpen) closeSidebar();
    $("mainContent").focus({ preventScroll: true });
  }
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.view));
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

  function targetLanguage() { return language.value === "other" ? customLanguage.value.trim() : language.value; }
  function refreshButtons() {
    const loading = Boolean(activeController);
    translateButton.disabled = !loading && (!source.value.trim() || !targetLanguage());
    $("copySource").disabled = !source.value;
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
    customLanguage.disabled = loading;
    $("uploadButton").disabled = loading;
    $("attachment").disabled = loading;
    $("translateLabel").textContent = loading ? "Stop" : "Translate";
    translateButton.setAttribute("aria-label", loading ? "Stop translation" : "Translate code");
    refreshButtons();
  }
  function languageChanged(focusCustom = false) {
    const other = language.value === "other";
    $("customLanguageRow").hidden = !other;
    setLanguageIcon(targetLanguage());
    if (other && focusCustom) customLanguage.focus();
    refreshButtons();
  }
  const LANGUAGE_ICON_SLUGS = {
  "python": "python", "java": "java", "c": "c", "c++": "cplusplus", "cpp": "cplusplus",
  "javascript": "javascript", "js": "javascript", "typescript": "typescript", "ts": "typescript",
  "c#": "csharp", "csharp": "csharp", "go": "go", "golang": "go", "rust": "rust",
  "php": "php", "swift": "swift", "kotlin": "kotlin", "ruby": "ruby", "sql": "mysql",
  "mysql": "mysql", "node": "nodejs", "nodejs": "nodejs", "r": "r", "dart": "dart",
  "scala": "scala", "perl": "perl", "haskell": "haskell", "lua": "lua",
  "html": "html5", "css": "css3", "bash": "bash", "shell": "bash",
  "matlab": "matlab", "objective-c": "objectivec", "objectivec": "objectivec"
};

function setLanguageIcon(langValue) {
  const icon = $("languageIcon");
  const key = (langValue || "").trim().toLowerCase();
  const slug = LANGUAGE_ICON_SLUGS[key];

  // Unknown language: hide the icon
  if (!slug) {
    icon.removeAttribute("src");
    icon.style.display = "none";
    return;
  }

  const url = `https://cdn.jsdelivr.net/gh/devicons/devicon/icons/${slug}/${slug}-original.svg`;

  icon.src = "";
  icon.onload = () => { icon.style.display = ""; };
  icon.onerror = () => { icon.style.display = "none"; };   // hide if the CDN fails
  icon.alt = `${langValue} logo`;
  requestAnimationFrame(() => { icon.src = url; });
}

// Triggered when the dropdown changes
language.addEventListener("change", () => languageChanged(true));
  customLanguage.addEventListener("input", () => {
    setLanguageIcon(customLanguage.value.trim());
    refreshButtons();
  });
  customLanguage.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) { event.preventDefault(); source.focus(); }
  });
  source.addEventListener("input", () => {
    fileReadVersion += 1;
    updateLines(source, $("sourceLines"));
    refreshButtons();
    if (completedTranslation) setStatus("Source updated. Translate again to refresh the result.");
    else setStatus("");
  });
  source.addEventListener("keydown", (event) => {
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
    if (!target) { setStatus("Enter a target programming language.", true); customLanguage.focus(); return; }

    // Keep the same form field names and the same streaming endpoint as server.py.
    const originalSource = source.value;
    const originalFileName = sourceFileName;
    const data = new FormData();
    data.append("message", originalSource);
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
      const response = await fetch(form.action, { method: "POST", body: data, signal: controller.signal });
      if (!response.ok) throw new Error(`Translation failed (${response.status}). Please try again.`);
      if (response.headers.get("content-type")?.includes("text/html")) throw new Error("The server returned a page instead of code. Please try again.");
      if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            appendOutput(decoder.decode(value, { stream: true }));
          }
          appendOutput(decoder.decode());
        } finally { reader.releaseLock(); }
      } else { appendOutput(await response.text()); }
      if (controller.signal.aborted) throw new DOMException("Translation stopped", "AbortError");
      // Existing server.py returns upstream errors as plain text with HTTP 200.
      if (/^\s*Error:\s*/i.test(output.value)) throw new Error(output.value.trim());
      if (!output.value.trim()) throw new Error("No code was returned. Please try translating again.");
      completedTranslation = { source: originalSource, output: output.value, language: target, fileName: originalFileName };
      setStatus(`Translated to ${target}. Ready to copy, save, or download.`);
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
    output.value = entry.output;
    sourceFileName = typeof entry.fileName === "string" ? entry.fileName : "";
    const known = Array.from(language.options).some((option) => option.value === entry.language && option.value !== "other");
    language.value = known ? entry.language : "other";
    customLanguage.value = known ? "" : entry.language;
    completedTranslation = { ...entry, fileName: sourceFileName };
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
  renderSaved();
  refreshButtons();
})();
