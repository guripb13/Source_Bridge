function normalizeLineEndings(text) {
  return text.replace(/\r\n|\r|\u2028|\u2029/g, "\n");
}

export function countLines(text) {
  return normalizeLineEndings(text).split("\n").length;
}
