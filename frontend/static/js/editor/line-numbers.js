/* Line-number gutters that follow each editor's scroll position. */
import { $, dom } from "../core/dom.js";

export function syncScroll(editor, gutter) { gutter.style.transform = `translateY(${-editor.scrollTop}px)`; }
export function updateLines(editor, gutter) {
  const count = Math.max(5, editor.value.split("\n").length);
  if (gutter.dataset.count !== String(count)) {
    gutter.textContent = Array.from({ length: count }, (_, index) => index + 1).join("\n");
    gutter.dataset.count = String(count);
  }
  syncScroll(editor, gutter);
}

export function initLineNumbers() {
  [[dom.source, $("sourceLines")], [dom.output, $("outputLines")]].forEach(([editor, gutter]) => {
    editor.addEventListener("scroll", () => syncScroll(editor, gutter), { passive: true });
    updateLines(editor, gutter);
  });
}
