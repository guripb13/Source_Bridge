/* Adjustable editor height. Both editors share one height (a CSS variable on the grid), so the
 * panels stay level. Drag a handle, use the arrow keys on it, or double-click to reset. */
import { $, dom } from "../core/dom.js";
import { keys } from "../core/config.js";
import { readStorage, writeStorage } from "../core/storage.js";

const FALLBACK_MIN = 180;
const MAX_EXTENSION = 1.7;
const STEP = 20;

export function initEditorResize() {
  const grid = dom.form;
  const surface = $("sourceSurface");
  const handles = [$("sourceResize"), $("outputResize")];
  let minHeight = FALLBACK_MIN;
  let maxHeight = Math.round(FALLBACK_MIN * MAX_EXTENSION);
  let pendingStoredHeight = readStorage(keys.editorHeight, null);
  if (typeof pendingStoredHeight !== "number" || !Number.isFinite(pendingStoredHeight)) pendingStoredHeight = null;

  function updateHeightLimits() {
    const hasCustomHeight = grid.classList.contains("has-custom-height");
    const customHeight = grid.style.getPropertyValue("--editor-height");
    grid.classList.add("is-measuring-editor-height");
    grid.classList.remove("has-custom-height");
    grid.style.removeProperty("--editor-height");
    const defaultHeight = Math.round(surface.getBoundingClientRect().height);
    if (defaultHeight > 0) {
      minHeight = Math.max(FALLBACK_MIN, defaultHeight);
      maxHeight = Math.round(minHeight * MAX_EXTENSION);
    }
    if (customHeight) grid.style.setProperty("--editor-height", customHeight);
    if (hasCustomHeight) grid.classList.add("has-custom-height");
    grid.classList.remove("is-measuring-editor-height");
  }
  const clamp = (value) => Math.min(maxHeight, Math.max(minHeight, Math.round(value)));

  function sync(height) {
    const hintText = grid.classList.contains("has-custom-height")
      ? "Double-click to restore default height"
      : "Drag to adjust the height";
    handles.forEach((handle) => {
      handle.setAttribute("aria-valuemin", String(minHeight));
      handle.setAttribute("aria-valuemax", String(maxHeight));
      handle.setAttribute("aria-valuenow", String(Math.round(height)));
      handle.querySelector(".resize-hint").textContent = hintText;
    });
  }
  function apply(height) {
    const value = clamp(height);
    if (value === minHeight) {
      grid.classList.remove("has-custom-height");
      grid.style.removeProperty("--editor-height");
      sync(minHeight);
      return minHeight;
    }
    grid.style.setProperty("--editor-height", `${value}px`);
    grid.classList.add("has-custom-height");
    sync(value);
    return value;
  }
  function reset() {
    grid.classList.remove("has-custom-height");
    grid.style.removeProperty("--editor-height");
    writeStorage(keys.editorHeight, null);
    sync(minHeight);
  }

  const translateView = $("translateView");
  let hasInitializedHeight = false;
  // Measure once when the workspace first appears; later viewport changes must not reset manual resizing.
  const visibilityObserver = new MutationObserver(initializeHeight);

  function initializeHeight() {
    if (hasInitializedHeight || translateView.hidden) return;
    updateHeightLimits();
    const height = surface.getBoundingClientRect().height;
    if (height <= 0) return;
    hasInitializedHeight = true;
    if (pendingStoredHeight !== null) {
      const appliedHeight = apply(pendingStoredHeight);
      pendingStoredHeight = null;
      writeStorage(keys.editorHeight, grid.classList.contains("has-custom-height") ? appliedHeight : null);
    } else sync(height);
    visibilityObserver.disconnect();
  }

  visibilityObserver.observe(translateView, { attributes: true, attributeFilter: ["hidden"] });
  initializeHeight();

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
        writeStorage(keys.editorHeight, grid.classList.contains("has-custom-height") ? latest : null);
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
      else if (event.key === "Home") next = minHeight;
      else if (event.key === "End") next = maxHeight;
      else return;
      event.preventDefault();
      const appliedHeight = apply(next);
      writeStorage(keys.editorHeight, grid.classList.contains("has-custom-height") ? appliedHeight : null);
    });
    handle.addEventListener("focus", () => sync(surface.getBoundingClientRect().height));
    handle.addEventListener("dblclick", reset);
  });
}
