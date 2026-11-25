/* Dialog open / close wiring (Tips, Settings, Sign in). */
import { $ } from "../core/dom.js";
import { state } from "../core/state.js";
import { closeSidebar } from "./sidebar.js";

const isPhone = window.matchMedia("(max-width: 600px)");
const mobileDialogs = new Set();
let lockedScrollY = 0;

function lockMobileScroll(dialog) {
  if (!isPhone.matches) return;
  if (mobileDialogs.size === 0) {
    lockedScrollY = window.scrollY;
    document.body.style.setProperty("--dialog-scroll-top", `${-lockedScrollY}px`);
    document.body.classList.add("dialog-scroll-locked");
  }
  mobileDialogs.add(dialog);
}

function unlockMobileScroll(dialog) {
  if (!mobileDialogs.delete(dialog) || mobileDialogs.size > 0) return;
  document.body.classList.remove("dialog-scroll-locked");
  document.body.style.removeProperty("--dialog-scroll-top");
  window.scrollTo(0, lockedScrollY);
}

export function showAppDialog(dialog) {
  if (dialog.open) return;
  lockMobileScroll(dialog);
  try {
    dialog.showModal();
  } catch (error) {
    unlockMobileScroll(dialog);
    throw error;
  }
}

export function initDialogs() {
  document.querySelectorAll("[data-dialog]").forEach((button) => {
    button.addEventListener("click", () => {
      if (state.mobileOpen) closeSidebar(true);
      showAppDialog($(button.dataset.dialog));
    });
  });
  document.querySelectorAll("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("close", () => unlockMobileScroll(dialog));
    const handle = dialog.querySelector(".dialog-drag-handle");
    if (handle) {
      let pointerId = null;
      let startY = 0;
      let dragDistance = 0;
      let lastY = 0;
      let lastMoveTime = 0;

      const clearDragStyles = () => {
        dialog.removeAttribute("data-dragging");
        dialog.style.removeProperty("--dialog-close-duration");
        [
          "--dialog-drag-offset",
          "--dialog-drag-opacity",
          "--dialog-drag-scale",
          "--dialog-backdrop-opacity",
          "--dialog-handle-scale",
        ].forEach((property) => dialog.style.removeProperty(property));
      };

      handle.addEventListener("pointerdown", (event) => {
        if (!isPhone.matches || !dialog.open || !event.isPrimary ||
            (event.pointerType === "mouse" && event.button !== 0)) return;
        pointerId = event.pointerId;
        startY = event.clientY;
        lastY = startY;
        lastMoveTime = performance.now();
        dragDistance = 0;
        dialog.style.removeProperty("--dialog-close-offset");
        dialog.dataset.dragging = "";
        handle.setPointerCapture(pointerId);
        event.preventDefault();
      });

      handle.addEventListener("pointermove", (event) => {
        if (event.pointerId !== pointerId) return;
        dragDistance = Math.max(0, event.clientY - startY);
        const threshold = Math.max(90, dialog.clientHeight * 0.18);
        const progress = Math.min(1, dragDistance / threshold);
        const offset = dragDistance > threshold
          ? threshold + (dragDistance - threshold) * 0.45
          : dragDistance;
        dialog.style.setProperty("--dialog-drag-offset", `${offset}px`);
        dialog.style.setProperty("--dialog-drag-opacity", String(1 - progress * 0.12));
        dialog.style.setProperty("--dialog-drag-scale", String(1 - progress * 0.018));
        dialog.style.setProperty("--dialog-backdrop-opacity", String(1 - progress * 0.7));
        dialog.style.setProperty("--dialog-handle-scale", String(1 + progress * 0.65));
        lastY = event.clientY;
        lastMoveTime = performance.now();
      });

      const endDrag = (event, canClose) => {
        if (event.pointerId !== pointerId) return;
        dragDistance = Math.max(dragDistance, event.clientY - startY);
        const elapsed = Math.max(performance.now() - lastMoveTime, 1);
        const velocity = Math.max(0, event.clientY - lastY) / elapsed;
        const threshold = Math.max(90, dialog.clientHeight * 0.18);
        const shouldClose = canClose &&
          (dragDistance >= threshold || (dragDistance >= 48 && velocity >= 0.65));
        pointerId = null;
        clearDragStyles();
        if (shouldClose) {
          dialog.style.setProperty(
            "--dialog-close-duration",
            `${Math.max(140, Math.min(300, 280 - velocity * 100))}ms`
          );
          dialog.style.setProperty(
            "--dialog-close-offset",
            `${Math.max(dialog.clientHeight, dragDistance + 80)}px`
          );
          dialog.close();
        }
      };

      handle.addEventListener("pointerup", (event) => endDrag(event, true));
      handle.addEventListener("pointercancel", (event) => endDrag(event, false));
    }

    dialog.addEventListener("transitionend", (event) => {
      if (event.target === dialog && event.propertyName === "transform" && !dialog.open) {
        dialog.style.removeProperty("--dialog-close-offset");
        dialog.style.removeProperty("--dialog-close-duration");
      }
    });

    dialog.addEventListener("click", (event) => {
      const rect = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
    });
  });
}
