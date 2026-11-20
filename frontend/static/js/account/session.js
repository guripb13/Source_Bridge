/* Who is signed in. The single source of truth is state.user, which mirrors the server's answer.
 *
 * Every change is announced with a document event so other modules can react without importing
 * each other:   document.addEventListener("sb:auth", (e) => e.detail.user)   // user or null
 *
 * Passwords are only ever passed straight into a request. They are never stored, logged or kept
 * in a variable that outlives the call.
 */
import { endpoints } from "../core/config.js";
import { state } from "../core/state.js";
import { notify } from "../core/feedback.js";
import { api, onUnauthorized } from "./api.js";

function setUser(user) {
  const previous = state.user;
  state.user = user || null;
  if (!state.user) { state.cloudSaved = []; }
  document.dispatchEvent(new CustomEvent("sb:auth", { detail: { user: state.user, previous } }));
}

/* Ask the server who we are (page load, and after a result that was not recorded). */
export async function loadSession() {
  try {
    const data = await api("GET", endpoints.me);
    setUser(data.authenticated ? data.user : null);
  } catch (_) {
    // Offline or server down: stay in "visitor" mode. Translating still works.
    setUser(null);
  } finally {
    state.authReady = true;
  }
}

export async function signIn(identifier, password) {
  const data = await api("POST", endpoints.login, { identifier, password }, { credentialsCheck: true });
  setUser(data.user);
  return data.user;
}

export async function signUp({ username, email, password }) {
  const data = await api("POST", endpoints.signup, { username, email, password }, { credentialsCheck: true });
  setUser(data.user);
  return data.user;
}

/* If the request fails the cookie is still valid, so we must NOT pretend to be signed out. */
export async function signOut() {
  await api("POST", endpoints.logout, {}, { credentialsCheck: true });
  setUser(null);
}

export async function deleteAccount(password) {
  await api("DELETE", endpoints.account, { password }, { credentialsCheck: true });
  setUser(null);
}

/* A protected route said 401 while we thought we were signed in: the session ended. */
onUnauthorized(() => {
  if (!state.user) return;
  setUser(null);
  notify("Your session ended. Please sign in again.");
});
