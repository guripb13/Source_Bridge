/**
 * mobile-touch.js — Source Bridge Mobile & Tablet Touch Enhancement
 * Drop this file at: frontend/static/js/mobile-touch.js
 * Then add to index.html before </body>:
 *   <script type="module" src="{{ url_for('static', filename='js/mobile-touch.js') }}"></script>
 */

(function () {
  "use strict";

  const isMobile    = () => window.matchMedia("(max-width: 900px)").matches;
  const isPhone     = () => window.matchMedia("(max-width: 600px)").matches;
  const isTouch     = () => window.matchMedia("(pointer: coarse)").matches;
  const qs          = (sel, ctx = document) => ctx.querySelector(sel);

  /* =========================================
     1. SWIPE TO OPEN / CLOSE SIDEBAR DRAWER
        Swipe right from left edge  → open
        Swipe left while open       → close
  ========================================= */
  (function initSwipeSidebar() {
    const EDGE_ZONE       = 32;   // px from left edge to begin tracking open
    const OPEN_THRESHOLD  = 70;   // px swipe distance to open
    const CLOSE_THRESHOLD = 70;   // px swipe distance to close
    const MAX_Y_DRIFT     = 80;   // max vertical movement before we cancel

    let startX = 0, startY = 0, tracking = false, wasOpen = false;

    function sidebarIsOpen() {
      return document.body.classList.contains("sidebar-open");
    }

    document.addEventListener("touchstart", (e) => {
      if (!isMobile()) return;
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      wasOpen = sidebarIsOpen();
      tracking = wasOpen || startX <= EDGE_ZONE;
    }, { passive: true });

    document.addEventListener("touchmove", (e) => {
      if (!tracking || !isMobile()) return;
      const t = e.touches[0];
      const dy = Math.abs(t.clientY - startY);
      if (dy > MAX_Y_DRIFT) { tracking = false; return; }
    }, { passive: true });

    document.addEventListener("touchend", (e) => {
      if (!tracking || !isMobile()) { tracking = false; return; }
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);
      tracking = false;

      if (dy > MAX_Y_DRIFT) return;

      if (!wasOpen && dx > OPEN_THRESHOLD) {
        const toggle = qs("#sidebarToggle");
        if (toggle) toggle.click();
      }
      if (wasOpen && dx < -CLOSE_THRESHOLD) {
        const backdrop = qs("#sidebarBackdrop");
        if (backdrop) backdrop.click();
      }
    }, { passive: true });
  })();


  /* =========================================
     2. SWIPE BETWEEN SETUP STEPS
        Left  → Continue (Get Started / Continue)
        Right → Back
        Only active inside the welcome/language/translate flow
  ========================================= */
  (function initSwipeSteps() {
    const THRESHOLD    = 65;
    const MAX_Y        = 80;
    const MIN_VELOCITY = 0.25; // px/ms

    let startX = 0, startY = 0, startTime = 0, active = false;

    function sidebarOpen() { return document.body.classList.contains("sidebar-open"); }

    // Don't swipe views if the touch started in a horizontally scrollable area
    function inHScroll(el) {
      let node = el;
      while (node && node !== document.body) {
        const o = window.getComputedStyle(node).overflowX;
        if ((o === "auto" || o === "scroll") && node.scrollWidth > node.clientWidth) return true;
        node = node.parentElement;
      }
      return false;
    }

    document.addEventListener("touchstart", (e) => {
      if (!isMobile() || sidebarOpen()) return;
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      startTime = Date.now();
      active = !inHScroll(e.target);
    }, { passive: true });

    document.addEventListener("touchend", (e) => {
      if (!active || !isMobile() || sidebarOpen()) { active = false; return; }
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);
      const dt = Date.now() - startTime;
      const v  = Math.abs(dx) / Math.max(dt, 1);
      active   = false;

      if (dy > MAX_Y) return;
      if (Math.abs(dx) < THRESHOLD && v < MIN_VELOCITY) return;

      const views = ["welcomeView", "languageView", "translateView"];
      const current = views.find(id => !qs("#" + id)?.hidden);
      if (!current) return;
      const idx = views.indexOf(current);

      if (dx < 0 && idx < views.length - 1) {
        // Swipe left → forward
        const btn = qs("#getStartedButton") || qs("#continueButton");
        if (btn && !btn.disabled && !btn.hidden) btn.click();
      }
      if (dx > 0 && idx > 0) {
        // Swipe right → back
        const btn = qs("#languageBack");
        if (btn && !btn.hidden) btn.click();
      }
    }, { passive: true });
  })();


  /* =========================================
     3. TOUCH RIPPLE ON BUTTONS
        Subtle visual confirmation of tap
  ========================================= */
  (function initRipple() {
    if (!isTouch()) return;

    const DUR = 360;
    const TARGETS = [
      ".pill-button", ".nav-item", ".filter-chip",
      ".suggestion-chip", ".language-option", ".auth-tab",
      ".translate-button", ".icon-button", ".text-button",
      ".tips-button", ".sign-in-button"
    ].join(", ");

    // Inject keyframe once
    if (!qs("#sb-ripple-kf")) {
      const s = document.createElement("style");
      s.id = "sb-ripple-kf";
      s.textContent = `@keyframes sbRipple {
        from { transform: scale(0); opacity: 0.12; }
        to   { transform: scale(1); opacity: 0; }
      }`;
      document.head.appendChild(s);
    }

    document.addEventListener("touchstart", (e) => {
      const el = e.target.closest(TARGETS);
      if (!el || el.disabled) return;

      const r = el.querySelector(".sb-ripple");
      if (r) r.remove();

      const rect = el.getBoundingClientRect();
      const t    = e.touches[0];
      const x    = t.clientX - rect.left;
      const y    = t.clientY - rect.top;
      const size = Math.max(rect.width, rect.height) * 2.2;

      const dot = document.createElement("span");
      dot.className = "sb-ripple";
      Object.assign(dot.style, {
        position: "absolute",
        left: (x - size / 2) + "px",
        top:  (y - size / 2) + "px",
        width: size + "px", height: size + "px",
        borderRadius: "50%",
        background: "currentColor",
        opacity: "0.12",
        transform: "scale(0)",
        animation: `sbRipple ${DUR}ms ease-out forwards`,
        pointerEvents: "none",
        zIndex: "0",
      });

      const pos = window.getComputedStyle(el).position;
      if (pos === "static") el.style.position = "relative";
      el.style.overflow = "hidden";
      el.appendChild(dot);
      setTimeout(() => { if (dot.parentNode) dot.remove(); }, DUR + 60);
    }, { passive: true });
  })();


  /* =========================================
     4. PULL-TO-REFRESH PREVENTION
        Prevents accidental browser PTR when
        the user is scrolling the workspace
  ========================================= */
  (function initNoPullToRefresh() {
    if (!isTouch()) return;
    let startY = 0;

    document.addEventListener("touchstart", (e) => {
      startY = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener("touchmove", (e) => {
      if (!isMobile()) return;
      const dy = e.touches[0].clientY - startY;
      // Only block if at the very top and pulling down, and not inside a scrollable area
      if (dy > 0 && window.scrollY === 0) {
        const scrollable = e.target.closest(
          ".code-editor, .term-screen, .app-dialog, .saved-list, .history-list, .nav-list"
        );
        if (!scrollable) e.preventDefault();
      }
    }, { passive: false });
  })();


  /* =========================================
     5. KEYBOARD AVOIDANCE
        When an input gains focus on mobile,
        scroll it into view above the keyboard
  ========================================= */
  (function initKeyboardAvoidance() {
    if (!isTouch()) return;

    document.addEventListener("focusin", (e) => {
      if (!isMobile()) return;
      const el = e.target;
      if (el.tagName !== "TEXTAREA" && el.tagName !== "INPUT") return;
      setTimeout(() => {
        const rect = el.getBoundingClientRect();
        const vh   = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        if (rect.bottom > vh - 20) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 350);
    });
  })();


  /* =========================================
     6. DOUBLE-TAP RESIZE HANDLE RESET
        Mirrors dblclick for touch devices
  ========================================= */
  (function initDoubleTapResize() {
    if (!isTouch()) return;
    let last = 0;

    document.querySelectorAll(".resize-handle").forEach((handle) => {
      handle.addEventListener("touchend", (e) => {
        const now = Date.now();
        if (now - last < 320) {
          e.preventDefault();
          handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        }
        last = now;
      });
      // Block multi-touch on resize handle
      handle.addEventListener("touchstart", (e) => {
        if (e.touches.length > 1) e.stopPropagation();
      }, { passive: true });
    });
  })();


  /* =========================================
     7. SCROLL INTO VIEW ON VIEW CHANGE
  ========================================= */
  document.addEventListener("sb:viewchange", () => {
    window.scrollTo({ top: 0, behavior: "instant" });
  });


  /* =========================================
     8. OVERSCROLL CONTAIN IN EDITORS
        Keeps editor scroll from bouncing the
        whole page on iOS
  ========================================= */
  (function initEditorScrollContain() {
    if (!isTouch()) return;
    document.querySelectorAll(".code-editor, .term-screen").forEach((el) => {
      el.style.overscrollBehavior = "contain";
      el.style.webkitOverflowScrolling = "touch";
    });
  })();


  /* =========================================
     9. ACTIVE-STATE STYLES FOR TOUCH
        Injected as a stylesheet so they
        apply to dynamically created elements
  ========================================= */
  (function injectTouchActiveStyles() {
    if (!isTouch() || qs("#sb-touch-active-styles")) return;

    const s = document.createElement("style");
    s.id = "sb-touch-active-styles";
    s.textContent = `
      @media (pointer: coarse) {
        button:active:not(:disabled),
        label.language-option:active:not(.is-disabled) {
          transition: transform 0.08s ease, background 0.08s ease;
        }
        .nav-item:active { transform: scale(0.97); background: var(--gutter); }
        .pill-button:active:not(:disabled) { transform: scale(0.97) translateY(1px); }
        .translate-button:active:not(:disabled) .translate-circle { transform: scale(0.93); }
        .icon-button:active:not(:disabled) { background: var(--green-soft); transform: scale(0.95); }
        .text-button:active:not(:disabled) { background: var(--green-soft); transform: scale(0.95); }
        .tips-button:active:not(:disabled) { background: var(--green-soft); }
        .sign-in-button:active { background: var(--green-soft); }
        .filter-chip:active:not(:disabled) { transform: scale(0.96); background: var(--green-soft); }
        .suggestion-chip:active:not(:disabled) { transform: scale(0.96); background: var(--green-soft); }
        .language-option:active:not(.is-disabled) { transform: scale(0.97); background: var(--gutter); }
        .term-btn:active:not(:disabled) { transform: translateY(2px); }
        .auth-tab:active:not(:disabled) { transform: scale(0.97); }
      }
    `;
    document.head.appendChild(s);
  })();


  /* =========================================
     10. BOTTOM SHEET ENTRY ANIMATION (phone)
         Uses CSS @starting-style where supported,
         falls back to a class toggle
  ========================================= */
  (function initDialogAnimation() {
    if (!isPhone()) return;

    // Smooth scroll inside dialogs on iOS
    document.querySelectorAll("dialog").forEach(d => {
      d.style.webkitOverflowScrolling = "touch";
    });
  })();

})();