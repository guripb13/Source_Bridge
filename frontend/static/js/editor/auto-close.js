/* Auto-closing brackets and quotes in the source editor.
 *   typing ( [ { " '   inserts the pair and puts the cursor between
 *   typing the closing character right before the same one just moves past it
 *   Backspace between an empty pair removes both
 *   with text selected, typing an opener wraps the selection
 * Insertion goes through execCommand("insertText") so Ctrl+Z still undoes it in one step. */
const PAIRS = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'" };
const CLOSERS = new Set([")", "]", "}", '"', "'"]);
const WORD = /[A-Za-z0-9_]/;
const SAFE_NEXT = /^[\s)\]}>,;:.]?$/;   // only auto-close before whitespace, a closer, punctuation, or the end

function insert(editor, text) {
  let done = false;
  try { done = document.execCommand("insertText", false, text); } catch (_) { done = false; }
  if (!done) {
    editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, "end");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

export function initAutoClose(editor) {
  editor.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (editor.readOnly) return;
    const { selectionStart: start, selectionEnd: end, value } = editor;
    const key = event.key;
    const prev = value[start - 1] || "";
    const next = value[end] || "";

    if (key === "Backspace" && start === end && PAIRS[prev] && PAIRS[prev] === next) {
      event.preventDefault();
      editor.setSelectionRange(start - 1, start + 1);
      let done = false;
      try { done = document.execCommand("delete"); } catch (_) { done = false; }
      if (!done) { editor.setRangeText("", start - 1, start + 1, "end"); editor.dispatchEvent(new Event("input", { bubbles: true })); }
      return;
    }

    if (PAIRS[key]) {
      const close = PAIRS[key];
      if (start !== end) {                       // wrap the selection
        event.preventDefault();
        const selected = value.slice(start, end);
        insert(editor, key + selected + close);
        editor.setSelectionRange(start + 1, start + 1 + selected.length);
        return;
      }
      if (key === close) {                       // quotes
        if (next === key) { event.preventDefault(); editor.setSelectionRange(start + 1, start + 1); return; }
        if (WORD.test(prev) || prev === key) return;   // apostrophes, closing quotes, triple quotes
      }
      if (!SAFE_NEXT.test(next)) return;
      event.preventDefault();
      insert(editor, key + close);
      editor.setSelectionRange(start + 1, start + 1);
      return;
    }

    if (CLOSERS.has(key) && start === end && next === key) {   // type over an existing closer
      event.preventDefault();
      editor.setSelectionRange(start + 1, start + 1);
    }
  });
}
