/* Enabled / disabled state of every action button, and the translating (loading) state. */
import { $, dom } from "../core/dom.js";
import { state } from "../core/state.js";
import { isSaved } from "../saved/store.js";

const { source, output, language, sourceLanguage, translateButton } = dom;

export function targetLanguage() { return language.value.trim(); }

export function refreshButtons() {
  const loading = Boolean(state.activeController);
  translateButton.disabled = !loading && (!source.value.trim() || !targetLanguage());
  $("copySource").disabled = !source.value;
  $("runSource").disabled = loading || !source.value.trim();
  $("runOutput").disabled = loading || !output.value.trim();
  $("copyOutput").disabled = !output.value;
  $("downloadButton").disabled = !state.completedTranslation || loading;
  $("saveButton").disabled = !state.completedTranslation || loading;
  // The bookmark is a toggle: filled = this translation is in Saved, click again to remove it.
  const alreadySaved = Boolean(state.completedTranslation && isSaved(state.completedTranslation));
  $("saveButton").classList.toggle("is-saved", alreadySaved);
  $("saveButton").setAttribute("aria-pressed", String(alreadySaved));
  $("saveButton").title = state.user
    ? (alreadySaved ? "Saved to your account. Click to remove from Saved" : "Save translation to your account")
    : (alreadySaved ? "Saved. Click to remove from Saved" : "Save translation in this browser");
  $("saveButton").setAttribute("aria-label", $("saveButton").title);
}

export function setLoading(loading) {
  document.body.classList.toggle("is-translating", loading);
  document.querySelector(".output-card").setAttribute("aria-busy", String(loading));
  source.readOnly = loading;
  language.disabled = loading;
  sourceLanguage.disabled = loading;
  $("changeLanguages").disabled = loading;
  $("uploadButton").disabled = loading;
  $("attachment").disabled = loading;
  $("removeFile").disabled = loading;
  $("instructions").disabled = loading;
  document.querySelectorAll(".suggestion-chip").forEach((chip) => { chip.disabled = loading; });
  $("translateLabel").textContent = loading ? "Stop" : "Translate";
  translateButton.setAttribute("aria-label", loading ? "Stop translation" : "Translate code");
  refreshButtons();
}
