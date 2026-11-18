/* Source editor input: line numbers, button state, Ctrl/Cmd+Enter to translate, and Alt-drag of code. */
import { $, dom } from "../core/dom.js";
import { state } from "../core/state.js";
import { setStatus } from "../core/feedback.js";
import { refreshButtons } from "../ui/buttons.js";
import { updateLines } from "./line-numbers.js";
import { initAutoClose } from "./auto-close.js";

const { form, source, output } = dom;

let sourceHintTimer;
let sourceHintDismissed = false;

export function updateSourceRunHint() {
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

// Retain the original Alt-drag convenience without rendering code as HTML.
function setDragMode(on) {
  document.body.classList.toggle("drag-mode", on);
  source.draggable = on && Boolean(source.value) && !state.activeController;
  output.draggable = on && Boolean(output.value);
}

export function initSourceInput() {
  source.addEventListener("input", () => {
    state.fileReadVersion += 1;
    updateLines(source, $("sourceLines"));
    updateSourceRunHint();
    refreshButtons();
    if (state.completedTranslation) setStatus("Source updated. Translate again to refresh the result.");
    else setStatus("");
  });
  initAutoClose(source);
  source.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!state.activeController) form.requestSubmit();
    }
  });
  if (/Mac|iPhone|iPad/.test(navigator.platform)) $("shortcutModifier").textContent = "⌘";

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
}
