/* "Something is happening" text shown inside the empty output editor while a translation runs.
 * These are illustrative stages, not real server progress: the server streams the result
 * without reporting steps. The text stops on the last stage and hides when code arrives. */
import { $ } from "../core/dom.js";

const STAGES = ["Analyzing code…", "Processing structure…", "Resolving syntax…", "Preparing translated output…"];
const STEP_MS = 1700;
let timer = 0;

function show(index) {
  const text = $("translateProgressText");
  text.textContent = STAGES[index];
  text.classList.remove("is-swapping");
  void text.offsetWidth;                 // restart the fade
  text.classList.add("is-swapping");
}

export function startProgress() {
  stopProgress();
  let index = 0;
  $("translateProgress").hidden = false;
  show(index);
  timer = setInterval(() => {
    if (index >= STAGES.length - 1) { clearInterval(timer); timer = 0; return; }
    show(++index);
  }, STEP_MS);
}

export function stopProgress() {
  clearInterval(timer);
  timer = 0;
  $("translateProgress").hidden = true;
}
