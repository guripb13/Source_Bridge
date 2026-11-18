/* Saved view: rendering the list, opening an entry, and the bookmark (save / unsave) button. */
import { $, dom, makeEl, makeIcon } from "../core/dom.js";
import { state } from "../core/state.js";
import { notify, setStatus } from "../core/feedback.js";
import { addSaved, findSaved, isFull, removeSavedById } from "./store.js";
import { refreshButtons } from "../ui/buttons.js";
import { updateLines } from "../editor/line-numbers.js";
import { updateSourceRunHint } from "../editor/source-input.js";
import { showView } from "../ui/navigation.js";
import { updateTargetLanguageOptions, languageChanged } from "../languages/selection.js";
import { updateFileLabel } from "../files/upload.js";

const { source, output, language, sourceLanguage } = dom;

export function renderSaved() {
  $("savedCount").textContent = String(state.saved.length);
  $("savedCount").hidden = state.saved.length === 0;
  $("savedEmpty").hidden = state.saved.length !== 0;
  const fragment = document.createDocumentFragment();
  state.saved.forEach((entry) => {
    const card = makeEl("article", "saved-card");
    const top = makeEl("div", "saved-card-top");
    const date = new Date(entry.createdAt);
    const formattedDate = Number.isNaN(date.getTime()) ? "Saved translation" : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    top.append(makeEl("span", "saved-language", entry.language), makeEl("span", "saved-date", formattedDate));
    const title = typeof entry.fileName === "string" && entry.fileName ? entry.fileName : entry.source.trim().split("\n")[0].slice(0, 70) || "Untitled translation";
    const actions = makeEl("div", "saved-card-actions");
    const openButton = makeEl("button", "text-button saved-open", "Open translation");
    openButton.type = "button";
    openButton.appendChild(makeIcon("arrow"));
    openButton.addEventListener("click", () => openSaved(entry));
    const deleteButton = makeEl("button", "icon-button delete-saved");
    deleteButton.type = "button";
    deleteButton.setAttribute("aria-label", `Delete saved translation: ${title}`);
    deleteButton.title = "Delete saved translation";
    deleteButton.appendChild(makeIcon("trash"));
    deleteButton.addEventListener("click", () => {
      const persisted = removeSavedById(entry.id);
      renderSaved(); refreshButtons();
      notify(persisted ? "Saved translation removed." : "Removed for this session. Browser storage couldn't be updated.");
    });
    actions.append(openButton, deleteButton);
    card.append(top, makeEl("h2", "", title), makeEl("pre", "saved-preview", entry.output.slice(0, 240)), actions);
    fragment.appendChild(card);
  });
  $("savedList").replaceChildren(fragment);
}

function openSaved(entry) {
  if (state.activeController) { notify("Stop the current translation before opening a saved one."); return; }
  state.fileReadVersion += 1;
  source.value = entry.source;
  updateSourceRunHint();
  output.value = entry.output;
  state.sourceFileName = typeof entry.fileName === "string" ? entry.fileName : "";
  state.uploadedText = state.sourceFileName ? entry.source : "";
  const hasOption = (select, value) => Array.from(select.options).some((option) => option.value === value);
  if (typeof entry.sourceLanguage === "string" && hasOption(sourceLanguage, entry.sourceLanguage)) sourceLanguage.value = entry.sourceLanguage;
  updateTargetLanguageOptions();
  language.value = hasOption(language, entry.language) ? entry.language : "Python";
  state.completedTranslation = { ...entry, fileName: state.sourceFileName };
  state.languagesConfirmed = true;
  source.scrollTop = 0; output.scrollTop = 0;
  languageChanged(); updateFileLabel();
  updateLines(source, $("sourceLines")); updateLines(output, $("outputLines"));
  showView("translate");
  setStatus(`Saved ${entry.language} translation opened.`);
}

export function initSaved() {
  // Bookmark toggle: first click saves, clicking the filled bookmark again removes it.
  $("saveButton").addEventListener("click", () => {
    if (!state.completedTranslation || state.activeController) return;
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
    notify(persisted ? "Translation saved in this browser." : "Saved for this session. Browser storage is unavailable or full.");
  });
}
