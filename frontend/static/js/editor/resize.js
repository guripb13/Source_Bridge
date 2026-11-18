/* Adjustable editor height. Both editors share one height (a CSS variable on the grid), so the
 * panels stay level. Drag a handle, use the arrow keys on it, or double-click to reset. */
import { $, dom } from "../core/dom.js";
import { keys } from "../core/config.js";
import { readStorage, writeStorage } from "../core/storage.js";

const MIN = 180;
const MAX = 900;
const STEP = 20;

export function initEditorResize() {
  const grid = dom.form;
  const surface = $("sourceSurface");
  const handles = [$("sourceResize"), $("outputResize")];
  const clamp = (value) => Math.min(MAX, Math.max(MIN, Math.round(value)));

  function sync(height) {
    handles.forEach((handle) => {
      handle.setAttribute("aria-valuemin", String(MIN));
      handle.setAttribute("aria-valuemax", String(MAX));
      handle.setAttribute("aria-valuenow", String(Math.round(height)));
    });
  }
  function apply(height) {
    const value = clamp(height);
    grid.style.setProperty("--editor-height", `${value}px`);
    grid.classList.add("has-custom-height");
    sync(value);
    return value;
  }
  function reset() {
    grid.classList.remove("has-custom-height");
    grid.style.removeProperty("--editor-height");
    writeStorage(keys.editorHeight, null);
    requestAnimationFrame(() => sync(surface.getBoundingClientRect().height));
  }

  const stored = readStorage(keys.editorHeight, null);
  if (typeof stored === "number" && Number.isFinite(stored)) apply(stored);

  handles.forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = surface.getBoundingClientRect().height;
      let latest = startHeight;
      handle.setPointerCapture(event.pointerId);
      document.body.classList.add("is-resizing-editor");
      const move = (e) => { latest = apply(startHeight + (e.clientY - startY)); };
      const end = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        document.body.classList.remove("is-resizing-editor");
        writeStorage(keys.editorHeight, latest);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    });
    handle.addEventListener("keydown", (event) => {
      const big = event.shiftKey ? 3 : 1;
      let next = null;
      const current = surface.getBoundingClientRect().height;
      if (event.key === "ArrowUp") next = current - STEP * big;
      else if (event.key === "ArrowDown") next = current + STEP * big;
      else if (event.key === "Home") next = MIN;
      else if (event.key === "End") next = MAX;
      else return;
      event.preventDefault();
      writeStorage(keys.editorHeight, apply(next));
    });
    handle.addEventListener("focus", () => sync(surface.getBoundingClientRect().height));
    handle.addEventListener("dblclick", reset);
  });
}
