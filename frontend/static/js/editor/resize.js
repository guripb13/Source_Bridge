/* Adjustable editor height. Both editors share one height, so the panels stay level.
 * Drag a handle, use the arrow keys on it, or double-click / double-tap to reset.
 *
 * Smoothness model:
 *  - While dragging, the height follows the finger 1:1 (inline height, no CSS transition, one write per frame).
 *  - Past the min / max limit the box resists like a rubber band, then springs back with an animation on release.
 *  - Every other change (release, keyboard, reset) is a short eased animation, never a snap.
 *  - The two editors can start at different heights on phones; the gap is eased out instead of jumping. */
import { $, dom } from "../core/dom.js";
import { keys } from "../core/config.js";
import { readStorage, writeStorage } from "../core/storage.js";

const FALLBACK_MIN = 140;
const MAX_EXTENSION = 2.2;
const STEP = 20;
const EDGE = 70;          // px from the top/bottom of the screen where dragging starts auto-scrolling the page
const SETTLE_MS = 280;    // release / keyboard / reset animation
const RUBBER = 140;       // how far (px) the rubber band can be pulled past a limit, at most
const FIT_MIN = 150;      // desktop auto-fit: smallest editor height before the whole workspace is scaled down instead
const FIT_MAX = 520;      // desktop auto-fit: largest editor height when the screen is tall
const ZOOM_MIN = 0.72;    // desktop auto-fit: never scale the workspace below this
const OFFSET_EASE = 0.82; // per-frame decay of the gap between the two editors while dragging
const DRAG_THRESHOLD = 3;
const DOUBLE_TAP_MS = 500;
const DOUBLE_TAP_DISTANCE = 24;

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const motionOK = () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function initEditorResize() {
  const grid = dom.form;
  const surface = $("sourceSurface");
  const outSurface = $("outputSurface");
  const handles = [$("sourceResize"), $("outputResize")];
  const surfaces = [surface, outSurface];
  const root = document.documentElement;
  let minHeight = FALLBACK_MIN;
  let maxHeight = Math.round(FALLBACK_MIN * MAX_EXTENSION);
  let defaultOut = FALLBACK_MIN; // the output editor's own default height (differs from the source on phones)
  let pendingStoredHeight = readStorage(keys.editorHeight, null);
  if (typeof pendingStoredHeight !== "number" || !Number.isFinite(pendingStoredHeight)) pendingStoredHeight = null;

  const clamp = (value) => Math.min(maxHeight, Math.max(minHeight, Math.round(value)));
  const hasCustom = () => grid.classList.contains("has-custom-height");

  function updateHeightLimits() {
    const hadCustom = hasCustom();
    const customHeight = grid.style.getPropertyValue("--editor-height");
    grid.classList.add("is-measuring-editor-height");
    grid.classList.remove("has-custom-height");
    grid.style.removeProperty("--editor-height");
    surfaces.forEach((s) => s.style.removeProperty("--editor-height"));
    const defaultHeight = Math.round(surface.getBoundingClientRect().height);
    const outHeight = Math.round(outSurface.getBoundingClientRect().height);
    if (defaultHeight > 0) {
      minHeight = Math.max(FALLBACK_MIN, defaultHeight);
      maxHeight = Math.round(minHeight * MAX_EXTENSION);
      defaultOut = outHeight > 0 ? outHeight : minHeight;
    }
    if (customHeight) {
      grid.style.setProperty("--editor-height", customHeight);
      surfaces.forEach((s) => s.style.setProperty("--editor-height", customHeight));
    }
    if (hadCustom) grid.classList.add("has-custom-height");
    grid.classList.remove("is-measuring-editor-height");
  }

  // ---- accessibility attributes: written when a change settles, never per frame ----
  function sync(height) {
    const hintText = hasCustom() ? "Double-click to restore default height" : "Drag to adjust the height";
    handles.forEach((handle) => {
      handle.setAttribute("aria-valuemin", String(minHeight));
      handle.setAttribute("aria-valuemax", String(maxHeight));
      handle.setAttribute("aria-valuenow", String(Math.round(height)));
      const hint = handle.querySelector(".resize-hint");
      if (hint && hint.textContent !== hintText) hint.textContent = hintText;
    });
  }

  // ---- low-level writers ----
  // Live: inline height (wins over the stylesheet's !important), no transition, no custom-property inheritance.
  function writeLive(src, out) {
    surface.style.setProperty("height", `${src}px`, "important");
    outSurface.style.setProperty("height", `${out}px`, "important");
  }
  function beginLive() {
    grid.classList.add("has-custom-height");
    surfaces.forEach((s) => { s.style.transition = "none"; });
    root.style.overflowAnchor = "none"; // stop the browser "correcting" scroll while the layout above the finger changes
    writeLive(shownSrc, shownOut);      // pin the current heights in the same step, so nothing jumps
  }
  function endLive() {
    surfaces.forEach((s) => { s.style.removeProperty("height"); s.style.removeProperty("transition"); });
    root.style.removeProperty("overflow-anchor");
  }
  // Rest state: the shared height lives in a CSS variable, nothing inline.
  function commit(value) {
    surfaces.forEach((s) => s.style.setProperty("--editor-height", `${value}px`));
    grid.style.setProperty("--editor-height", `${value}px`);
    grid.classList.add("has-custom-height");
    endLive();
    sync(value);
  }
  function restoreDefault() {
    grid.classList.remove("has-custom-height");
    grid.style.removeProperty("--editor-height");
    surfaces.forEach((s) => s.style.removeProperty("--editor-height"));
    endLive();
    sync(minHeight);
  }

  // ---- one animation at a time ----
  let anim = 0;
  let shownSrc = surface.getBoundingClientRect().height;
  let shownOut = outSurface.getBoundingClientRect().height;
  function stopAnim() { if (anim) cancelAnimationFrame(anim); anim = 0; }

  // Ease both editors from where they are now to (toSrc, toOut), then call done().
  function animateTo(toSrc, toOut, done, ms = SETTLE_MS) {
    stopAnim();
    const fromSrc = shownSrc, fromOut = shownOut;
    if (!motionOK() || (Math.abs(toSrc - fromSrc) < 0.5 && Math.abs(toOut - fromOut) < 0.5)) {
      shownSrc = toSrc; shownOut = toOut;
      done();
      return;
    }
    beginLive();
    const t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = easeOut(k);
      shownSrc = fromSrc + (toSrc - fromSrc) * e;
      shownOut = fromOut + (toOut - fromOut) * e;
      writeLive(shownSrc, shownOut);
      if (k < 1) anim = requestAnimationFrame(tick);
      else { anim = 0; shownSrc = toSrc; shownOut = toOut; done(); }
    };
    anim = requestAnimationFrame(tick);
  }

  function settleTo(value, persist = true) {
    const v = clamp(value);
    animateTo(v, v, () => {
      commit(v);
      if (persist) writeStorage(keys.editorHeight, v > minHeight ? v : null);
    });
    return v;
  }
  function reset() {
    animateTo(minHeight, defaultOut, () => {
      restoreDefault();
      writeStorage(keys.editorHeight, null);
    });
  }
  function resetFromCurrent() {
    shownSrc = surface.getBoundingClientRect().height;
    shownOut = outSurface.getBoundingClientRect().height;
    reset();
  }

  // ---- initial height ----
  const translateView = $("translateView");
  let hasInitializedHeight = false;
  const visibilityObserver = new MutationObserver(initializeHeight);

  // ---- Desktop auto-fit: the whole workspace (down to the Personalize row) must be visible without scrolling ----
  // 1) the editors grow or shrink to use exactly the free height; 2) if they hit FIT_MIN and it still does not
  // fit, the workspace is scaled down (CSS zoom). Skipped on phones/tablets and once the user sets their own height.
  const main = document.querySelector(".main-content");
  const personalize = $("personalize");
  const desktopQuery = window.matchMedia("(min-width: 901px)");
  function clearFit() {
    grid.classList.remove("has-fit-height");
    grid.style.removeProperty("--fit-height");
    translateView.style.removeProperty("zoom");
  }
  function fit() {
    if (translateView.hidden || !main) return;
    if (!desktopQuery.matches) { clearFit(); return; }
    if (hasCustom() || document.body.classList.contains("is-resizing-editor")) return;
    const avail = window.innerHeight;
    const tail = document.querySelector(".workspace-bottom") || personalize;
    const pad = parseFloat(getComputedStyle(main).paddingBottom) || 0;
    // Real bottom of the content (not the page's min-height), plus the padding under it.
    const need = () => tail.getBoundingClientRect().bottom + window.scrollY + pad;
    grid.classList.add("is-measuring-editor-height"); // no height transition while measuring
    clearFit();
    const natural = surface.getBoundingClientRect().height;
    const target = Math.round(Math.min(FIT_MAX, Math.max(FIT_MIN, natural + avail - need())));
    grid.style.setProperty("--fit-height", `${target}px`);
    grid.classList.add("has-fit-height");
    for (let i = 0; i < 3 && need() > avail + 0.5; i++) {
      const top = translateView.getBoundingClientRect().top + window.scrollY;
      const current = parseFloat(translateView.style.zoom) || 1;
      const next = Math.max(ZOOM_MIN, current * ((avail - top) / (need() - top)));
      if (next >= current - 0.001) break;
      translateView.style.zoom = next.toFixed(3);
    }
    grid.classList.remove("is-measuring-editor-height");
  }
  let fitFrame = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(() => {
      if (anim) return;
      fit();
      if (hasInitializedHeight && !hasCustom()) { updateHeightLimits(); sync(surface.getBoundingClientRect().height); }
    });
  });

  function initializeHeight() {
    if (hasInitializedHeight || translateView.hidden) return;
    fit();
    updateHeightLimits();
    const height = surface.getBoundingClientRect().height;
    if (height <= 0) return;
    hasInitializedHeight = true;
    if (pendingStoredHeight !== null) {
      const v = clamp(pendingStoredHeight);
      pendingStoredHeight = null;
      if (v > minHeight) commit(v); else sync(height);
      writeStorage(keys.editorHeight, v > minHeight ? v : null);
    } else sync(height);
    shownSrc = surface.getBoundingClientRect().height;
    shownOut = outSurface.getBoundingClientRect().height;
    visibilityObserver.disconnect();
  }
  visibilityObserver.observe(translateView, { attributes: true, attributeFilter: ["hidden"] });
  initializeHeight();

  // Rubber band: 1:1 inside the limits, increasing resistance beyond them.
  function band(raw) {
    if (raw < minHeight) return minHeight - RUBBER * (1 - 1 / ((minHeight - raw) * 0.6 / RUBBER + 1));
    if (raw > maxHeight) return maxHeight + RUBBER * (1 - 1 / ((raw - maxHeight) * 0.6 / RUBBER + 1));
    return raw;
  }

  let lastTap = null;
  handles.forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      if (!hasInitializedHeight) initializeHeight();
      const startY = event.clientY;
      let startHeight = 0;
      let gap = 0; // output minus source; eased to 0 while dragging
      let raw = 0;
      try { handle.setPointerCapture(event.pointerId); } catch (_) { /* pointer already gone */ }
      let pointerY = startY;
      let scrollStart = 0;
      let frame = 0;
      let dragging = false;
      const pointerId = event.pointerId;
      const beginDrag = () => {
        dragging = true;
        lastTap = null;
        stopAnim();
        shownSrc = surface.getBoundingClientRect().height;
        shownOut = outSurface.getBoundingClientRect().height;
        startHeight = shownSrc;
        gap = shownOut - shownSrc;
        raw = startHeight;
        scrollStart = window.scrollY;
        document.body.classList.add("is-resizing-editor");
        beginLive();
        frame = requestAnimationFrame(update);
      };
      const update = () => {
        frame = 0;
        if (!dragging) return;
        let speed = 0;
        if (pointerY > window.innerHeight - EDGE) speed = Math.min(1, (pointerY - (window.innerHeight - EDGE)) / EDGE) * 18;
        else if (pointerY < EDGE) speed = -Math.min(1, (EDGE - pointerY) / EDGE) * 18;
        if (speed) window.scrollBy(0, speed);
        raw = startHeight + (pointerY - startY) + (window.scrollY - scrollStart);
        shownSrc = band(raw);
        gap *= OFFSET_EASE;
        if (Math.abs(gap) < 0.5) gap = 0;
        shownOut = shownSrc + gap;
        writeLive(shownSrc, shownOut);
        if (speed || gap) frame = requestAnimationFrame(update);
      };
      const move = (e) => {
        if (e.pointerId !== pointerId) return;
        pointerY = e.clientY;
        if (!dragging && Math.abs(pointerY - startY) < DRAG_THRESHOLD) return;
        if (!dragging) beginDrag();
        if (!frame) frame = requestAnimationFrame(update);
      };
      const end = (e, cancelled = false) => {
        if (e.pointerId !== undefined && e.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("blur", onBlur);
        handle.removeEventListener("lostpointercapture", onLostPointerCapture);
        if (dragging) {
          if (!cancelled && Number.isFinite(e.clientY)) pointerY = e.clientY;
          raw = startHeight + (pointerY - startY) + (window.scrollY - scrollStart);
          dragging = false;
          cancelAnimationFrame(frame);
          frame = 0;
          document.body.classList.remove("is-resizing-editor");
          settleTo(raw); // springs back from the rubber band, or eases the last pixels into place
        } else if (e.type === "pointerup") {
          const now = performance.now();
          const closeToLastTap = lastTap
            && lastTap.handle === handle
            && now - lastTap.time <= DOUBLE_TAP_MS
            && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) <= DOUBLE_TAP_DISTANCE;
          if (closeToLastTap) {
            lastTap = null;
            resetFromCurrent();
          } else {
            lastTap = { handle, time: now, x: e.clientX, y: e.clientY };
          }
        } else {
          lastTap = null;
        }
      };
      const onBlur = () => end({ type: "blur", pointerId }, true);
      const onCancel = (e) => end(e, true);
      const onLostPointerCapture = (e) => end(e, true);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("blur", onBlur);
      handle.addEventListener("lostpointercapture", onLostPointerCapture);
    });

    handle.addEventListener("keydown", (event) => {
      const big = event.shiftKey ? 3 : 1;
      const current = anim ? shownSrc : surface.getBoundingClientRect().height;
      let next;
      if (event.key === "ArrowUp") next = current - STEP * big;
      else if (event.key === "ArrowDown") next = current + STEP * big;
      else if (event.key === "Home") next = minHeight;
      else if (event.key === "End") next = maxHeight;
      else return;
      event.preventDefault();
      shownSrc = current;
      shownOut = anim ? shownOut : outSurface.getBoundingClientRect().height;
      settleTo(next);
    });
    handle.addEventListener("focus", () => sync(surface.getBoundingClientRect().height));
  });
}