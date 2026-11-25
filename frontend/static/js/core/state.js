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
  // Account. `user` is { id, username, email, created_at } while signed in, otherwise null.
  // The login itself lives in an HttpOnly cookie that JavaScript cannot read.
  user: null,
  authReady: false,              // true once the first GET /me has answered
  guestUsage: null,              // server-authoritative counters mirrored to localStorage
  cloudSaved: [],                // bookmarked translations of the signed-in user (server copy)
  history: {
    items: [],                   // rows loaded so far (newest first)
    next: null,                  // before_id for the next page, or null when everything is loaded
    filter: "all",               // all | completed | failed | saved
    source: "all",               // which server list `items` holds: "all" or "saved"
    loading: false,
    error: "",                   // message of the last failed request, or ""
    token: 0                     // bumps on every request so a slow, stale answer is ignored
  },
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
