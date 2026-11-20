/* The run terminal: sends code to /execute, shows output, asks for input one value at a time. */
import { $, dom, makeEl } from "../core/dom.js";
import { endpoints, executableLanguages } from "../core/config.js";
import { state } from "../core/state.js";
import { refreshButtons, targetLanguage } from "../ui/buttons.js";
import { runErrorMessage } from "../translate/errors.js";
import { panelAnims, stateOf, cancelPanelAnim, openPanel, closePanel, motionAllowed } from "./panel-animation.js";

const { source, output, sourceLanguage } = dom;

// ---------- RUN WITH LABELLED INPUT (nothing stays running on the server) ----------
//  1. Run sends the WHOLE program to /execute with the answers typed so far (none at first).
//  2. If the program needs more input it stops itself and the server answers "needs_input"
//     with what was printed so far and which variable asks (e.g. "a, b").
//  3. The page shows an input box for that variable; on Send the answer is stored and step 1
//     repeats with the longer list of answers.
//  4. When no more input is needed the final output is shown.
// `at` = the exact spot inside the output where the answer was asked for, so the terminal can
// show every typed answer in the right place (the re-run output has no echo).
export const liveStops = new WeakMap();   // panel -> function that stops its current run
let activeCompilerPanel = null;
const tabGuides = new WeakMap();
const tabGuideSessionKey = "sourceBridge.inputTabGuideShown.v1";
let tabGuideShownThisPage = false;

function isAltEnter(event, shiftKey = false) {
  return event.key === "Enter" && event.shiftKey === shiftKey &&
    (event.altKey || event.getModifierState("AltGraph"));
}

function shouldShowTabGuide() {
  if (tabGuideShownThisPage) return false;
  tabGuideShownThisPage = true;
  try {
    if (sessionStorage.getItem(tabGuideSessionKey)) return false;
    sessionStorage.setItem(tabGuideSessionKey, "true");
  } catch (error) {
    console.warn("Could not persist the compiler input shortcut hint for this session.", error);
  }
  return true;
}

function hideTabGuide(panel, animate = false) {
  const guide = tabGuides.get(panel);
  if (!guide) return;
  clearTimeout(guide.timer);
  cancelAnimationFrame(guide.frame);
  guide.observer?.disconnect();
  window.removeEventListener("resize", guide.update);
  tabGuides.delete(panel);
  if (animate && guide.element.isConnected) {
    guide.element.classList.add("is-leaving");
    setTimeout(() => guide.element.remove(), 220);
  } else {
    guide.element.remove();
  }
}

function showTabGuide(panel, editor) {
  hideTabGuide(panel);
  const card = panel.closest(".editor-card");
  const surface = editor.closest(".editor-card")?.querySelector(".code-surface");
  if (!card || !surface) return;

  const guide = makeEl("div", "term-tab-guide");
  guide.setAttribute("aria-hidden", "true");
  const message = makeEl("span", "term-tab-guide-message");
  message.append(document.createTextNode("Press "));
  message.append(makeEl("kbd", "", "Tab"));
  message.append(document.createTextNode(" to switch between editor and input box"));
  guide.append(message);
  card.append(guide);

  function positionGuide() {
    const surfaceRect = surface.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const middleY = (surfaceRect.bottom + panelRect.top) / 2 - cardRect.top - card.clientTop;
    message.style.top = `${middleY}px`;
  }

  const state = { element: guide, frame: 0, timer: 0, update: null, observer: null };
  state.update = () => {
    cancelAnimationFrame(state.frame);
    state.frame = requestAnimationFrame(positionGuide);
  };
  if ("ResizeObserver" in window) {
    state.observer = new ResizeObserver(state.update);
    state.observer.observe(card);
    state.observer.observe(surface);
    state.observer.observe(panel);
  }
  window.addEventListener("resize", state.update);
  state.timer = setTimeout(() => hideTabGuide(panel, true), 5000);
  tabGuides.set(panel, state);
  state.update();
}

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


export async function runCode(code, execLanguage, button, panel) {
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
  const closeButton = barButton("term-close", "Close terminal (Esc)", "#i-close", "Close");
  function shortcutAction(button, shortcut) {
    const action = makeEl("div", "term-action");
    const hint = makeEl("span", "run-shortcut-hint", shortcut);
    hint.setAttribute("aria-hidden", "true");
    action.append(button, hint);
    return action;
  }
  barActions.append(
    shortcutAction(rerunButton, "Alt + Shift + Enter"),
    shortcutAction(closeButton, "Esc")
  );
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
    hideTabGuide(panel);
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
    if (shouldShowTabGuide()) showTabGuide(panel, button.id === "runSource" ? source : output);
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
      const message = runErrorMessage(error);
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


export function initRun() {
  const sourcePanel = $("sourceRunOutput");
  const outputPanel = $("outputRunOutput");
  const panelForEditor = new Map([[source, sourcePanel], [output, outputPanel]]);
  const editorForPanel = new Map([[sourcePanel, source], [outputPanel, output]]);
  $("runSource").addEventListener("click", () => {
    runCode(source.value, executableLanguages[sourceLanguage.value.trim().toLowerCase()] || null, $("runSource"), sourcePanel);
  });
  $("runOutput").addEventListener("click", () => {
    // Run the language the translation was made in, even if the dropdown changed since.
    const lang = state.completedTranslation ? state.completedTranslation.language : targetLanguage();
    runCode(output.value, executableLanguages[lang.trim().toLowerCase()] || null, $("runOutput"), outputPanel);
  });
  source.addEventListener("keydown", (event) => {
    if (!isAltEnter(event)) return;
    event.preventDefault();
    $("runSource").click();
  });
  output.addEventListener("keydown", (event) => {
    if (!isAltEnter(event)) return;
    event.preventDefault();
    $("runOutput").click();
  });
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.target instanceof Element && event.target.closest("dialog[open]")) return;

    if (event.key === "Tab") {
      let panel = null;
      let editor = null;
      let input = null;
      if (event.target === source || event.target === output) {
        editor = event.target;
        panel = panelForEditor.get(editor);
        input = panel?.querySelector(".term-input");
      } else if (event.target instanceof Element) {
        if (event.target.classList.contains("term-input")) {
          panel = event.target.closest(".run-output.is-terminal:not([hidden]):not(.is-leaving)");
          editor = panel ? editorForPanel.get(panel) : null;
          input = event.target;
        }
      }
      const row = input?.closest(".term-row");
      if (panel && editor && input && row && !panel.hidden && !panel.classList.contains("is-leaving") &&
          !row.hidden && !row.classList.contains("is-idle") && !input.disabled) {
        event.preventDefault();
        if (event.target === editor) {
          input.focus({ preventScroll: true });
        } else {
          editor.focus({ preventScroll: true });
        }
        hideTabGuide(panel, true);
        return;
      }
    }

    if (isAltEnter(event, true)) {
      let panel = event.target instanceof Element ?
        event.target.closest(".run-output.is-terminal:not([hidden])") : null;
      if (!panel && event.target === source) panel = $("sourceRunOutput");
      if (!panel && event.target === output) panel = $("outputRunOutput");
      if (!panel || panel.hidden || panel.classList.contains("is-leaving")) panel = activeCompilerPanel;
      if (!panel || panel.hidden || panel.classList.contains("is-leaving")) {
        const visiblePanels = document.querySelectorAll(".run-output.is-terminal:not([hidden]):not(.is-leaving)");
        panel = visiblePanels[visiblePanels.length - 1] || null;
      }
      const rerunButton = panel?.querySelector(".term-rerun:not(:disabled)");
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
}
