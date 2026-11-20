/* Smooth open / close / resize of the terminal panels (Web Animations API). */

// ---------- PANEL HEIGHT ANIMATION (open, close AND every change in between) ----------
// The panel is always `height: auto`. Whenever its content changes size (output grows, the input
// row appears or goes away, a button is shown or hidden, the run finishes ...) a MutationObserver
// notices before the browser paints, and the height is animated from the old size to the new one
// with the Web Animations API. Opening animates 0 -> real height, closing real height -> 0.
// When an animation ends nothing is left behind, so the panel is back to plain auto height.
export const panelAnims = new WeakMap();   // panel -> the animation that is running now
const panelState = new WeakMap();   // panel -> { last: last settled height, target: where the running animation ends, margin }
const OPEN_MS = 380, CLOSE_MS = 300, RESIZE_MS = 280;
const EASE_OPEN = "cubic-bezier(.22, .61, .36, 1)", EASE_CLOSE = "cubic-bezier(.4, 0, .2, 1)";

export function motionAllowed() {
  return typeof Element.prototype.animate === "function" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
// Height the panel WANTS to have: its borders + its children. Unlike getBoundingClientRect it is not
// affected by an animation that is running, so it is safe to read at any time.
export function naturalHeight(panel) {
  let height = panel.offsetHeight - panel.clientHeight;
  for (const child of panel.children) height += child.offsetHeight;
  return height;
}
export function stateOf(panel) {
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
export function cancelPanelAnim(panel) {
  const running = panelAnims.get(panel);
  if (running) stateOf(panel).last = panel.getBoundingClientRect().height;   // where it visibly is now
  panelAnims.delete(panel);
  panel.classList.remove("is-entering", "is-leaving");
  if (running) running.cancel();
}
export function revealPanel(panel) {
  // Make sure the whole terminal is on screen once it has finished opening.
  panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// One animation from `from` to `to` px. Used for opening and for every later size change.
export function growPanel(panel, o) {
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
export function onPanelChange(panel) {
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

export function openPanel(panel) {
  cancelPanelAnim(panel);
  const state = stateOf(panel);
  const to = naturalHeight(panel);
  state.margin = parseFloat(getComputedStyle(panel).marginTop) || 0;
  if (!motionAllowed()) { state.last = to; return; }
  panel.classList.add("is-entering");
  growPanel(panel, { from: 0, to, fromOpacity: 0, fromMargin: 0, duration: OPEN_MS, opening: true });
}

export function closePanel(panel, done) {
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
