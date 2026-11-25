/* Translate button: builds the request, streams the NDJSON reply into the output editor, reports errors. */
import { $, dom } from "../core/dom.js";
import { INSTRUCTIONS_FIELD } from "../core/config.js";
import { state } from "../core/state.js";
import { setStatus, setRichStatus } from "../core/feedback.js";
import { refreshButtons, setLoading, targetLanguage } from "../ui/buttons.js";
import { updateLines } from "../editor/line-numbers.js";
import { explainTranslationError, STOPPED_INFO } from "./errors.js";
import { startProgress, stopProgress } from "./progress.js";
import { getInstructions } from "./instructions.js";
import { loadSession } from "../account/session.js";
import { ensureGuestActionAllowed, setGuestUsage } from "../core/guest-usage.js";

const { form, source, output, sourceLanguage } = dom;

/* The request. Same endpoint and field names as before (message, source_language, language).
 * `instructions` is added only when the personalize box has text. */
function buildRequestBody({ message, from, to, instructions }) {
  const data = new FormData();
  data.append("message", message);
  data.append("source_language", from);
  data.append("language", to);
  if (instructions) data.append(INSTRUCTIONS_FIELD, instructions);
  return data;
}

function appendOutput(text) {
  const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 45;
  const previousTop = output.scrollTop;
  if (!output.value) stopProgress();          // first real code replaces the progress text
  output.value += text;
  output.scrollTop = atBottom ? output.scrollHeight : previousTop;
  updateLines(output, $("outputLines"));
  $("copyOutput").disabled = !output.value;
}

function httpError(status) {
  const error = new Error(`Translation failed (${status}).`);
  error.kind = "http";
  error.status = status;
  return error;
}
const kindError = (message, kind) => Object.assign(new Error(message), { kind });

export function initTranslate() {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.activeController) { state.activeController.abort(); return; }
    if (!source.value.trim()) { setRichStatus({ title: "There's no code to translate", tip: "Paste your code or upload a file first." }); source.focus(); return; }
    const target = targetLanguage();
    if (!target) { setRichStatus({ title: "No target language chosen", tip: "Use Change languages to pick one." }); return; }
    if (!(await ensureGuestActionAllowed("translations"))) return;

    const originalSource = source.value;
    const originalFileName = state.sourceFileName;
    const data = buildRequestBody({ message: originalSource, from: sourceLanguage.value, to: target, instructions: getInstructions() });
    const controller = new AbortController();
    state.activeController = controller;
    state.completedTranslation = null;
    output.value = "";
    output.scrollTop = 0;
    updateLines(output, $("outputLines"));
    setLoading(true);
    setStatus(`Translating to ${target}…`);
    $("statusMessage").classList.add("is-working");
    startProgress();

    try {
      const response = await fetch(form.action, {
        method: "POST", body: data, signal: controller.signal, credentials: "same-origin",
        headers: { Accept: "application/x-ndjson" }
      });
      if (!response.ok) {
        const body = await response.text();
        if (response.headers.get("content-type")?.includes("application/x-ndjson")) {
          for (const line of body.split("\n")) {
            if (!line.trim()) continue;
            try {
              const item = JSON.parse(line);
              if (item.guest_usage) setGuestUsage(item.guest_usage);
              if (item.type === "error" && item.message) throw kindError(item.message, "server");
            } catch (error) {
              if (error.kind) throw error;
            }
          }
        }
        throw httpError(response.status);
      }
      if (response.headers.get("content-type")?.includes("text/html")) throw kindError("The server returned a page instead of code.", "html");
      // NDJSON: one JSON event per line. Falls back to plain text if the server ignores Accept.
      const events = response.headers.get("content-type")?.includes("application/x-ndjson");
      let pendingText = "";
      let completed = false;
      let recorded = null;               // the 'complete' event: { translation_id, persisted, ... } for signed-in users
      function consumeLine(line) {
        if (!line.trim()) return;
        let item;
        try { item = JSON.parse(line); }
        catch (_) { throw kindError("The translation stream was interrupted.", "stream"); }
        if (item.type === "chunk" && typeof item.text === "string") appendOutput(item.text);
        else if (item.type === "usage") setGuestUsage(item.guest_usage);
        else if (item.type === "error") {
          if (item.guest_usage) setGuestUsage(item.guest_usage);
          throw kindError(item.message || "Translation failed.", "server");
        }
        else if (item.type === "complete") { completed = true; recorded = item; }
      }
      function consumeText(text) {
        if (!events) { appendOutput(text); return; }
        pendingText += text;
        let end;
        while ((end = pendingText.indexOf("\n")) !== -1) {
          const line = pendingText.slice(0, end);
          pendingText = pendingText.slice(end + 1);
          consumeLine(line);
        }
      }
      if (response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            consumeText(decoder.decode(value, { stream: true }));
          }
          consumeText(decoder.decode());
        } catch (error) {
          try { await reader.cancel(); } catch (_) { /* already closed */ }
          throw error;
        } finally { reader.releaseLock(); }
      } else { consumeText(await response.text()); }
      if (events) {
        if (pendingText.trim()) consumeLine(pendingText);
        if (!completed && !output.value.trim()) throw kindError("The translation stopped before completion.", "stream");
      }
      if (controller.signal.aborted) throw new DOMException("Translation stopped", "AbortError");
      // Existing server.py returns upstream errors as plain text with HTTP 200.
      if (/^\s*Error:\s*/i.test(output.value)) throw kindError(output.value.trim(), "server");
      if (!output.value.trim()) throw kindError("No code was returned.", "server");
      // translationId links this result to its row in the signed-in user's history (needed to bookmark it).
      state.completedTranslation = {
        source: originalSource, output: output.value, language: target, sourceLanguage: sourceLanguage.value, fileName: originalFileName,
        translationId: state.user && recorded?.persisted ? recorded.translation_id : null,
        isSaved: false
      };
      // Signed in but the server did not record it: the login probably expired. Find out quietly.
      if (state.user && recorded && !recorded.persisted) loadSession();
      setStatus(`Translated to ${target}. Ready to run, copy, save, or download.`);
    } catch (error) {
      if (error.name === "AbortError") setRichStatus(STOPPED_INFO, false);
      else {
        setRichStatus(explainTranslationError(error), true);
        if (/^\s*Error:\s*/i.test(output.value)) output.value = "";
      }
    } finally {
      state.activeController = null;
      stopProgress();
      updateLines(output, $("outputLines"));
      setLoading(false);
    }
  });
}
