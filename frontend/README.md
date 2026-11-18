# Source Bridge frontend

Served by `backend/main.py` (`render_template("index.html")` + Flask's `/static`). Nothing here needs a build step.

## Folder map

```
frontend/
  templates/index.html          page markup (icon sprite, header, sidebar, views, dialogs)
  static/
    css/                        one concern per file; load order is set in index.html
      fonts.css                   @font-face for the bundled Inter font
      base.css                    scrollbar, colour tokens (light + dark), reset
      header.css                  top bar, brand logo
      sidebar.css                 desktop rail + mobile drawer
      workspace.css               editors, controls, upload/download, status line
      dialogs.css                 saved cards, dialogs, toast
      responsive.css              breakpoints for the core layout
      theme-transition.css        light/dark cross-fade
      animations.css              nav icon + page transition animations
      terminal.css                Run buttons and terminal panel
      scrollbar-page.css          animated page scrollbar
      language-dropdown.css       custom language dropdown
      language-flow.css           welcome, language selection, language badges, short-screen fit
      editor-tools.css            language logos/badges, height handle, uploaded-file chip, progress text
      personalize.css             "Personalize the translation" box + suggestion chips
      status-feedback.css         friendly error layout
      sidebar-peek.css            hover-to-open collapsed sidebar
      credits.css                 credits dialog
      selection.css               which text is unselectable
    js/                         ES modules; main.js wires them together
      main.js                     entry point + folder map
      core/                       state, config, storage, DOM helpers, toast/status line
      ui/                         sidebar, theme, dialogs, navigation, button states, scrollbar
      editor/                     line numbers, auto-close brackets/quotes, height handle, source input
      languages/                  language selection screen, logos
      translate/                  request + streaming, progress text, friendly errors, personalize box
      files/                      upload (+ remove), copy/download
      run/                        terminal, panel animation
      saved/                      saved translations (store, view, save/unsave toggle)
    fonts/                      Inter (Latin subset, .woff) + its licence
    icon*.webp / icon*.png      logos
```

## Where to edit what

| Change | File |
| --- | --- |
| Error wording / suggestions | `js/translate/errors.js` |
| Progress messages while translating | `js/translate/progress.js` |
| Allowed upload types, file size, the extra form field name | `js/core/config.js` |
| Auto-closing pairs | `js/editor/auto-close.js` |
| Suggestion chips | the `.suggestion-chip` buttons in `index.html` |
| Credits (team name, members) | `#creditsDialog` in `index.html` |
| Colours / theme tokens | `css/base.css` |

## Limitations (frontend only)

- **Personalize box:** the text is sent as one extra form field named `instructions` (only when the box is not
  empty; otherwise the request is identical to before). The current `backend/main.py` ignores unknown fields, so it
  has no effect on the result until the server reads that field.
- **Progress messages** are illustrative stages on a timer; the server does not report real progress.
- **Language logos** load from the Devicon CDN (as before) and are simply hidden if it can't be reached.
- The "secure API call / new routing" item is server work and is not part of this folder.
