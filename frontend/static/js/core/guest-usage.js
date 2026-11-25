/* Guest counters are cached for the UI, but only the server can authorize an action. */
import { GUEST_ACTION_LIMIT, keys } from "./config.js";
import { state } from "./state.js";
import { writeStorage } from "./storage.js";
import { notify } from "./feedback.js";

const AUTH_READY_EVENT = "sb:auth-ready";

export function setGuestUsage(value) {
  if (!value || !Number.isInteger(value.translations) ||
      !Number.isInteger(value.compilations) || !Number.isInteger(value.limit)) {
    state.guestUsage = null;
    try { localStorage.removeItem(keys.guestUsage); } catch (_) { /* storage may be blocked */ }
    return;
  }
  state.guestUsage = {
    translations: Math.max(0, value.translations),
    compilations: Math.max(0, value.compilations),
    limit: Math.max(0, value.limit)
  };
  writeStorage(keys.guestUsage, state.guestUsage);
}

export function guestLimitMessage(action) {
  const label = action === "translations" ? "translation" : "compile/run";
  const limit = state.guestUsage?.limit || GUEST_ACTION_LIMIT;
  return `Guest ${label} limit reached (${limit}). Sign in or create an account to continue.`;
}

export async function ensureGuestActionAllowed(action) {
  if (state.user) return true;
  if (!state.authReady) {
    await new Promise((resolve) => {
      const onReady = () => resolve();
      document.addEventListener(AUTH_READY_EVENT, onReady, { once: true });
      if (state.authReady) {
        document.removeEventListener(AUTH_READY_EVENT, onReady);
        resolve();
      }
    });
  }
  if (state.user) return true;
  const usage = state.guestUsage;
  if (!usage) {
    notify("Guest usage could not be verified. Reconnect and refresh before trying again.");
    return false;
  }
  if (usage[action] >= usage.limit) {
    notify(guestLimitMessage(action));
    return false;
  }
  return true;
}
