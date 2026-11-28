/* Source editor input: line numbers, button state, Ctrl/Cmd+Enter to translate, and Alt-drag of code. */
import { $, dom } from "../core/dom.js";
import { state } from "../core/state.js";
import { setStatus } from "../core/feedback.js";
import { refreshButtons } from "../ui/buttons.js";
import { updateLines } from "./line-numbers.js";
import { initAutoClose } from "./auto-close.js";
import { countLines } from "./source-lines.js";

const { form, source, output } = dom;
let dragMode = false;

// Retain the original Alt-drag convenience without rendering code as HTML.
function refreshDragAvailability() {
  source.draggable = dragMode && Boolean(source.value) && !state.activeController;
  output.draggable = dragMode && Boolean(output.value);
}

function setDragMode(on) {
  dragMode = on;
  document.body.classList.toggle("drag-mode", dragMode);
  refreshDragAvailability();
}

export function initSourceInput() {
  source.addEventListener("input", () => {
    state.fileReadVersion += 1;
    updateLines(source, $("sourceLines"));
    $("sourceLineCounter").textContent = `Lines ${countLines(source.value)}`;
    refreshButtons();
    refreshDragAvailability();
    if (state.completedTranslation) setStatus("Source updated. Translate again to refresh the result.");
    else setStatus("");
  });
  const insertPlainText = (event, text) => {
    if (!text || state.activeController) return;
    event.preventDefault();
    source.setRangeText(text, source.selectionStart, source.selectionEnd, "end");
    source.dispatchEvent(new Event("input", { bubbles: true }));
  };
  source.addEventListener("paste", (event) => {
    insertPlainText(event, event.clipboardData?.getData("text/plain") ?? null);
  });
  source.addEventListener("drop", (event) => {
    insertPlainText(event, event.dataTransfer?.getData("text/plain") ?? null);
  });
  $("sourceLineCounter").textContent = `Lines ${countLines(source.value)}`;
  initAutoClose(source);
  source.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      source.setRangeText("    ", source.selectionStart, source.selectionEnd, "end");
      source.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!state.activeController) form.requestSubmit();
    }
  });
  if (/Mac|iPhone|iPad/.test(navigator.platform)) $("shortcutModifier").textContent = "⌘";

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Alt") return;
    if (event.target === source || event.target === output) event.preventDefault();
    setDragMode(true);
  });
  document.addEventListener("keyup", (event) => { if (event.key === "Alt") setDragMode(false); });
  window.addEventListener("blur", () => setDragMode(false));
  [source, output].forEach((editor) => {
    editor.addEventListener("pointerdown", (event) => {
      if (event.altKey) setDragMode(true);
      else refreshDragAvailability();
    });
    editor.addEventListener("dragstart", (event) => {
      if (!dragMode) return;
      if (!event.dataTransfer) { event.preventDefault(); return; }
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      const selectedText = start !== end ? editor.value.slice(start, end) : editor.value;
      if (!selectedText) { event.preventDefault(); return; }
      event.dataTransfer.setData("text/plain", selectedText);
      event.dataTransfer.effectAllowed = "copy";
    });
    editor.addEventListener("dragend", refreshDragAvailability);
  });
}
