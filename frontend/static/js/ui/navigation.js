/* Page navigation: view switching with exit / entry animations and the sidebar tab icons. */
import { $, dom } from "../core/dom.js";
import { state } from "../core/state.js";
import { closeSidebar } from "./sidebar.js";
import { syncScroll } from "../editor/line-numbers.js";
import { renderSaved } from "../saved/saved.js";
import { prepareLanguageView } from "../languages/selection.js";

const viewOrder = {
  welcome: 0,
  languages: 1,
  translate: 2,
  saved: 3,
  history: 4
};

// Saved and History are full pages (they slide up / down); the setup steps slide sideways.
const isPage = (view) => view === "saved" || view === "history";


/* RESTART CSS ANIMATION ON EVERY CLICK */

function restartAnimation(item, className) {
  item.classList.remove(className);

  // Force browser to recalculate animation
  void item.offsetWidth;

  item.classList.add(className);
}


/* ACTIVE AND INACTIVE NAVIGATION ICONS */

function selectNavigationItem(item) {

  const previous = document.querySelector(".nav-item.active");

  // Animate previous active icon
  if (previous && previous !== item) {

    previous.classList.remove("active", "animate");

    previous.removeAttribute("aria-current");

    restartAnimation(previous, "leave");
  }

  // Activate new navigation icon
  item.classList.remove("leave");

  item.classList.add("active");

  item.setAttribute("aria-current", "page");

  restartAnimation(item, "animate");
}


/* PAGE SWITCHING WITH EXIT AND ENTRY ANIMATIONS */

export function showView(view) {

  // Until languages are confirmed, the Translate tab leads to the welcome / selection steps.
  if (view === "translate" && !state.languagesConfirmed) {
    view = state.setupView;
  }

  if (!Object.prototype.hasOwnProperty.call(viewOrder, view)) {
    return;
  }

  if (view === state.currentView) {
    return;
  }

  if (view === "languages") {
    prepareLanguageView();
  }

  const goingDown =
    viewOrder[view] > viewOrder[state.currentView];
        // Welcome, language selection and workspace are steps, so they slide sideways
  const sideways = !isPage(view) && !isPage(state.currentView);
  const main = $("mainContent");

  state.currentView = view;


  /* COMPLETE PAGE SWITCH */

  function finishSwitch() {

    $("welcomeView").hidden = view !== "welcome";

    $("languageView").hidden = view !== "languages";

    $("translateView").hidden = view !== "translate";

    $("savedView").hidden = view !== "saved";

    $("historyView").hidden = view !== "history";

    // Welcome, language selection and the workspace all sit under the Translate tab.
    const tab = isPage(view) ? view : "translate";

    [$("translateNav"), $("savedNav"), $("historyNav")].forEach(button => {

      const current = button.dataset.view === tab;

      button.classList.toggle("active", current);

      if (current) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    });

    // Refresh saved translations
    if (view === "saved") {
      renderSaved();
    }

    // Line gutters cannot be measured while the workspace is hidden
    if (view === "translate") {
      syncScroll(dom.source, $("sourceLines"));
      syncScroll(dom.output, $("outputLines"));
    }

    window.scrollTo(0, 0);

    // Lets other modules (History) load their data when their page opens.
    document.dispatchEvent(new CustomEvent("sb:viewchange", { detail: { view } }));

    // Close mobile sidebar
    if (state.mobileOpen) {
      closeSidebar();
    }
  }


  /* ACCESSIBILITY CHECK */

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {

    finishSwitch();

    main.focus({ preventScroll: true });

    return;
  }


  /* DETERMINE TRANSITION DIRECTION */

      const exitClass = sideways
    ? (goingDown ? "view-exit-left" : "view-exit-right")
    : (goingDown ? "view-exit-up" : "view-exit-down");

  const enterClass = sideways
    ? (goingDown ? "view-enter-from-right" : "view-enter-from-left")
    : (goingDown ? "view-enter-from-bottom" : "view-enter-from-top");


  /* REMOVE PREVIOUS TRANSITION CLASSES */

  main.classList.remove(
    "view-exit-up",
    "view-exit-down",
    "view-enter-from-bottom",
    "view-enter-from-top",
    "view-exit-left",
    "view-exit-right",
    "view-enter-from-right",
    "view-enter-from-left"
  );


  /* START EXIT ANIMATION */

  main.classList.add(exitClass);


  /* WAIT FOR EXIT ANIMATION TO FINISH */

  main.addEventListener("animationend", function onExit(event) {

    if (event.target !== main) return;

    main.removeEventListener("animationend", onExit);

    main.classList.remove(exitClass);


    /* CHANGE THE ACTUAL PAGE */

    finishSwitch();


    /* START NEW PAGE ENTRANCE ANIMATION */

    main.classList.add(enterClass);


    main.addEventListener("animationend", function onEnter(event) {

      if (event.target !== main) return;

      main.removeEventListener("animationend", onEnter);

      main.classList.remove(enterClass);

      main.focus({ preventScroll: true });

    });

  });

}



export function initNavigation() {
  /* =========================================
     NAVIGATION CLICK EVENTS
  ========================================= */

  document.querySelectorAll("[data-view]").forEach(button => {

    button.addEventListener("click", () => {

      const navItem = button.classList.contains("nav-item")
        ? button
        : document.querySelector(
            `.nav-item[data-view="${button.dataset.view}"]`
          );

      if (navItem) {
        selectNavigationItem(navItem);
      }

      showView(button.dataset.view);

    });

  });


  /* CLEAN UP ICON ANIMATION CLASSES */

  document.querySelectorAll(".nav-item[data-view]").forEach(item => {

    item.addEventListener("animationend", event => {

      if (event.target === item.querySelector(".icon")) {

        item.classList.remove("animate", "leave");

      }

    });

  });
}
