/* Turns raw server / network failures into: what happened, why, and what to do.
 * Each result is { title, text, tip, details? }. `details` holds the server's own wording
 * (for example compiler output) so nothing is hidden, just moved out of the way. */

const SUPPORTED = "Python, Java, C and C++";

// Text after the first line, e.g. "Source code has a compilation error:\n<compiler output>"
const afterFirstLine = (message) => {
  const index = message.indexOf("\n");
  return index === -1 ? "" : message.slice(index + 1).trim();
};

function fromServerMessage(raw) {
  const message = String(raw || "").trim().replace(/^Error:\s*/i, "");
  const lower = message.toLowerCase();

  if (/^please provide some source code/i.test(message)) {
    return { title: "There's no code to translate", text: "The editor was empty when the request reached the server.", tip: "Paste your code or upload a file, then press Translate." };
  }
  if (/source code is too large/i.test(message)) {
    return { title: "Your code is too long", text: "The server only accepts code up to a fixed size.", tip: "Translate it in smaller pieces, for example one class or a few functions at a time." };
  }
  if (/invalid language name/i.test(message)) {
    return { title: "That language isn't valid", text: "The server didn't recognise the selected language.", tip: `Use Change languages and pick from ${SUPPORTED}.` };
  }
  if (/^source code has a compilation error/i.test(message)) {
    return {
      title: "Your code doesn't compile yet",
      text: "Before translating, the server compiles your code to make sure it works. It found an error, so the translation was not started.",
      tip: "Fix the error shown below (the line number is usually included), then translate again. You can use Run to test your code first.",
      details: afterFirstLine(message)
    };
  }
  if (/^source code failed when run/i.test(message)) {
    return {
      title: "Your code stopped with an error when it ran",
      text: "The server ran your program as a quick check and it ended with an error, so the translation was not started.",
      tip: "Open Run to see the same error, fix it, and translate again.",
      details: afterFirstLine(message)
    };
  }
  if (/timed out|did not finish running in time/i.test(lower) && /source/i.test(lower)) {
    return {
      title: "Checking your code took too long",
      text: "The server stops a check that runs for too long, for example an endless loop.",
      tip: "Look for loops that never end or very heavy work, simplify the code, and try again.",
      details: afterFirstLine(message)
    };
  }
  if (/cannot check the source code on this server/i.test(message)) {
    return { title: "This server can't check that language right now", text: "The compiler needed to check your code isn't available on the server at the moment.", tip: "Try again in a little while." };
  }
  if (/could not check the source code/i.test(message)) {
    return { title: "Couldn't check your code", text: "The server hit a problem while checking your code before translating.", tip: "Wait a moment and try again." };
  }
  if (/^cannot convert/i.test(message)) {
    return { title: "That language pair can't be converted", text: message, tip: `Choose another pair with Change languages. ${SUPPORTED} can be converted to each other.` };
  }
  if (/cannot be translated to|valid source code in a supported language/i.test(message)) {
    return {
      title: "That doesn't look like valid code",
      text: "The translator couldn't recognise the input as source code in the selected language.",
      tip: "Check that the source language is correct (Change languages) and that you pasted code, not plain text."
    };
  }
  if (/translation service is currently unavailable|unavailable/i.test(lower)) {
    return { title: "The translation service is busy or unavailable", text: "The AI service that does the translation didn't answer. This is usually temporary.", tip: "Wait a minute and press Translate again. Your code is still in the editor." };
  }
  if (/no code was returned/i.test(message)) {
    return { title: "Nothing came back", text: "The translation finished without any code in the result.", tip: "Press Translate again. If it keeps happening, try a smaller piece of code." };
  }
  return null;
}

function fromStatus(status) {
  if (status === 429) return { title: "Too many requests", text: "You've sent a lot of translations in a short time, so the server is asking you to slow down.", tip: "Wait about a minute, then try again." };
  if (status === 413) return { title: "Your code is too large to send", text: "The server refused the request because it was too big.", tip: "Translate smaller pieces of code at a time." };
  if (status === 401 || status === 403) return { title: "The server refused the request", text: "It isn't letting this page use the translator right now.", tip: "Refresh the page and try again." };
  if (status === 404) return { title: "The translator wasn't found", text: "The page couldn't find the translation service on the server.", tip: "Refresh the page. If it still fails, the server may be down for maintenance." };
  if (status >= 500) return { title: "The server had a problem", text: `The server reported an internal error (code ${status}). Your code was not changed.`, tip: "Wait a moment and try again." };
  if (status >= 400) return { title: "The request couldn't be completed", text: `The server answered with code ${status}.`, tip: "Refresh the page and try again." };
  return null;
}

/* error: an Error, optionally with .kind ("http" | "html" | "stream" | "server") and .status */
export function explainTranslationError(error) {
  if (error instanceof TypeError) {
    return { title: "Can't reach the server", text: "The request never arrived, so nothing was translated.", tip: "Check your internet connection (or that the server is running) and try again." };
  }
  const raw = error?.message || "";
  if (error?.kind === "http") {
    const byStatus = fromStatus(error.status);
    if (byStatus) return byStatus;
  }
  if (error?.kind === "html") {
    return { title: "The server sent back a web page instead of code", text: "This usually means the page is out of date or something is blocking the request.", tip: "Refresh the page and try again." };
  }
  if (error?.kind === "stream") {
    return { title: "The connection was interrupted", text: "The result stopped arriving part-way through, so it may be incomplete.", tip: "Check your connection and press Translate again." };
  }
  const known = fromServerMessage(raw);
  if (known) return known;
  return {
    title: "The translation didn't work",
    text: raw && raw.length < 300 ? raw : "The server reported a problem it couldn't explain.",
    tip: "Try again. If it keeps happening, simplify the code or try again later.",
    details: raw && raw.length >= 300 ? raw : ""
  };
}

export const STOPPED_INFO = {
  title: "Translation stopped",
  text: "You stopped it. Anything produced so far is still in the output box and may be incomplete.",
  tip: "Press Translate to start again."
};

/* One readable sentence for the terminal (Run) panel. */
export function runErrorMessage(error) {
  if (error?.status === 401) return "The server asked for a sign-in before running code. Running code doesn't need an account, so please refresh the page and try again.";
  if (error?.status === 429) return "Too many runs in a short time. Wait a few seconds and try again.";
  if (error instanceof TypeError) return "Can't reach the server. Check your connection and try Run again.";
  if (error?.status >= 500) return `The server had a problem while running your code (code ${error.status}). Wait a moment and try Run again.`;
  return error?.message || "The code couldn't be run. Please try again.";
}
