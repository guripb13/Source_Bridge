/* Copy to clipboard and download of the translated code. */
import { $, dom } from "../core/dom.js";
import { extensionMap } from "../core/config.js";
import { state } from "../core/state.js";
import { notify } from "../core/feedback.js";

const { source, output } = dom;

async function copyText(text, button) {
  if (!text) return;
  try {
    try { await navigator.clipboard.writeText(text); }
    catch (_) {
      // Fallback for non-HTTPS local network development servers.
      const previous = document.activeElement;
      const temporary = document.createElement("textarea");
      temporary.value = text;
      temporary.className = "sr-only";
      document.body.appendChild(temporary);
      temporary.select();
      let copied = false;
      try { copied = document.execCommand("copy"); }
      finally { temporary.remove(); previous?.focus({ preventScroll: true }); }
      if (!copied) throw new Error("Clipboard unavailable");
    }
    const icon = button.querySelector("use");
    icon.setAttribute("href", "#i-check");
    notify("Code copied to clipboard.");
    setTimeout(() => icon.setAttribute("href", "#i-copy"), 1700);
  } catch (_) { notify("Couldn't copy automatically. Select the code and copy it manually."); }
}

function downloadName(translation) {
  const extension = extensionMap[translation.language.toLowerCase()] || "txt";
  let stem = translation.fileName ? translation.fileName.replace(/\.[^.]+$/, "") : "translated_code";
  stem = stem.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/, "").slice(0, 100) || "translated_code";
  // A Java public class needs a matching filename to compile.
  if (extension === "java") {
    const match = translation.output.match(/\bpublic\s+(?:(?:abstract|final|sealed|non-sealed)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/);
    if (match) stem = match[1];
  }
  return `${stem}.${extension}`;
}

export function initExport() {
  $("copySource").addEventListener("click", () => copyText(source.value, $("copySource")));
  $("copyOutput").addEventListener("click", () => copyText(output.value, $("copyOutput")));
  $("downloadButton").addEventListener("click", () => {
    if (!state.completedTranslation) return;
    const blob = new Blob([state.completedTranslation.output], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = downloadName(state.completedTranslation);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
