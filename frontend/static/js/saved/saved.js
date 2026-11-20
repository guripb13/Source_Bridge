/* Saved view: rendering the list, opening an entry, and the bookmark (save / unsave) button.
 *
 * Two sources, one screen:
 *   visitors   -> translations kept in this browser (localStorage, up to 30)
 *   signed in  -> translations bookmarked on the server (follows the account to any device)
 */
import { $, dom, makeEl, makeIcon } from "../core/dom.js";
import { state } from "../core/state.js";
import { notify, setStatus, setRichStatus } from "../core/feedback.js";
import { addSaved, findSaved, isFull, removeSavedById } from "./store.js";
import { fetchTranslation, refreshCloudSaved, setCloudSaved, syncOpenTranslation } from "./cloud.js";
import { refreshButtons } from "../ui/buttons.js";
import { updateLines } from "../editor/line-numbers.js";
import { showView } from "../ui/navigation.js";
import { updateTargetLanguageOptions, languageChanged } from "../languages/selection.js";
import { updateFileLabel } from "../files/upload.js";
import { explainTranslationError } from "../translate/errors.js";

const { source, output, language, sourceLanguage } = dom;

const SIGNED_OUT_INTRO = "Code you choose to keep, saved in this browser. Sign in to keep it with your account instead.";
const SIGNED_IN_INTRO = "Translations you bookmarked, kept with your account on any device.";

const formatDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Saved translation" : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};
const firstLine = (text) => String(text || "").split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 70) || "Untitled translation";

/* ---- one card shape for both sources ---- */
function localCards() {
  return state.saved.map((entry) => {
    const title = typeof entry.fileName === "string" && entry.fileName ? entry.fileName : firstLine(entry.source);
    return {
      key: entry.id, title, language: entry.language, date: formatDate(entry.createdAt),
      preview: entry.output.slice(0, 240),
      openLabel: "Open translation",
      open: async () => openSaved(entry),
      removeLabel: `Delete saved translation: ${title}`, removeTitle: "Delete saved translation",
      remove: async () => {
        const persisted = removeSavedById(entry.id);
        renderSaved(); refreshButtons();
        notify(persisted ? "Saved translation removed." : "Removed for this session. Browser storage couldn't be updated.");
      }
    };
  });
}

function cloudCards() {
  return state.cloudSaved.map((item) => {
    const title = firstLine(item.source_preview);
    return {
      key: item.id, title,
      language: item.source_language ? `${item.source_language} → ${item.target_language}` : item.target_language,
      date: formatDate(item.saved_at || item.created_at),
      preview: String(item.target_preview || "").slice(0, 240),
      openLabel: "Open translation",
      open: async () => {
        if (state.activeController) { notify("Stop the current translation before opening a saved one."); return; }
        try { openFromServer(await fetchTranslation(item.id)); }
        catch (error) { notify(error.message); }
      },
      removeLabel: `Remove from Saved: ${title}`, removeTitle: "Remove from Saved (it stays in your history)",
      remove: async () => {
        try {
          await setCloudSaved(item.id, false);
          state.cloudSaved = state.cloudSaved.filter((entry) => entry.id !== item.id);
          syncOpenTranslation(item.id, { isSaved: false });
          renderSaved(); refreshButtons();
          notify("Removed from Saved. It stays in your history.");
        } catch (error) { notify(error.message); }
      }
    };
  });
}

export function renderSaved() {
  const cards = state.user ? cloudCards() : localCards();
  $("savedCount").textContent = String(cards.length);
  $("savedCount").hidden = cards.length === 0;
  $("savedEmpty").hidden = cards.length !== 0;
  $("savedIntro").textContent = state.user ? SIGNED_IN_INTRO : SIGNED_OUT_INTRO;
  const fragment = document.createDocumentFragment();
  cards.forEach((card) => {
    const article = makeEl("article", "saved-card");
    const top = makeEl("div", "saved-card-top");
    top.append(makeEl("span", "saved-language", card.language), makeEl("span", "saved-date", card.date));
    const actions = makeEl("div", "saved-card-actions");
    const openButton = makeEl("button", "text-button saved-open", card.openLabel);
    openButton.type = "button";
    openButton.appendChild(makeIcon("arrow"));
    openButton.addEventListener("click", async () => {
      openButton.disabled = true;
      try { await card.open(); } finally { openButton.disabled = false; }
    });
    const removeButton = makeEl("button", "icon-button delete-saved");
    removeButton.type = "button";
    removeButton.setAttribute("aria-label", card.removeLabel);
    removeButton.title = card.removeTitle;
    removeButton.appendChild(makeIcon("trash"));
    removeButton.addEventListener("click", async () => {
      removeButton.disabled = true;
      try { await card.remove(); } finally { removeButton.disabled = false; }
    });
    actions.append(openButton, removeButton);
    article.append(top, makeEl("h2", "", card.title), makeEl("pre", "saved-preview", card.preview), actions);
    fragment.appendChild(article);
  });
  $("savedList").replaceChildren(fragment);
}

/* ---- putting a translation back into the workspace (Saved and History both use this) ---- */
/* entry: { source, output, language, sourceLanguage, fileName, translationId?, isSaved? }
 * Returns false when it could not be opened. */
export function loadIntoWorkspace(entry, statusText) {
  if (state.activeController) { notify("Stop the current translation before opening another one."); return false; }
  state.fileReadVersion += 1;
  source.value = entry.source;
  output.value = entry.output;
  state.sourceFileName = typeof entry.fileName === "string" ? entry.fileName : "";
  state.uploadedText = state.sourceFileName ? entry.source : "";
  const hasOption = (select, value) => Array.from(select.options).some((option) => option.value === value);
  if (typeof entry.sourceLanguage === "string" && hasOption(sourceLanguage, entry.sourceLanguage)) sourceLanguage.value = entry.sourceLanguage;
  updateTargetLanguageOptions();
  language.value = hasOption(language, entry.language) ? entry.language : "Python";
  // Only a finished translation can be run, downloaded or bookmarked.
  state.completedTranslation = entry.output ? { ...entry, fileName: state.sourceFileName } : null;
  state.languagesConfirmed = true;
  source.scrollTop = 0; output.scrollTop = 0;
  languageChanged(); updateFileLabel();
  updateLines(source, $("sourceLines")); updateLines(output, $("outputLines"));
  showView("translate");
  if (statusText) setStatus(statusText);
  return true;
}

function openSaved(entry) {
  loadIntoWorkspace(entry, `Saved ${entry.language} translation opened.`);
}

/* A full row from GET /translations/<id>: finished, failed or still pending. */
export function openFromServer(row) {
  const finished = row.status === "completed" && typeof row.target_code === "string";
  const opened = loadIntoWorkspace({
    source: row.source_code,
    output: finished ? row.target_code : "",
    language: row.target_language,
    sourceLanguage: row.source_language || "",
    fileName: "",
    translationId: row.id,
    isSaved: Boolean(row.is_saved)
  });
  if (!opened) return;
  if (finished) setStatus(`${row.target_language} translation from your history opened.`);
  else if (row.status === "failed") {
    // Same friendly explanation the page shows right after a failed translation.
    setRichStatus(explainTranslationError(Object.assign(new Error(row.error_message || ""), { kind: "server" })), true);
  } else setStatus("This translation never finished. Your source code is back in the editor.");
}

/* ---- the bookmark button above the translated code ---- */
let bookmarkBusy = false;

async function toggleServerBookmark(translation) {
  if (!translation.translationId) {
    notify("This translation wasn't recorded, so it can't be saved to your account. Translate again to save it.");
    return;
  }
  if (bookmarkBusy) return;
  bookmarkBusy = true;
  $("saveButton").disabled = true;
  const wanted = !translation.isSaved;
  try {
    await setCloudSaved(translation.translationId, wanted);
    translation.isSaved = wanted;
    await refreshCloudSaved();
    renderSaved();
    notify(wanted ? "Saved to your account." : "Removed from Saved. It stays in your history.");
  } catch (error) {
    notify(error.message);                         // e.g. "You can keep up to 100 saved translations."
  } finally {
    bookmarkBusy = false;
    refreshButtons();
  }
}

export function initSaved() {
  $("saveButton").addEventListener("click", () => {
    if (!state.completedTranslation || state.activeController) return;
    if (state.user) { toggleServerBookmark(state.completedTranslation); return; }
    // Visitors: first click saves in this browser, clicking the filled bookmark again removes it.
    const existing = findSaved(state.completedTranslation);
    if (existing) {
      const persisted = removeSavedById(existing.id);
      renderSaved(); refreshButtons();
      notify(persisted ? "Removed from Saved." : "Removed for this session. Browser storage couldn't be updated.");
      return;
    }
    if (isFull()) { notify("Your 30 saved slots are full. Remove a translation to save another."); return; }
    const persisted = addSaved(state.completedTranslation);
    renderSaved(); refreshButtons();
    notify(persisted ? "Translation saved in this browser. Sign in to keep it with your account." : "Saved for this session. Browser storage is unavailable or full.");
  });

  // Signing in or out switches which list "Saved" shows.
  document.addEventListener("sb:auth", async (event) => {
    const { user, previous } = event.detail;
    // A translation shown in the workspace belongs to the previous account (or to nobody).
    if (state.completedTranslation && previous?.id !== user?.id) {
      state.completedTranslation.translationId = null;
      state.completedTranslation.isSaved = false;
    }
    renderSaved(); refreshButtons();
    if (user) {
      await refreshCloudSaved();
      renderSaved(); refreshButtons();
    }
  });
}
