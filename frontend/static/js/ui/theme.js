/* Theme (light / dark / system) with the smooth transition, plus the code size and line-number preferences. */
import { $, dom } from "../core/dom.js";
import { keys } from "../core/config.js";
import { preferences } from "../core/state.js";
import { writeStorage } from "../core/storage.js";
import { syncScroll } from "../editor/line-numbers.js";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
/* ---------- Theme switching with smooth transition ----------
 * 1) Primary: View Transitions API (GPU cross-fade of two full-screen snapshots, 650ms).
 * 2) Fallback: .theme-switching class (300ms CSS transition + soft blur overlay).
 * Respects prefers-reduced-motion (instant switch). */
const THEME_VT_MS = 650;        // view-transition cross-fade length (keep in sync with CSS)
const THEME_FALLBACK_MS = 300;  // fallback transition length (keep in sync with CSS)
const THEME_ICON_DELAY = THEME_FALLBACK_MS / 2; // icon/label swap lands mid-fade (150ms)
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const rootEl = document.documentElement;
let themeCleanupTimer = 0;
let themeIconTimer = 0;

function wantsDark() {
  return preferences.theme === "dark" || (preferences.theme === "system" && darkQuery.matches);
}

// Flips every CSS design token (via data-theme) + browser UI colour.
function commitTheme(dark) {
  rootEl.dataset.theme = dark ? "dark" : "light";
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  const page = getComputedStyle(rootEl).getPropertyValue("--page").trim();
  if (page) meta.setAttribute("content", page);
}

// Moon/Sun icon + labels. When animating, wait ~150ms so the swap happens mid-fade.
function syncThemeButton(dark, animate) {
  const button = $("themeToggle");
  const icon = button.querySelector(".icon");
  const label = `Switch to ${dark ? "light" : "dark"} mode`;
  const swap = () => {
    $("themeIcon").setAttribute("href", dark ? "#i-sun" : "#i-moon");
    button.setAttribute("aria-label", label);
    button.title = label;
    icon.classList.remove("theme-icon-turn");
  };
  clearTimeout(themeIconTimer);
  if (animate) {
    icon.classList.add("theme-icon-turn"); // smooth 90deg rotation
    themeIconTimer = setTimeout(swap, THEME_ICON_DELAY);
  } else {
    swap();
  }
}

function applyTheme(animate) {
  const dark = wantsDark();
  const next = dark ? "dark" : "light";
  const changed = rootEl.dataset.theme !== next;
  $("themeSetting").value = preferences.theme;

  // First paint, no real change, or user prefers reduced motion -> instant.
  if (!animate || !changed || reducedMotionQuery.matches) {
    commitTheme(dark);
    syncThemeButton(dark, false);
    return;
  }

  syncThemeButton(dark, true);
  clearTimeout(themeCleanupTimer);

  if (typeof document.startViewTransition === "function") {
    // Primary engine: freeze old screen, flip tokens, cross-fade old -> new on the GPU.
    rootEl.classList.add("theme-vt"); // disables per-element transitions so nothing fights the fade
    const transition = document.startViewTransition(() => commitTheme(dark));
    const done = () => rootEl.classList.remove("theme-vt");
    transition.finished.then(done, done);
  } else {
    // Fallback: synchronized 300ms CSS transition + soft blur overlay.
    rootEl.classList.add("theme-switching");
    commitTheme(dark);
    themeCleanupTimer = setTimeout(() => rootEl.classList.remove("theme-switching"), THEME_FALLBACK_MS + 50);
  }
}

export function applyPreferences(animateTheme = false) {
  applyTheme(animateTheme);
  rootEl.style.setProperty("--code-size", `${preferences.fontSize}px`);
  rootEl.style.setProperty("--code-line", `${Math.round(preferences.fontSize * 1.73)}px`);
  document.body.classList.toggle("hide-line-numbers", !preferences.lineNumbers);
  $("fontSizeSetting").value = String(preferences.fontSize);
  $("lineNumbersSetting").checked = preferences.lineNumbers;
  syncScroll(dom.source, $("sourceLines"));
  syncScroll(dom.output, $("outputLines"));
}
function savePreferences(animateTheme = false) { applyPreferences(animateTheme); writeStorage(keys.preferences, preferences); }
export function initTheme() {
  $("themeToggle").addEventListener("click", () => {
    preferences.theme = rootEl.dataset.theme === "dark" ? "light" : "dark";
    savePreferences(true);
  });
  $("themeSetting").addEventListener("change", (event) => { preferences.theme = event.target.value; savePreferences(true); });
  $("fontSizeSetting").addEventListener("change", (event) => { preferences.fontSize = Number(event.target.value); savePreferences(); });
  $("lineNumbersSetting").addEventListener("change", (event) => { preferences.lineNumbers = event.target.checked; savePreferences(); });
  // Live OS theme sync: same smooth transition when the device theme changes.
  darkQuery.addEventListener("change", () => { if (preferences.theme === "system") applyPreferences(true); });
}
