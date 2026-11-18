/* The one shared, mutable app state. Modules import `state` and read/write its fields. */
import { keys, MAX_SAVED } from "./config.js";
import { readStorage } from "./storage.js";

const storedPreferences = readStorage(keys.preferences, {});
const storedSaved = readStorage(keys.saved, []);

export const preferences = {
  theme: ["light", "dark", "system"].includes(storedPreferences?.theme) ? storedPreferences.theme : "light",
  fontSize: [13, 14, 15, 16, 18].includes(storedPreferences?.fontSize) ? storedPreferences.fontSize : 15,
  lineNumbers: storedPreferences?.lineNumbers !== false
};

export const state = {
  saved: Array.isArray(storedSaved) ? storedSaved.filter((entry) =>
    entry && typeof entry.id === "string" && typeof entry.source === "string" &&
    typeof entry.output === "string" && typeof entry.language === "string"
  ).slice(0, MAX_SAVED) : [],
  desktopCollapsed: readStorage(keys.sidebar, false) === true,
  mobileOpen: false,
  activeController: null,        // AbortController of the running translation, or null
  completedTranslation: null,    // { source, output, language, sourceLanguage, fileName }
  sourceFileName: "",            // name of the uploaded file now in the editor
  uploadedText: "",              // exact text that file put into the editor
  fileReadVersion: 0,            // invalidates in-flight file reads when the editor changes
  // Welcome -> language selection -> workspace. The confirmed pair lives in the hidden selects.
  languagesConfirmed: false,
  pendingSource: "",
  pendingTarget: "",
  setupView: "welcome",
  currentView: "welcome"
};
