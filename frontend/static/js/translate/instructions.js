/* "Personalize the translation" box: free text plus suggestion chips.
 * The text travels as one extra form field (see translate.js). */
import { $ } from "../core/dom.js";
import { MAX_INSTRUCTIONS } from "../core/config.js";
import { notify } from "../core/feedback.js";

export const getInstructions = () => $("instructions").value.trim();

export function initInstructions() {
  const box = $("instructions");
  const personalize = $("personalize");
  const toggle = $("personalizeToggle");
  const panel = $("personalizePanel");
  const chips = Array.from(document.querySelectorAll(".suggestion-chip"));
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let scrollTimer = 0;
  let targetLanguage = "";

  /* The panel slides with a CSS transition (see personalize.css); this only flips the state.
   * `inert` keeps the hidden fields out of the tab order while the panel is closed. */
  function setOpen(open) {
    personalize.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    panel.inert = !open;
    clearTimeout(scrollTimer);
    if (open) {
      // Once it has finished sliding open, make sure the whole panel (chips, text box, counter) is on screen.
      scrollTimer = setTimeout(() => personalize.scrollIntoView({ behavior: "smooth", block: "nearest" }),
        reduceMotion.matches ? 0 : 460);
    }
  }

  /* Phones: the same controls (same elements, so nothing is lost) live in a bottom sheet that the
   * "Personalize" button opens. Wider screens keep them in the sliding panel. */
  const content = $("personalizeContent");
  const phone = window.matchMedia("(max-width: 600px)");
  function placeContent() {
    if (phone.matches) {
      $("personalizeSheetSlot").append(content);
    } else {
      const sheet = $("personalizeDialog");
      if (sheet.open) sheet.close();
      $("personalizeInlineSlot").append(content);
    }
  }
  phone.addEventListener("change", placeContent);
  placeContent();

  toggle.addEventListener("click", () => setOpen(!personalize.classList.contains("is-open")));
  setOpen(false);

  function refresh() {
    const text = box.value;
    $("instructionsCount").textContent = `${text.length} / ${MAX_INSTRUCTIONS}`;
    $("instructionsClear").hidden = !text.trim();
    $("personalizeState").hidden = !text.trim();
    $("personalizeDot").hidden = !text.trim();            // phone button: a dot when instructions are set
    $("personalizeOpen").classList.toggle("is-active", Boolean(text.trim()));
    chips.forEach((chip) => chip.setAttribute("aria-pressed", String(text.includes(chip.dataset.text))));
  }

  function setTargetLanguage(language) {
    const nextLanguage = String(language || "").trim().toLowerCase();
    if (targetLanguage && targetLanguage !== nextLanguage) {
      chips.filter((chip) => chip.dataset.targetLanguage === targetLanguage).forEach((chip) => {
        const phrase = chip.dataset.text;
        if (box.value.includes(phrase)) {
          box.value = box.value.replace(phrase, "").replace(/ {2,}/g, " ").trim();
        }
      });
    }
    targetLanguage = nextLanguage;
    chips.forEach((chip) => {
      const requiredLanguage = chip.dataset.targetLanguage;
      chip.hidden = Boolean(requiredLanguage && requiredLanguage !== targetLanguage);
    });
    refresh();
  }

  document.addEventListener("sb:language-changed", (event) => {
    setTargetLanguage(event.detail?.targetLanguage);
  });

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
  setTargetLanguage("");
}