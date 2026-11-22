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

  /* The panel slides with a CSS transition (see personalize.css); this only flips the state.
   * `inert` keeps the hidden fields out of the tab order while the panel is closed. */
  function setOpen(open) {
    personalize.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    panel.inert = !open;
    clearTimeout(scrollTimer);
    if (open) {
      // Once it has finished sliding open, make sure the text box is on screen.
      scrollTimer = setTimeout(() => box.scrollIntoView({ behavior: "smooth", block: "nearest" }),
        reduceMotion.matches ? 0 : 460);
    }
  }

  toggle.addEventListener("click", () => setOpen(!personalize.classList.contains("is-open")));
  setOpen(false);

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