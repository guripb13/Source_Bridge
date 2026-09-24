/* Source Bridge frontend.
 * /send keeps its message/language form fields. This client opts into NDJSON
 * events so the final event can identify the committed translation exactly.
 * Account records come from Flask; browser-only bookmarks remain separate.
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
    sidebar: "sourceBridge.sidebarCollapsed",
    accountSignal: "sourceBridge.accountChanged.v1"
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
  const endpoints = {
    me: document.body.dataset.meUrl,
    history: document.body.dataset.historyUrl,
    saved: document.body.dataset.savedUrl,
    save: document.body.dataset.saveUrl,
    logout: document.body.dataset.logoutUrl
  };
  let currentUser = null;
  let sessionState = "checking";
  let sessionEpoch = 0;
  let sessionCheckVersion = 0;
  let authPending = false;
  let currentView = "translate";
  let savedScope = "browser";
  const pendingBookmarks = new Set();
  const collections = { history: newCollection(), saved: newCollection() };

  function newCollection() {
    return { items: [], page: 1, pages: 0, total: 0, loading: false, loaded: false, error: "", request: 0 };
  }

  // Cookies stay with the same Flask origin. Passwords and login flags are never
  // stored in localStorage; /me is the source of the current account identity.
  async function apiJSON(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin", cache: "no-store", ...options,
      headers: { Accept: "application/json", ...options.headers }
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
  function postJSON(url, data) {
    return apiJSON(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  }
  function errorText(error) {
    return error instanceof TypeError ? "Could not reach the server. Check your connection and try again." : error.message || "Please try again.";
  }
  function signalAccountChange() { writeStorage(keys.accountSignal, `${Date.now()}-${Math.random()}`); }
  function updateAccountUI() {
    $("accountButtonLabel").textContent = currentUser ? currentUser.name : "Sign In";
    $("accountButton").dataset.dialog = currentUser ? "accountDialog" : "signInDialog";
    $("accountButton").setAttribute("aria-label", currentUser ? `Account: ${currentUser.name}` : "Sign in");
    $("accountButton").title = currentUser ? `Signed in as ${currentUser.name}` : "Sign in";
    $("accountName").textContent = currentUser?.name || "";
    $("accountEmail").textContent = currentUser?.email || "";
  }
  function applySession(user) {
    const changed = (currentUser?.id ?? null) !== (user?.id ?? null);
    const previousUser = currentUser;
    sessionState = "ready";
    currentUser = user;
    if (changed) {
      sessionEpoch += 1;
      if (activeController) activeController.abort();
      for (const name of ["history", "saved"]) {
        const oldVersion = collections[name].request;
        collections[name] = { ...newCollection(), request: oldVersion + 1 };
      }
      pendingBookmarks.clear();
      savedScope = currentUser ? "account" : "browser";
      // Clear account code on logout/account switch, including a partial stream.
      if (previousUser || completedTranslation?.userId != null) {
        fileReadVersion += 1;
        source.value = ""; output.value = ""; sourceFileName = ""; completedTranslation = null;
        updateFileLabel(); updateLines(source, $("sourceLines")); updateLines(output, $("outputLines"));
        setStatus("");
      }
      $("accountDialog").close();
    }
    updateAccountUI(); renderSaved(); renderHistory(); refreshButtons();
  }
  async function checkSession() {
    const version = ++sessionCheckVersion;
    try {
      const data = await apiJSON(endpoints.me);
      if (version !== sessionCheckVersion) return false;
      if (typeof data.authenticated !== "boolean" || (data.authenticated && !Number.isInteger(data.user?.id))) {
        throw new Error("Could not read your account details. Please try again.");
      }
      applySession(data.authenticated ? data.user : null);
      if (currentUser) {
        void loadCollection("saved", collections.saved.page);
        if (currentView === "history") void loadCollection("history", collections.history.page);
      }
      return true;
    } catch (error) {
      if (version !== sessionCheckVersion) return false;
      sessionState = "unavailable";
      renderSaved(); renderHistory(); refreshButtons();
      if (currentView === "translate") setStatus("Could not check your account. Select Sign In to retry.", true);
      return false;
    }
  }
  function sessionExpired() {
    sessionCheckVersion += 1;
    applySession(null);
    notify("Your session has ended. Sign in again to access your account.");
  }
  function setAuthMode(register) {
    $("loginForm").hidden = register;
    $("registerForm").hidden = !register;
    $("showLogin").setAttribute("aria-pressed", String(!register));
    $("showRegister").setAttribute("aria-pressed", String(register));
    $("authError").hidden = true; $("authStatus").textContent = "";
  }
  function setAuthBusy(busy) {
    authPending = busy;
    for (const id of ["loginEmail", "loginPassword", "registerName", "registerEmail", "registerPassword", "loginSubmit", "registerSubmit", "showLogin", "showRegister", "logoutButton"]) $(id).disabled = busy;
    $("loginForm").setAttribute("aria-busy", String(busy));
    $("registerForm").setAttribute("aria-busy", String(busy));
    refreshButtons(); renderSaved(); renderHistory();
  }
  function showAuthError(message) { $("authError").textContent = message; $("authError").hidden = false; }
  $("showLogin").addEventListener("click", () => { if (!authPending) { setAuthMode(false); $("loginEmail").focus(); } });
  $("showRegister").addEventListener("click", () => { if (!authPending) { setAuthMode(true); $("registerName").focus(); } });
  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (authPending || activeController || !$("loginForm").reportValidity()) return;
    const data = { email: $("loginEmail").value.trim(), password: $("loginPassword").value };
    sessionCheckVersion += 1;
    $("authError").hidden = true; $("authStatus").textContent = "Signing in…";
    setAuthBusy(true);
    try {
      await postJSON($("loginForm").action, data);
      signalAccountChange();
      if (!(await checkSession()) || !currentUser) throw new Error("Sign-in completed, but your account could not be loaded. Close this dialog and select Sign In to retry.");
      $("loginPassword").value = "";
      $("signInDialog").close();
      notify(`Signed in as ${currentUser.name}.`);
    } catch (error) { showAuthError(errorText(error)); }
    finally { $("authStatus").textContent = ""; setAuthBusy(false); }
  });
  $("registerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (authPending || activeController || !$("registerForm").reportValidity()) return;
    const data = { name: $("registerName").value.trim(), email: $("registerEmail").value.trim(), password: $("registerPassword").value };
    if (!data.name || !data.password.trim()) { showAuthError("Enter your name and a password that is not blank."); return; }
    $("authError").hidden = true; $("authStatus").textContent = "Creating your account…";
    setAuthBusy(true);
    try {
      await postJSON($("registerForm").action, data);
      $("registerPassword").value = "";
      $("loginEmail").value = data.email;
      setAuthMode(false);
      $("authStatus").textContent = "Account created. Sign in with your email and password.";
    } catch (error) { $("authStatus").textContent = ""; showAuthError(errorText(error)); }
    finally { setAuthBusy(false); }
  });
  $("logoutButton").addEventListener("click", async () => {
    if (authPending || activeController) return;
    $("accountError").hidden = true;
    sessionCheckVersion += 1;
    setAuthBusy(true);
    try {
      await postJSON(endpoints.logout, {});
      applySession(null); signalAccountChange(); $("accountDialog").close();
      notify("Signed out successfully.");
    } catch (error) { $("accountError").textContent = errorText(error); $("accountError").hidden = false; }
    finally { setAuthBusy(false); }
  });

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
    button.addEventListener("click", async () => {
      const accountAction = ["signInDialog", "accountDialog"].includes(button.dataset.dialog);
      if (accountAction && (activeController || authPending)) { notify("Finish or stop the current action first."); return; }
      if (accountAction && sessionState !== "ready") await checkSession();
      if (mobileOpen) closeSidebar(true);
      const dialogId = accountAction && currentUser ? "accountDialog" : button.dataset.dialog;
      $(dialogId).showModal();
    });
  });
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => {
      const dialog = button.closest("dialog");
      if (authPending && ["signInDialog", "accountDialog"].includes(dialog.id)) return;
      dialog.close();
    });
  });
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (authPending && ["signInDialog", "accountDialog"].includes(dialog.id)) return;
      const rect = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
    });
    dialog.addEventListener("cancel", (event) => {
      if (authPending && ["signInDialog", "accountDialog"].includes(dialog.id)) event.preventDefault();
    });
  });
  $("signInDialog").addEventListener("close", () => {
    $("loginPassword").value = ""; $("registerPassword").value = "";
    $("authError").hidden = true; $("authStatus").textContent = "";
  });

  function showView(view) {
    if (!["translate", "saved", "history"].includes(view)) return;
    currentView = view;
    $("translateView").hidden = view !== "translate";
    $("savedView").hidden = view !== "saved";
    $("historyView").hidden = view !== "history";
    [$("translateNav"), $("savedNav"), $("historyNav")].forEach((button) => {
      const current = button.dataset.view === view;
      button.classList.toggle("active", current);
      if (current) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    if (view === "saved") {
      renderSaved();
      if (currentUser && savedScope === "account") void loadCollection("saved", collections.saved.page);
    }
    if (view === "history") {
      renderHistory();
      if (currentUser) void loadCollection("history", collections.history.page);
    }
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
    translateButton.disabled = !loading && (!source.value.trim() || !targetLanguage() || authPending || sessionState === "checking");
    $("copySource").disabled = !source.value;
    $("copyOutput").disabled = !output.value;
    $("downloadButton").disabled = !completedTranslation || loading;
    const accountEntry = completedTranslation?.storage === "account";
    const canSave = !accountEntry || (completedTranslation.userId === currentUser?.id && Number.isInteger(completedTranslation.id));
    $("saveButton").disabled = !completedTranslation || loading || authPending || sessionState !== "ready" || !canSave ||
      (accountEntry && pendingBookmarks.has(bookmarkKey(completedTranslation)));
    const alreadySaved = completedTranslation && (accountEntry ? completedTranslation.isSaved : saved.some((entry) => entry.source === completedTranslation.source &&
      entry.output === completedTranslation.output && entry.language === completedTranslation.language));
    $("saveButton").classList.toggle("is-saved", Boolean(alreadySaved));
    $("saveButton").setAttribute("aria-pressed", String(Boolean(alreadySaved)));
    $("saveButton").title = accountEntry ? (alreadySaved ? "Remove from Saved in your account" : "Save translation to your account") :
      (alreadySaved ? "Translation saved in this browser" : "Save translation in this browser");
    $("saveButton").setAttribute("aria-label", $("saveButton").title);
    $("accountButton").disabled = loading || authPending;
    $("logoutButton").disabled = loading || authPending;
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
    $("languageIcon").setAttribute("href", language.value === "Python" ? "#i-python" : "#i-code");
    if (other && focusCustom) customLanguage.focus();
    refreshButtons();
  }
  language.addEventListener("change", () => languageChanged(true));
  customLanguage.addEventListener("input", refreshButtons);
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
    if (authPending) return;
    if (sessionState !== "ready" && !(await checkSession())) {
      setStatus("Could not check your account. Select Sign In to retry before translating.", true); return;
    }
    if (activeController || authPending) return;
    if (!source.value.trim()) { setStatus("Paste or upload some code first.", true); source.focus(); return; }
    const target = targetLanguage();
    if (!target) { setStatus("Enter a target programming language.", true); customLanguage.focus(); return; }

    // Keep the same form field names and the same streaming endpoint as server.py.
    const originalSource = source.value;
    const originalFileName = sourceFileName;
    const originalUserId = currentUser?.id ?? null;
    const originalEpoch = sessionEpoch;
    fileReadVersion += 1;
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
      const response = await fetch(form.action, {
        method: "POST", body: data, signal: controller.signal, credentials: "same-origin",
        headers: { Accept: "application/x-ndjson" }
      });
      if (!response.ok) throw new Error(`Translation failed (${response.status}). Please try again.`);
      if (response.headers.get("content-type")?.includes("text/html")) throw new Error("The server returned a page instead of code. Please try again.");
      const events = response.headers.get("content-type")?.includes("application/x-ndjson");
      let pendingText = "";
      let completion = null;
      function consumeLine(line) {
        if (!line.trim()) return;
        let item;
        try { item = JSON.parse(line); }
        catch (_) { throw new Error("The translation stream was interrupted. Please try again."); }
        if (completion) throw new Error("The server sent an unexpected translation response. Please try again.");
        if (item.type === "chunk" && typeof item.text === "string") appendOutput(item.text);
        else if (item.type === "error") throw new Error(item.message || "Translation failed. Please try again.");
        else if (item.type === "complete" && typeof item.persisted === "boolean" &&
          (item.user_id === null || Number.isInteger(item.user_id)) &&
          (!item.persisted || (Number.isInteger(item.translation_id) && item.translation_id > 0))) completion = item;
        else throw new Error("The server sent an unexpected translation response. Please try again.");
      }
      function consumeText(text) {
        if (originalEpoch !== sessionEpoch || controller.signal.aborted) throw new DOMException("Translation stopped", "AbortError");
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
          try { await reader.cancel(); } catch (_) { /* Already aborted or closed. */ }
          throw error;
        } finally { reader.releaseLock(); }
      } else { consumeText(await response.text()); }
      if (events) {
        if (pendingText.trim()) consumeLine(pendingText);
        if (!completion) throw new Error("The translation stopped before completion. Please try again.");
      }
      if (controller.signal.aborted) throw new DOMException("Translation stopped", "AbortError");
      // Existing server.py returns upstream errors as plain text with HTTP 200.
      if (/^\s*Error:\s*/i.test(output.value)) throw new Error(output.value.trim());
      if (!output.value.trim()) throw new Error("No code was returned. Please try translating again.");
      const ownerId = completion ? completion.user_id : originalUserId;
      if (originalEpoch !== sessionEpoch || ownerId !== (currentUser?.id ?? null)) {
        output.value = "";
        await checkSession();
        setStatus("Your account changed during translation. Please translate again.", true);
        return;
      }
      completedTranslation = {
        source: originalSource, output: output.value, language: target, fileName: originalFileName,
        storage: ownerId === null ? "browser" : "account", userId: ownerId,
        id: completion?.persisted ? completion.translation_id : null,
        isSaved: completion?.is_saved === true, createdAt: completion?.created_at || new Date().toISOString()
      };
      if (ownerId !== null && !completion?.persisted) {
        setStatus("Translation finished, but it could not be linked to your history. You can still copy or download it.", true);
      } else setStatus(`Translated to ${target}. Ready to copy, save, or download.`);
      if (ownerId !== null && completion?.persisted) {
        collections.history.loaded = false;
        if (currentView === "history") void loadCollection("history", 1);
      }
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
  function bookmarkKey(entry) { return `${sessionEpoch}:${entry.id}`; }
  function normalizeTranslation(item) {
    return {
      id: item.id, userId: item.user_id, source: item.source_code, output: item.translated_code,
      language: item.target_language, isSaved: item.is_saved, createdAt: item.created_at,
      fileName: "", storage: "account"
    };
  }
  async function loadCollection(name, page = 1) {
    if (!currentUser || sessionState !== "ready") { renderSaved(); renderHistory(); return; }
    const state = collections[name];
    const requestVersion = ++state.request;
    const owner = currentUser.id;
    const epoch = sessionEpoch;
    const isCurrent = () => collections[name] === state && state.request === requestVersion &&
      epoch === sessionEpoch && currentUser?.id === owner;
    state.loading = true; state.error = "";
    if (name === "saved") renderSaved(); else renderHistory();
    try {
      const data = await apiJSON(`${endpoints[name]}?page=${Math.max(1, page)}`);
      if (!isCurrent()) return;
      if (!Array.isArray(data.translations) || !Number.isInteger(data.total_pages) || !Number.isInteger(data.total_translations)) {
        throw new Error("Could not read your translations. Please refresh this list.");
      }
      if (data.translations.some((item) => item.user_id !== owner)) {
        await checkSession();
        if (isCurrent()) state.error = "Your account changed. Refresh this list to continue.";
        return;
      }
      // Removing the last bookmark on a page can reduce the number of pages.
      if (data.total_pages > 0 && page > data.total_pages) {
        await loadCollection(name, data.total_pages); return;
      }
      state.items = data.translations.map(normalizeTranslation);
      state.page = data.total_pages === 0 ? 1 : data.page;
      state.pages = data.total_pages; state.total = data.total_translations; state.loaded = true;
    } catch (error) {
      if (!isCurrent()) return;
      if (error.status === 401) { sessionExpired(); return; }
      state.error = errorText(error);
    } finally {
      if (isCurrent()) {
        state.loading = false;
        if (name === "saved") renderSaved(); else renderHistory();
      }
    }
  }
  async function changeBookmark(entry, isSaved) {
    if (!currentUser || sessionState !== "ready" || entry.userId !== currentUser.id || !Number.isInteger(entry.id)) {
      notify("Sign in to the account that owns this translation."); return;
    }
    const key = bookmarkKey(entry);
    if (pendingBookmarks.has(key) || authPending) return;
    const epoch = sessionEpoch;
    const owner = currentUser.id;
    pendingBookmarks.add(key);
    refreshButtons(); renderSaved(); renderHistory();
    try {
      const url = endpoints.save.replace(/\/0\/save$/, `/${entry.id}/save`);
      const result = await postJSON(url, { is_saved: isSaved });
      if (epoch !== sessionEpoch || currentUser?.id !== owner) return;
      if (result.id !== entry.id || typeof result.is_saved !== "boolean") throw new Error("Could not confirm the bookmark. Refresh your Saved list.");
      entry.isSaved = result.is_saved;
      for (const state of Object.values(collections)) {
        state.items.forEach((item) => { if (item.id === entry.id) item.isSaved = result.is_saved; });
        state.loaded = false;
      }
      if (completedTranslation?.storage === "account" && completedTranslation.id === entry.id && completedTranslation.userId === owner) completedTranslation.isSaved = result.is_saved;
      notify(result.is_saved ? "Translation saved to your account." : "Removed from Saved. It is still in your history.");
      signalAccountChange();
      await loadCollection("saved", collections.saved.page);
      if (currentView === "history") await loadCollection("history", collections.history.page);
    } catch (error) {
      if (epoch !== sessionEpoch) return;
      if (error.status === 401) sessionExpired();
      else { notify(errorText(error)); if (error.status === 404) void checkSession(); }
    } finally {
      pendingBookmarks.delete(key);
      refreshButtons(); renderSaved(); renderHistory();
    }
  }
  function createTranslationCard(entry) {
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
    const action = element("button", entry.storage === "account" ? "text-button bookmark-action" : "icon-button delete-saved");
    action.type = "button";
    if (entry.storage === "account") {
      action.textContent = entry.isSaved ? "Unsave" : "Save";
      action.classList.toggle("is-saved", entry.isSaved);
      action.setAttribute("aria-pressed", String(entry.isSaved));
      action.setAttribute("aria-label", `${entry.isSaved ? "Unsave" : "Save"} translation: ${title}`);
      action.appendChild(makeIcon("bookmark"));
      action.disabled = pendingBookmarks.has(bookmarkKey(entry)) || authPending;
      action.addEventListener("click", () => changeBookmark(entry, !entry.isSaved));
    } else {
      action.setAttribute("aria-label", `Delete browser bookmark: ${title}`);
      action.title = "Delete browser bookmark";
      action.appendChild(makeIcon("trash"));
      action.addEventListener("click", () => {
        saved = saved.filter((item) => item.id !== entry.id);
        const persisted = writeStorage(keys.saved, saved);
        renderSaved(); refreshButtons();
        notify(persisted ? "Saved translation removed." : "Removed for this session. Browser storage couldn't be updated.");
      });
    }
    actions.append(openButton, action);
    card.append(top, element("h2", "", title), element("pre", "saved-preview", entry.output.slice(0, 240)), actions);
    return card;
  }
  function renderCollection(name) {
    const state = collections[name];
    const status = $(`${name}Status`);
    const ready = sessionState === "ready";
    const visible = ready && Boolean(currentUser);
    const displayItems = visible && state.loaded && !state.loading && !state.error;
    status.textContent = sessionState === "checking" ? "Checking your account…" :
      sessionState === "unavailable" ? "Could not check your account. Select Refresh to retry." :
      visible ? (state.error || (state.loading || !state.loaded ? "Loading translations…" : `${state.total} translation${state.total === 1 ? "" : "s"}`)) : "";
    status.classList.toggle("is-error", sessionState === "unavailable" || Boolean(state.error));
    $(`${name}SignIn`).hidden = !ready || Boolean(currentUser);
    $(`${name}Empty`).hidden = !displayItems || state.items.length !== 0;
    const fragment = document.createDocumentFragment();
    if (displayItems) state.items.forEach((entry) => fragment.appendChild(createTranslationCard(entry)));
    $(`${name}List`).replaceChildren(fragment);
    $(`${name}List`).setAttribute("aria-busy", String(state.loading));
    $(`${name}Pagination`).hidden = !displayItems || state.pages <= 1;
    $(`${name}PageInfo`).textContent = `Page ${state.page} of ${state.pages}`;
    $(`${name}Previous`).disabled = state.loading || state.page <= 1;
    $(`${name}Next`).disabled = state.loading || state.page >= state.pages;
    $(name === "saved" ? "refreshSaved" : "refreshHistory").disabled = state.loading || sessionState === "checking";
  }
  function renderSaved() {
    const count = currentUser ? collections.saved.total : saved.length;
    $("savedCount").textContent = String(count);
    $("savedCount").hidden = count === 0;
    $("savedAccountTab").setAttribute("aria-pressed", String(savedScope === "account"));
    $("savedBrowserTab").setAttribute("aria-pressed", String(savedScope === "browser"));
    $("savedDescription").textContent = savedScope === "account" ? "Bookmarks kept in your Source Bridge account." : "Code saved in this browser, available on this device.";
    if (savedScope === "account") { renderCollection("saved"); return; }
    $("savedStatus").textContent = currentUser ? "Browser bookmarks are separate from your account bookmarks." : "Sign in to keep new translations in your account, or continue using browser bookmarks.";
    $("savedStatus").classList.remove("is-error");
    $("savedSignIn").hidden = true; $("savedPagination").hidden = true;
    $("savedEmpty").hidden = saved.length !== 0;
    $("refreshSaved").disabled = false;
    $("savedList").setAttribute("aria-busy", "false");
    const fragment = document.createDocumentFragment();
    saved.forEach((entry) => fragment.appendChild(createTranslationCard({ ...entry, storage: "browser", userId: null })));
    $("savedList").replaceChildren(fragment);
  }
  function renderHistory() { renderCollection("history"); }
  function openSaved(entry) {
    if (activeController) { notify("Stop the current translation before opening a saved one."); return; }
    if (entry.storage === "account" && (sessionState !== "ready" || entry.userId !== currentUser?.id)) { notify("Sign in to view this translation."); return; }
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
    setStatus(`${entry.language} translation opened.`);
  }
  $("saveButton").addEventListener("click", async () => {
    if (!completedTranslation || activeController || authPending || sessionState !== "ready") return;
    if (completedTranslation.storage === "account") {
      await changeBookmark(completedTranslation, !completedTranslation.isSaved); return;
    }
    const duplicate = saved.some((entry) => entry.source === completedTranslation.source &&
      entry.output === completedTranslation.output && entry.language === completedTranslation.language);
    if (duplicate) { notify("This translation is already in Saved."); return; }
    if (saved.length >= 30) { notify("Your 30 saved slots are full. Remove a translation to save another."); return; }
    saved.unshift({ ...completedTranslation, id: window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`, createdAt: new Date().toISOString() });
    const persisted = writeStorage(keys.saved, saved);
    renderSaved(); refreshButtons();
    notify(persisted ? "Translation saved in this browser." : "Saved for this session. Browser storage is unavailable or full.");
  });
  $("savedAccountTab").addEventListener("click", () => {
    savedScope = "account"; renderSaved();
    if (currentUser) void loadCollection("saved", 1);
  });
  $("savedBrowserTab").addEventListener("click", () => { savedScope = "browser"; renderSaved(); });
  async function refreshCollection(name) {
    if (sessionState !== "ready") { await checkSession(); return; }
    if (name === "saved" && savedScope === "browser") { renderSaved(); return; }
    await loadCollection(name, collections[name].page);
  }
  $("refreshSaved").addEventListener("click", () => refreshCollection("saved"));
  $("refreshHistory").addEventListener("click", () => refreshCollection("history"));
  for (const name of ["saved", "history"]) {
    $(`${name}Previous`).addEventListener("click", () => loadCollection(name, collections[name].page - 1));
    $(`${name}Next`).addEventListener("click", () => loadCollection(name, collections[name].page + 1));
  }
  window.addEventListener("focus", () => { if (!authPending) void checkSession(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !authPending) void checkSession();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === keys.accountSignal && !authPending) void checkSession();
    if (event.key === keys.saved) {
      const records = readStorage(keys.saved, []);
      if (Array.isArray(records)) saved = records.filter((entry) => entry && typeof entry.id === "string" &&
        typeof entry.source === "string" && typeof entry.output === "string" && typeof entry.language === "string").slice(0, 30);
      renderSaved(); refreshButtons();
    }
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
  renderHistory();
  refreshButtons();
  void checkSession();
})();
