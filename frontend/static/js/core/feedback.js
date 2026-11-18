/* Toast notifications and the status line under the workspace. */
import { $, makeEl } from "./dom.js";

let toastTimer;
export function notify(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 3400);
}

// Plain one-line status (same behaviour as before).
export function setStatus(message, isError = false) {
  const el = $("statusMessage");
  el.textContent = message;
  el.classList.toggle("is-error", isError);
  el.classList.remove("is-working");
}

// Friendly status: { title, text, tip, details } -> title + explanation + suggestion (+ technical details).
export function setRichStatus(info, isError = true) {
  const el = $("statusMessage");
  el.classList.toggle("is-error", isError);
  el.classList.remove("is-working");
  const nodes = [];
  if (info.title) nodes.push(makeEl("span", "status-title", info.title));
  if (info.text) nodes.push(makeEl("span", "status-text", info.text));
  if (info.tip) {
    const tip = makeEl("span", "status-tip");
    tip.append(makeEl("strong", "", "What you can do: "), document.createTextNode(info.tip));
    nodes.push(tip);
  }
  if (info.details) {
    const box = makeEl("details", "status-details");
    box.append(makeEl("summary", "", "Show technical details"), makeEl("pre", "", info.details));
    nodes.push(box);
  }
  el.replaceChildren(...nodes);
  // The line sits under the page; if "Personalize" is open it can be below the fold.
  if (isError) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
