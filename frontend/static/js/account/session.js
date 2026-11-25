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
import { setGuestUsage } from "../core/guest-usage.js";
import { api, onUnauthorized } from "./api.js";

function setUser(user) {
  const previous = state.user;
  state.user = user || null;
  if (state.user) setGuestUsage(null);
  if (!state.user) { state.cloudSaved = []; }
  document.dispatchEvent(new CustomEvent("sb:auth", { detail: { user: state.user, previous } }));
}

/* "Keep me signed in" was unticked: remember that in this tab, so that the next page load (a refresh)
 * can end the login by itself. sessionStorage survives a refresh but not a closed tab. */
const NO_REMEMBER_KEY = "sb:signedInWithoutRemember";

function markRemember(remember) {
  try {
    if (remember) sessionStorage.removeItem(NO_REMEMBER_KEY);
    else sessionStorage.setItem(NO_REMEMBER_KEY, "1");
  } catch (_) { /* storage blocked: the server-side rule still applies */ }
}

function wasSignedInWithoutRemember() {
  try { return sessionStorage.getItem(NO_REMEMBER_KEY) === "1"; } catch (_) { return false; }
}

/* Ask the server who we are (page load, and after a result that was not recorded). */
export async function loadSession() {
  try {
    const data = await api("GET", endpoints.me);
    setGuestUsage(data.guest_usage);
    if (data.authenticated && (data.remember === false || wasSignedInWithoutRemember())) {
      // A sign-in without "Keep me signed in" never survives a page load: drop the cookie on the
      // server (the login cookie is HttpOnly, so only the server can remove it) and show signed out.
      try {
        const signedOut = await api("POST", endpoints.logout, {}, { credentialsCheck: true });
        setGuestUsage(signedOut.guest_usage);
      } catch (_) { /* still show signed out */ }
      markRemember(true);
      setUser(null);
    } else {
      setUser(data.authenticated ? data.user : null);
    }
  } catch (_) {
    // Guest actions remain blocked until the server can confirm their quota.
    setUser(null);
  } finally {
    state.authReady = true;
    document.dispatchEvent(new Event("sb:auth-ready"));
  }
}

/* `remember` = "Keep me signed in on this device": true -> stays signed in for 30 days,
 * false -> signed out when the browser is closed. */
export async function signIn(identifier, password, remember = true) {
  const data = await api("POST", endpoints.login, { identifier, password, remember }, { credentialsCheck: true });
  markRemember(remember);
  setUser(data.user);
  return data.user;
}

export async function signUp({ username, email, password, remember = true }) {
  const data = await api("POST", endpoints.signup, { username, email, password, remember }, { credentialsCheck: true });
  markRemember(remember);
  setUser(data.user);
  return data.user;
}

/* If the request fails the cookie is still valid, so we must NOT pretend to be signed out. */
export async function signOut() {
  const data = await api("POST", endpoints.logout, {}, { credentialsCheck: true });
  setGuestUsage(data.guest_usage);
  markRemember(true);
  setUser(null);
}

export async function deleteAccount(password) {
  const data = await api("DELETE", endpoints.account, { password }, { credentialsCheck: true });
  setGuestUsage(data.guest_usage);
  setUser(null);
}

/* A protected route said 401 while we thought we were signed in: the session ended. */
onUnauthorized(() => {
  if (!state.user) return;
  setUser(null);
  notify("Your session ended. Please sign in again.");
});