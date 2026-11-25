import { MAX_LINES, MAX_LINE_CHARS } from "../core/config.js";

export const SOURCE_LIMIT_MESSAGE = `Limit: ${MAX_LINES} lines, ${MAX_LINE_CHARS} characters per line.`;

function normalizeLineEndings(text) {
  return text.replace(/\r\n|\r|\u2028|\u2029/g, "\n");
}

export function countLines(text) {
  return normalizeLineEndings(text).split("\n").length;
}

export function enforceLimits(text) {
  const lines = normalizeLineEndings(text).split("\n");
  let tooLong = false;
  const clipped = lines.slice(0, MAX_LINES).map((line) => {
    if (line.length > MAX_LINE_CHARS) {
      tooLong = true;
      return line.slice(0, MAX_LINE_CHARS);
    }
    return line;
  });
  return { text: clipped.join("\n"), cut: lines.length > MAX_LINES || tooLong };
}
