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

export function initDialogScrollbars() {
  if (!window.matchMedia("(pointer: fine)").matches) return;

  const minThumb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sb-min-length")) || 64;

  document.querySelectorAll(".app-dialog").forEach((dialog) => {
    dialog.classList.add("has-rounded-scrollbar");
    const track = document.createElement("div");
    track.className = "dialog-scrollbar";
    track.setAttribute("aria-hidden", "true");
    const thumb = document.createElement("div");
    thumb.className = "dialog-scrollbar-thumb";
    track.appendChild(thumb);
    dialog.appendChild(track);

    let trackHeight = 0;
    let thumbHeight = 0;
    let scrollRange = 0;
    let drag = null;

    function sync() {
      const rect = dialog.getBoundingClientRect();
      const transformed = getComputedStyle(dialog).transform !== "none";
      scrollRange = dialog.scrollHeight - dialog.clientHeight;
      trackHeight = Math.max(0, rect.height - 16);
      if (!dialog.open || scrollRange <= 1 || trackHeight <= 0 || transformed) {
        track.classList.remove("is-visible");
        return;
      }

      const borderRight = parseFloat(getComputedStyle(dialog).borderRightWidth) || 0;
      track.style.top = `${rect.top + 8}px`;
      track.style.left = `${rect.right - borderRight - track.offsetWidth}px`;
      track.style.height = `${trackHeight}px`;
      thumbHeight = Math.min(trackHeight, Math.max(minThumb, trackHeight * dialog.clientHeight / dialog.scrollHeight));
      const free = trackHeight - thumbHeight;
      const ratio = scrollRange > 0 ? Math.min(1, Math.max(0, dialog.scrollTop / scrollRange)) : 0;
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${ratio * free}px)`;
      track.classList.add("is-visible");
    }

    function moveThumb(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const free = trackHeight - thumbHeight;
      if (free > 0) dialog.scrollTop = drag.scrollTop + (event.clientY - drag.y) * (scrollRange / free);
    }

    function endDrag(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      track.classList.remove("is-dragging");
    }

    thumb.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      thumb.setPointerCapture(event.pointerId);
      drag = { pointerId: event.pointerId, y: event.clientY, scrollTop: dialog.scrollTop };
      track.classList.add("is-dragging");
    });
    thumb.addEventListener("pointermove", moveThumb);
    thumb.addEventListener("pointerup", endDrag);
    thumb.addEventListener("pointercancel", endDrag);
    thumb.addEventListener("lostpointercapture", endDrag);
    track.addEventListener("pointerdown", (event) => {
      if (event.target !== track || trackHeight <= thumbHeight) return;
      event.preventDefault();
      const ratio = (event.clientY - track.getBoundingClientRect().top - thumbHeight / 2) / (trackHeight - thumbHeight);
      dialog.scrollTop = Math.min(1, Math.max(0, ratio)) * scrollRange;
    });
    dialog.addEventListener("scroll", sync, { passive: true });
    dialog.addEventListener("transitionend", sync);
    window.addEventListener("resize", sync);
    window.visualViewport?.addEventListener("resize", sync);
    window.visualViewport?.addEventListener("scroll", sync);
    dialog.addEventListener("close", sync);
    if ("ResizeObserver" in window) new ResizeObserver(sync).observe(dialog);
    new MutationObserver(sync).observe(dialog, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden"] });
    sync();
  });
}
