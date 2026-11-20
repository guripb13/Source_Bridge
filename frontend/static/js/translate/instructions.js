/* "Personalize the translation" box: free text plus suggestion chips.
 * The text travels as one extra form field (see translate.js). */
import { $ } from "../core/dom.js";
import { MAX_INSTRUCTIONS } from "../core/config.js";
import { notify } from "../core/feedback.js";

export const getInstructions = () => $("instructions").value.trim();

export function initInstructions() {
  const box = $("instructions");
  const personalize = $("personalize");
  const personalizeSummary = personalize.querySelector("summary");
  const personalizeBody = personalize.querySelector(".personalize-body");
  const chips = Array.from(document.querySelectorAll(".suggestion-chip"));
  let targetOpen = personalize.open;
  let animation = null;

  function scrollToInstructions() {
    requestAnimationFrame(() => {
      box.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    });
  }

  personalizeSummary.addEventListener("click", (event) => {
    event.preventDefault();
    const fromHeight = personalizeBody.getBoundingClientRect().height;
    const fromOpacity = fromHeight ? Number.parseFloat(getComputedStyle(personalizeBody).opacity) : 0;
    if (animation) animation.cancel();
    targetOpen = !targetOpen;

    if (targetOpen) personalize.open = true;
    personalize.classList.toggle("is-closing", !targetOpen);

    if (typeof personalizeBody.animate !== "function") {
      personalize.open = targetOpen;
      personalize.classList.remove("is-closing");
      personalizeBody.style.height = "";
      personalizeBody.style.overflow = "";
      animation = null;
      if (targetOpen) scrollToInstructions();
      return;
    }

    const toHeight = targetOpen ? personalizeBody.scrollHeight : 0;
    const opening = targetOpen;
    personalizeBody.style.height = `${fromHeight}px`;
    personalizeBody.style.overflow = "hidden";
    animation = personalizeBody.animate(
      [
        { height: `${fromHeight}px`, opacity: fromOpacity },
        { height: `${toHeight}px`, opacity: opening ? 1 : 0 }
      ],
      {
        duration: opening ? 520 : 440,
        easing: opening ? "cubic-bezier(.22, .61, .36, 1)" : "cubic-bezier(.4, 0, .2, 1)"
      }
    );
    const currentAnimation = animation;
    currentAnimation.onfinish = () => {
      if (animation !== currentAnimation) return;
      animation = null;
      personalize.open = opening;
      personalize.classList.remove("is-closing");
      personalizeBody.style.height = "";
      personalizeBody.style.overflow = "";
      if (opening) scrollToInstructions();
    };
  });

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
