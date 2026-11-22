/* Sidebar: desktop icon rail, mobile drawer, and "hover a while to open" on the collapsed rail. */
import { $, dom } from "../core/dom.js";
import { keys } from "../core/config.js";
import { state } from "../core/state.js";
import { writeStorage } from "../core/storage.js";

export const mobileQuery = window.matchMedia("(max-width: 900px)");
const { sidebar, sidebarToggle } = dom;

// The mobile drawer always starts closed, irrespective of the desktop preference.
export function updateSidebar() {
  const mobile = mobileQuery.matches;
  document.body.classList.toggle("sidebar-collapsed", !mobile && state.desktopCollapsed);
  document.body.classList.toggle("sidebar-open", mobile && state.mobileOpen);
 
  sidebar.inert = mobile && !state.mobileOpen;
  if (mobile && !state.mobileOpen) sidebar.setAttribute("aria-hidden", "true");
  else sidebar.removeAttribute("aria-hidden");
  const expanded = mobile ? state.mobileOpen : !state.desktopCollapsed;
  const label = mobile ? (state.mobileOpen ? "Close navigation" : "Open navigation") :
    (state.desktopCollapsed ? "Expand sidebar" : "Collapse sidebar");
  sidebarToggle.setAttribute("aria-expanded", String(expanded));
  sidebarToggle.setAttribute("aria-label", label);
  sidebarToggle.title = label;
  // Keep page controls outside the mobile drawer out of the keyboard order.
  $("mainContent").inert = mobile && state.mobileOpen;
  document.querySelector(".header-actions").inert = mobile && state.mobileOpen;
  document.querySelector(".brand").inert = mobile && state.mobileOpen;
}

export function closeSidebar(returnFocus = false) {
  state.mobileOpen = false;
  updateSidebar();
  if (returnFocus) sidebarToggle.focus();
}

// ---- Hover-to-open on the collapsed rail ----
const PEEK_DELAY_MS = 650;
const PEEK_PREVIEW_DELAY_MS = 500;
let peekTimer = 0;
function endPeek() {
  clearTimeout(peekTimer);
  document.body.classList.remove("sidebar-peek-pending");
  document.body.classList.remove("sidebar-peek");
}

export function initSidebar() {
  sidebarToggle.addEventListener("click", () => {
    if (mobileQuery.matches) {
      state.mobileOpen = !state.mobileOpen;
      updateSidebar();
      if (state.mobileOpen) $("sidebarClose").focus();
    } else {
      state.desktopCollapsed = !state.desktopCollapsed;
      writeStorage(keys.sidebar, state.desktopCollapsed);
      endPeek();
      updateSidebar();
    }
  });
  $("sidebarClose").addEventListener("click", () => closeSidebar(true));
  $("sidebarBackdrop").addEventListener("click", () => closeSidebar(true));
  mobileQuery.addEventListener("change", () => {
    const focusWasInside = sidebar.contains(document.activeElement);
    state.mobileOpen = false;
    updateSidebar();
    if (mobileQuery.matches && focusWasInside) sidebarToggle.focus();
  });

  document.addEventListener("keydown", (event) => {
    if (!mobileQuery.matches || !state.mobileOpen) return;
    if (event.key === "Escape") { event.preventDefault(); closeSidebar(true); }
    if (event.key === "Tab") {
      const items = [sidebarToggle, ...sidebar.querySelectorAll("button:not(:disabled)")];
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });

  // Mouse only: touch has the drawer, keyboards have the toggle button.
  sidebar.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "mouse" || mobileQuery.matches || !state.desktopCollapsed) return;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {
      if (!state.desktopCollapsed || mobileQuery.matches) return;
      document.body.classList.add("sidebar-peek-pending");
      peekTimer = setTimeout(() => {
        document.body.classList.remove("sidebar-peek-pending");
        if (state.desktopCollapsed && !mobileQuery.matches) document.body.classList.add("sidebar-peek");
      }, PEEK_DELAY_MS);
    }, PEEK_PREVIEW_DELAY_MS);
  });
  sidebar.addEventListener("pointerleave", endPeek);
  mobileQuery.addEventListener("change", endPeek);
}
