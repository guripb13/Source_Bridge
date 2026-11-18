/* Dialog open / close wiring (Tips, Settings, Credits, Sign in). */
import { $ } from "../core/dom.js";
import { state } from "../core/state.js";
import { closeSidebar } from "./sidebar.js";

export function initDialogs() {
  document.querySelectorAll("[data-dialog]").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.mobileOpen) closeSidebar(true);
      $(button.dataset.dialog).showModal();
    });
  });
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      const rect = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
    });
  });
}
