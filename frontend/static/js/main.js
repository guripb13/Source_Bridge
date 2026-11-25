/* Source Bridge frontend entry point.
 * POST /send    multipart fields: message, source_language, language (+ optional instructions).
 *               Streams NDJSON events (chunk / error / complete).
 * POST /execute JSON { code, language, inputs, eof } -> runs C, C++, Python or Java.
 *
 * Folder map (static/js):
 *   core/       shared state, config, storage, DOM helpers, toast + status line
 *   ui/         sidebar, theme, dialogs, navigation, button states, page scrollbar
 *   editor/     line numbers, auto-closing pairs, height handle, source input
 *   languages/  language selection screen, language logos
 *   translate/  translate request + streaming, progress text, friendly errors, personalize box
 *   files/      upload (+ remove) and copy / download
 *   run/        terminal and its panel animation
 *   saved/      saved translations (store, server copy in cloud.js, view + bookmark toggle)
 *   account/    sign in / sign up / sign out (api.js, session.js, auth-dialog.js)
 *   history/    the signed-in user's translation history
 *
 * Account routes (backend/main.py): GET /me, POST /signup, POST /login, POST /logout,
 * DELETE /account, GET /translations, GET|DELETE /translations/<id>, POST /translations/<id>/save.
 */
import { applyPreferences, initTheme } from "./ui/theme.js";
import { initSidebar, updateSidebar } from "./ui/sidebar.js";
import { initDialogs } from "./ui/dialogs.js";
import { initNavigation } from "./ui/navigation.js";
import { refreshButtons } from "./ui/buttons.js";
import { initPageScrollbar } from "./ui/scrollbar.js";
import { initLanguageDropdown } from "./ui/language-dropdown.js";
import { initLineNumbers } from "./editor/line-numbers.js";
import { initSourceInput } from "./editor/source-input.js";
import { initEditorResize } from "./editor/resize.js";
import { initLanguages, languageChanged, renderLanguageChoices } from "./languages/selection.js";
import { initTranslate } from "./translate/translate.js";
import { initInstructions } from "./translate/instructions.js";
import { initUpload } from "./files/upload.js";
import { initExport } from "./files/export.js";
import { initRun } from "./run/terminal.js";
import { initSaved, renderSaved } from "./saved/saved.js";
import { initAuth } from "./account/auth-dialog.js";
import { initHistory } from "./history/history.js";
import { loadSession } from "./account/session.js";

// Same order the single-file version used, so behaviour is unchanged.
initSidebar();
initTheme();
initDialogs();
initNavigation();
initLineNumbers();
initLanguages();
initSourceInput();
initTranslate();
initInstructions();
initUpload();
initExport();
initRun();
initSaved();
initAuth();
initHistory();
initEditorResize();

applyPreferences();
updateSidebar();
languageChanged();
renderLanguageChoices();
renderSaved();
refreshButtons();

initPageScrollbar();
initLanguageDropdown();

// Last: ask the server who is signed in. The page works as a visitor until it answers.
loadSession();
