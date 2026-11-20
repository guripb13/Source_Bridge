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
 *   saved/      saved translations (store + view + bookmark toggle)
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
import { initUpload, updateFileLabel } from "./files/upload.js";
import { initExport } from "./files/export.js";
import { initRun } from "./run/terminal.js";
import { initSaved, renderSaved } from "./saved/saved.js";

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
initEditorResize();

applyPreferences();
updateSidebar();
languageChanged();
renderLanguageChoices();
renderSaved();
updateFileLabel();
refreshButtons();

initPageScrollbar();
initLanguageDropdown();
