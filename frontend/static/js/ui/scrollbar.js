/* Animated page scrollbar: slides in from the right when the page becomes
   scrollable, slides out when it stops. Desktop (mouse) only; touch devices
   keep their native overlay scrollbar. */

export function initPageScrollbar() {
  if (!window.matchMedia("(pointer: fine)").matches) return;

  const root = document.documentElement;
  const body = document.body;
  const MIN_THUMB = 64;   // px, keeps the pill long
  const TOLERANCE = 2;    // px of overflow ignored (sub-pixel / dvh rounding)
  const SETTLE = 90;      // ms a new state must stay stable before animating

  const track = document.createElement("div");
  track.className = "page-scrollbar";
  track.setAttribute("aria-hidden", "true");
  const thumb = document.createElement("div");
  thumb.className = "page-scrollbar-thumb";
  track.appendChild(thumb);
  body.appendChild(track);
  root.classList.add("has-custom-scrollbar");

  let shown = false;
  let settleTimer = 0, trailTimer = 0, frame = 0;
  let trackH = 0, thumbH = 0, range = 1;
  let dragging = null;

  // Scrolling locked by CSS (e.g. body.sidebar-open sets overflow: hidden)
  const isLocked = () => [body, root].some((el) => {
    const overflow = getComputedStyle(el).overflowY;
    return overflow === "hidden" || overflow === "clip";
  });

  // Uses layout height (offsetHeight), which ignores transform animations,
  // unlike scrollHeight which grows while content is mid-animation.
  function measure() {
    const viewH = root.clientHeight;
    const docH = Math.max(root.offsetHeight, body.offsetHeight);
    return { viewH, docH, scrollable: !isLocked() && docH - viewH > TOLERANCE };
  }

  function place(m) {
    trackH = track.clientHeight;
    range = Math.max(1, m.docH - m.viewH);
    thumbH = Math.min(trackH, Math.max(MIN_THUMB, (trackH * m.viewH) / m.docH));
    const ratio = Math.min(1, Math.max(0, root.scrollTop / range));
    thumb.style.height = thumbH + "px";
    thumb.style.transform = "translateY(" + ratio * (trackH - thumbH) + "px)";
  }

  function setShown(value) {
    shown = value;
    track.classList.toggle("is-visible", value);   // slide in / out
  }

  function sync() {
    frame = 0;
    const m = measure();
    if (m.scrollable) place(m);                    // keep the thumb live while visible
    if (m.scrollable === shown) {                  // nothing to animate; cancel any pending flip
      clearTimeout(settleTimer);
      settleTimer = 0;
      return;
    }
    if (settleTimer) return;                       // a flip is already waiting to be confirmed
    settleTimer = setTimeout(() => {
      settleTimer = 0;
      const n = measure();                         // confirm the state is still the same
      if (n.scrollable) place(n);
      if (n.scrollable !== shown) setShown(n.scrollable);
    }, SETTLE);
  }

  // Check now (next frame) and again after any animation could have finished
  function kick() {
    if (!frame) frame = requestAnimationFrame(sync);
    clearTimeout(trailTimer);
    trailTimer = setTimeout(sync, 450);
  }

  // Drag the pill
  thumb.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    thumb.setPointerCapture(event.pointerId);
    dragging = { y: event.clientY, top: root.scrollTop };
    track.classList.add("is-dragging");
  });
  thumb.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const free = trackH - thumbH;
    if (free <= 0) return;
    const next = dragging.top + (event.clientY - dragging.y) * (range / free);
    root.scrollTop = Math.min(range, Math.max(0, next));
  });
  const endDrag = (event) => {
    if (!dragging) return;
    dragging = null;
    track.classList.remove("is-dragging");
    try { thumb.releasePointerCapture(event.pointerId); } catch (_) { /* already released */ }
  };
  thumb.addEventListener("pointerup", endDrag);
  thumb.addEventListener("pointercancel", endDrag);

  // Click on the empty track to jump there
  track.addEventListener("pointerdown", (event) => {
    if (event.target !== track) return;
    const free = trackH - thumbH;
    if (free <= 0) return;
    const rect = track.getBoundingClientRect();
    const ratio = (event.clientY - rect.top - thumbH / 2) / free;
    root.scrollTo({ top: Math.min(1, Math.max(0, ratio)) * range, behavior: "smooth" });
  });

  // Everything that can change scrollability or thumb position
  window.addEventListener("scroll", kick, { passive: true });
  window.addEventListener("resize", kick);
  window.addEventListener("load", kick);
  window.addEventListener("pageshow", kick);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sync(); });
  ["animationend", "animationcancel", "transitionend", "transitioncancel"].forEach((name) => {
    document.addEventListener(name, (event) => {
      if (!track.contains(event.target)) kick();   // ignore the scrollbar's own transitions
    }, true);
  });
  if ("ResizeObserver" in window) {
    const resizeObserver = new ResizeObserver(kick);
    resizeObserver.observe(body);
    resizeObserver.observe(root);
  }
  new MutationObserver(kick).observe(body, {
    attributes: true,
    subtree: true,
    attributeFilter: ["class", "hidden", "style"],
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(kick);

  // Safety net: if anything ever slips through, it self-corrects within a second
  setInterval(sync, 1000);

  kick();
}
