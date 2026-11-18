/* "Personalize the translation" box: free text plus suggestion chips.
 * The text travels as one extra form field (see translate.js). */
import { $ } from "../core/dom.js";
import { MAX_INSTRUCTIONS } from "../core/config.js";
import { notify } from "../core/feedback.js";

export const getInstructions = () => $("instructions").value.trim();

export function initInstructions() {
  const box = $("instructions");
  const chips = Array.from(document.querySelectorAll(".suggestion-chip"));

  function refresh() {
    const text = box.value;
    $("instructionsCount").textContent = `${text.length} / ${MAX_INSTRUCTIONS}`;
    $("instructionsClear").hidden = !text.trim();
    $("personalizeState").hidden = !text.trim();
    chips.forEach((chip) => chip.setAttribute("aria-pressed", String(text.includes(chip.dataset.text))));
  }

  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      const phrase = chip.dataset.text;
      if (box.value.includes(phrase)) {
        // Second click removes the suggestion again.
        box.value = box.value.replace(phrase, "").replace(/ {2,}/g, " ").replace(/^\s+|\s+$/g, "");
      } else {
        const joined = box.value.trim() ? `${box.value.trim()} ${phrase}` : phrase;
        if (joined.length > MAX_INSTRUCTIONS) { notify(`Instructions can be up to ${MAX_INSTRUCTIONS} characters.`); return; }
        box.value = joined;
      }
      refresh();
    });
  });
  box.addEventListener("input", refresh);
  $("instructionsClear").addEventListener("click", () => { box.value = ""; refresh(); box.focus(); });
  refresh();
}
