/* File upload: code files only (.py .java .c .h .cpp .cc .cxx .hpp .hh .hxx), shown as a chip with a remove button. */
import { $, dom } from "../core/dom.js";
import { MAX_UPLOAD_BYTES, uploadExtensions } from "../core/config.js";
import { state } from "../core/state.js";
import { notify, setStatus } from "../core/feedback.js";
import { refreshButtons } from "../ui/buttons.js";
import { updateLines } from "../editor/line-numbers.js";
import { countLines } from "../editor/source-lines.js";

const { source, sourceLanguage } = dom;
const SUPPORTED_TEXT = ".py, .java, .c or .cpp";
const SUPPORTED_TEXT_BY_LANGUAGE = {
  Python: ".py",
  Java: ".java",
  C: ".c and .h",
  "C++": ".cpp, .cc, .cxx, .hpp, .hh and .hxx"
};

const extensionOf = (name) => (/\.([^./\\]+)$/.exec(name || "")?.[1] || "").toLowerCase();

// Shows either the hint text or the uploaded file's name with its remove button.
export function updateFileLabel() {
  const has = Boolean(state.sourceFileName);
  const extensions = state.languagesConfirmed ? SUPPORTED_TEXT_BY_LANGUAGE[sourceLanguage.value] : "";
  $("fileHelp").textContent = `Supports ${extensions || SUPPORTED_TEXT} files`;
  $("fileHelp").hidden = has;
  $("fileChip").hidden = !has;
  $("fileName").textContent = state.sourceFileName;
  $("fileChip").title = state.sourceFileName;
  $("removeFile").setAttribute("aria-label", has ? `Remove uploaded file ${state.sourceFileName}` : "Remove uploaded file");
}

async function loadFile(file) {
  if (!file || state.activeController) return;
  const extension = extensionOf(file.name);
  if (!uploadExtensions[extension]) {
    notify(extension
      ? `".${extension}" files aren't supported. Upload a ${SUPPORTED_TEXT} file.`
      : `That file has no extension. Upload a ${SUPPORTED_TEXT} file.`);
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) { notify("Please choose a code file smaller than 1 MB."); return; }
  const version = ++state.fileReadVersion;
  try {
    const text = await file.text();
    if (version !== state.fileReadVersion || state.activeController) return;
    if (text.includes("\u0000")) { notify("This file isn't plain text. Please upload a source code file."); return; }
    source.value = text.replace(/^\uFEFF/, "");
    state.uploadedText = source.value;
    state.sourceFileName = file.name;
    source.scrollTop = 0;
    updateFileLabel();
    updateLines(source, $("sourceLines"));
    $("sourceLineCounter").textContent = `Lines ${countLines(source.value)}`;
    refreshButtons();
    source.focus();
    const fileLanguage = uploadExtensions[extension];
    if (!source.value.trim()) setStatus("This file is empty.");
    else if (state.languagesConfirmed && sourceLanguage.value.toLowerCase() !== fileLanguage.toLowerCase()) {
      setStatus(`File loaded. It looks like ${fileLanguage} code, but the source language is ${sourceLanguage.value}. Use Change languages if that's not what you want.`);
    } else setStatus("File loaded. Choose a language and translate.");
  } catch (_) { notify("This file couldn't be read. Please try another file."); }
}

function removeFile() {
  if (state.activeController || !state.sourceFileName) return;
  const name = state.sourceFileName;
  const untouched = source.value === state.uploadedText;   // not edited since it was loaded
  state.fileReadVersion += 1;
  state.sourceFileName = "";
  state.uploadedText = "";
  if (untouched) {
    source.value = "";
    source.scrollTop = 0;
    updateLines(source, $("sourceLines"));
    $("sourceLineCounter").textContent = `Lines ${countLines(source.value)}`;
  }
  updateFileLabel();
  refreshButtons();
  setStatus(untouched && state.completedTranslation ? "Source cleared. Upload or paste code to translate again." : "");
  notify(untouched ? `Removed ${name}.` : `Removed ${name} from the editor label. Your edited code was kept.`);
  $("uploadButton").focus();
}

export function initUpload() {
  $("uploadButton").addEventListener("click", () => $("attachment").click());
  $("attachment").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    await loadFile(file);
  });
  $("removeFile").addEventListener("click", removeFile);
  const sourceCard = document.querySelector(".source-card");
  sourceCard.addEventListener("dragover", (event) => {
    if (Array.from(event.dataTransfer.types).includes("Files")) {
      event.preventDefault();
      if (!state.activeController) sourceCard.classList.add("is-drag-over");
    }
  });
  sourceCard.addEventListener("dragleave", (event) => {
    if (!sourceCard.contains(event.relatedTarget)) sourceCard.classList.remove("is-drag-over");
  });
  sourceCard.addEventListener("drop", (event) => {
    sourceCard.classList.remove("is-drag-over");
    if (event.dataTransfer.files.length) {
      event.preventDefault();
      if (event.dataTransfer.files.length > 1) notify("Opening the first file. Upload one code file at a time.");
      loadFile(event.dataTransfer.files[0]);
    }
  });
}
