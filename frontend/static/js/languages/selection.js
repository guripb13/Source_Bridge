/* Language selection screen and the confirmed language pair shown in the workspace. */
import { $, dom } from "../core/dom.js";
import { logoUrl } from "../core/config.js";
import { state } from "../core/state.js";
import { setStatus } from "../core/feedback.js";
import { refreshButtons } from "../ui/buttons.js";
import { showView } from "../ui/navigation.js";
import { updateLines } from "../editor/line-numbers.js";
import { setHeadingLogo } from "./logos.js";
import { liveStops } from "../run/terminal.js";
import { cancelPanelAnim } from "../run/panel-animation.js";

const { source, output, language, sourceLanguage } = dom;

// The target list never offers the language the code is already written in.
export function updateTargetLanguageOptions() {
  const sourceValue = sourceLanguage.value.trim().toLowerCase();
  const options = Array.from(language.options);
  for (const option of options) {
    const same = option.value.trim().toLowerCase() === sourceValue;
    option.hidden = same;
    option.disabled = same;
  }
  if (language.selectedOptions[0]?.disabled) {
    const next = options.find((option) => !option.disabled);
    if (next) language.value = next.value;
  }
}
export function languageChanged() {
  updateTargetLanguageOptions();
  updateLanguageLabels();
  refreshButtons();
}

// Shows the confirmed pair in the workspace: centre column, panel badges and placeholders.
export function updateLanguageLabels() {
  const from = state.languagesConfirmed ? sourceLanguage.value : "";
  const to = state.languagesConfirmed ? language.value : "";
  $("sourceLanguageLabel").textContent = from || "Source";
  $("targetLanguageLabel").textContent = to || "Target";
  $("sourceLanguageBadge").textContent = from;
  $("sourceLanguageBadge").hidden = !from;
  $("targetLanguageBadge").textContent = to;
  $("targetLanguageBadge").hidden = !to;
  setHeadingLogo($("sourceLogo"), $("sourceTitle"), from);
  setHeadingLogo($("outputLogo"), $("outputTitle"), to);
  source.placeholder = from ? `Paste your ${from} code here...` : "Paste your code here...";
  output.placeholder = to ? `Your ${to} code will appear here...` : "Your translated code will appear here...";
}

// Step 1 picks the source language, step 2 the target. The chosen source is
// not offered as a target.
export function renderLanguageChoices() {
  document.querySelectorAll('input[name="sourceChoice"]').forEach((input) => {
    input.checked = input.value === state.pendingSource;
    input.closest(".language-option").classList.toggle("is-selected", input.checked);
  });
  document.querySelectorAll('input[name="targetChoice"]').forEach((input) => {
    const option = input.closest(".language-option");
    const isSource = input.value === state.pendingSource;
    input.disabled = !state.pendingSource || isSource;
    input.checked = !input.disabled && input.value === state.pendingTarget;
    option.classList.toggle("is-selected", input.checked);
    option.classList.toggle("is-disabled", input.disabled);
    option.title = isSource ? "Already selected as the source language" : "";
  });
  $("targetStep").classList.toggle("is-locked", !state.pendingSource);
  $("targetStepHelp").textContent = state.pendingSource ? `The language to translate your ${state.pendingSource} code into.` : "Select a source language first.";
  $("continueButton").disabled = !(state.pendingSource && state.pendingTarget);
  $("languagePrompt").textContent = !state.pendingSource ? "Start by selecting the language your code is written in." :
    !state.pendingTarget ? "Now select the language you want to translate into." :
    `${state.pendingSource} to ${state.pendingTarget}. Continue when you're ready.`;
}
// Opening the selection screen from the workspace preselects the current pair.
export function prepareLanguageView() {
  state.setupView = "languages";
  state.pendingSource = state.languagesConfirmed ? sourceLanguage.value : "";
  state.pendingTarget = state.languagesConfirmed && language.value !== state.pendingSource ? language.value : "";
      // Back is only offered on the first visit (it returns to the welcome screen)
  $("languageBack").hidden = state.languagesConfirmed;
  renderLanguageChoices();
}

export function initLanguages() {
  document.querySelectorAll('input[name="sourceChoice"]').forEach((input) => {
    input.addEventListener("change", () => {
      state.pendingSource = input.value;
      if (state.pendingTarget === state.pendingSource) state.pendingTarget = "";
      renderLanguageChoices();
    });
  });
  document.querySelectorAll('input[name="targetChoice"]').forEach((input) => {
    input.addEventListener("change", () => { state.pendingTarget = input.value; renderLanguageChoices(); });
  });
  // Same language logos the workspace used; an option simply shows no logo if the CDN is unreachable.
  document.querySelectorAll(".language-option").forEach((option) => {
    const url = logoUrl(option.querySelector("input").value);
    if (!url) return;
    const logo = new Image();
    logo.className = "language-option-icon";
    logo.alt = "";
    logo.setAttribute("aria-hidden", "true");
    logo.onerror = () => logo.remove();
    logo.src = url;
    option.insertBefore(logo, option.querySelector("span"));
  });
  $("getStartedButton").addEventListener("click", () => showView("languages"));
  $("languageBack").addEventListener("click", () => showView(state.languagesConfirmed ? "translate" : "welcome"));
  $("changeLanguages").addEventListener("click", () => { if (!state.activeController) showView("languages"); });
  $("continueButton").addEventListener("click", () => {
    if (!state.pendingSource || !state.pendingTarget || state.activeController) return;
    const hadLanguages = state.languagesConfirmed;
    const sourceChanged = !hadLanguages || sourceLanguage.value !== state.pendingSource;
    const targetChanged = !hadLanguages || language.value !== state.pendingTarget;
    sourceLanguage.value = state.pendingSource;
    updateTargetLanguageOptions();
    language.value = state.pendingTarget;
    state.languagesConfirmed = true;
    // A result in the previous target language no longer matches the workspace.
    if (hadLanguages && targetChanged && output.value) {
      const panel = $("outputRunOutput");
      const stopRun = liveStops.get(panel);
      if (stopRun) stopRun();
      cancelPanelAnim(panel);
      panel.hidden = true;
      panel.textContent = "";
      output.value = "";
      state.completedTranslation = null;
      updateLines(output, $("outputLines"));
    }
    languageChanged();
    showView("translate");
    if (sourceChanged || targetChanged) setStatus(source.value.trim() ? `Ready to translate ${sourceLanguage.value} to ${language.value}.` : "");
  });
}
