/* Saved translations: the list, its persistence, and add / remove / lookup. No DOM here. */
import { keys, MAX_SAVED } from "../core/config.js";
import { state } from "../core/state.js";
import { writeStorage } from "../core/storage.js";

const same = (entry, t) => entry.source === t.source && entry.output === t.output && entry.language === t.language;

export const findSaved = (translation) => state.saved.find((entry) => same(entry, translation));
export const isSaved = (translation) => Boolean(findSaved(translation));
export const isFull = () => state.saved.length >= MAX_SAVED;

export function addSaved(translation) {
  state.saved.unshift({
    ...translation,
    id: window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt: new Date().toISOString()
  });
  return writeStorage(keys.saved, state.saved);
}

export function removeSavedById(id) {
  state.saved = state.saved.filter((item) => item.id !== id);
  return writeStorage(keys.saved, state.saved);
}
