/* Server side of "Saved" and "History" for signed-in users (backend /translations routes).
 * No DOM here: callers decide what to re-render. */
import { endpoints } from "../core/config.js";
import { state } from "../core/state.js";
import { api } from "../account/api.js";

const url = (id, suffix = "") => `${endpoints.translations}/${Number(id)}${suffix}`;

/* Reload the bookmarked list (the server allows at most 100 saved, so one request is enough).
 * Returns true when the list is up to date. */
export async function refreshCloudSaved() {
  const user = state.user;
  if (!user) { state.cloudSaved = []; return true; }
  try {
    const data = await api("GET", `${endpoints.translations}?saved=1&limit=100`);
    if (state.user !== user) return false;               // signed out / switched account while waiting
    state.cloudSaved = Array.isArray(data.translations) ? data.translations : [];
    return true;
  } catch (_) {
    return false;
  }
}

export async function fetchTranslation(id) {
  const data = await api("GET", url(id));
  return data.translation;
}
export const setCloudSaved = (id, saved) => api("POST", url(id, "/save"), { saved });
export const deleteCloudTranslation = (id) => api("DELETE", url(id));

/* The translation currently shown in the workspace may be the one that was just changed
 * in a list. Keep its bookmark / link state honest. */
export function syncOpenTranslation(id, patch) {
  const open = state.completedTranslation;
  if (open && open.translationId === id) Object.assign(open, patch);
}
