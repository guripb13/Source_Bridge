/* History view: every translation the signed-in user ran (finished, failed or interrupted).
 *
 * Data comes from GET /translations (newest first, 20 per page, "Load more" for the rest).
 * Filters: All / Completed / Failed are applied to the loaded rows; "Saved" asks the server
 * for bookmarked rows only so older bookmarks are never missed.
 * Everything shown is set with textContent: stored code can never become markup.
 */
import { $, makeEl, makeIcon } from "../core/dom.js";
import { endpoints, HISTORY_PAGE_SIZE } from "../core/config.js";
import { state } from "../core/state.js";
import { notify } from "../core/feedback.js";
import { api } from "../account/api.js";
import {
  deleteCloudTranslation, fetchTranslation, refreshCloudSaved, setCloudSaved, syncOpenTranslation
} from "../saved/cloud.js";
import { openFromServer, renderSaved } from "../saved/saved.js";
import { refreshButtons } from "../ui/buttons.js";

const STATUS_LABELS = { completed: "Completed", failed: "Failed", pending: "In progress" };
const STAGE_LABELS = {
  compiler: "Source code check",
  convertibility: "Language support",
  translation: "Translation service",
  interrupted: "Stopped early"
};
const EMPTY_TEXT = {
  all: ["Nothing here yet", "Translate some code and it will show up here."],
  completed: ["No finished translations", "Translations that finish successfully appear here."],
  failed: ["No failed translations", "Good news: nothing has gone wrong so far."],
  saved: ["No saved translations", "Use the bookmark beside a translation to keep it here."]
};
const MAX_AUTO_PAGES = 10;      // while a filter shows nothing, keep loading older pages (up to this many)

const matches = (item, filter) =>
  filter === "all" || filter === "saved" || item.status === filter;

const formatDateTime = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
};
const firstLine = (text) => String(text || "").split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 70) || "Untitled translation";

let focusRequest = null;        // { id, selector } to restore keyboard focus after a re-render
let autoPages = 0;

/* ------------------------------------------------------------------ loading */
async function loadHistory({ more = false } = {}) {
  const h = state.history;
  if (!state.user) return;
  const wanted = h.filter === "saved" ? "saved" : "all";
  if (!more) { h.items = []; h.next = null; autoPages = 0; }
  const token = ++h.token;
  h.source = wanted;
  h.loading = true;
  h.error = "";
  renderHistory();

  const params = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
  if (wanted === "saved") params.set("saved", "1");
  if (more && h.next) params.set("before_id", String(h.next));
  try {
    const data = await api("GET", `${endpoints.translations}?${params}`);
    if (token !== h.token || !state.user) return;           // a newer request replaced this one
    const rows = Array.isArray(data.translations) ? data.translations : [];
    h.items = more ? h.items.concat(rows) : rows;
    h.next = data.next_before_id ?? null;
  } catch (error) {
    if (token !== h.token) return;
    h.error = error.message || "Couldn't load your history.";
  } finally {
    if (token === h.token) {
      h.loading = false;
      renderHistory();
      keepLoadingIfEmpty();
    }
  }
}

/* "Failed" filter but the newest 20 rows all succeeded: quietly fetch older pages. */
function keepLoadingIfEmpty() {
  const h = state.history;
  const visible = h.items.filter((item) => matches(item, h.filter)).length;
  if (!visible && h.next && !h.error && !h.loading && autoPages < MAX_AUTO_PAGES) {
    autoPages += 1;
    loadHistory({ more: true });
  }
}

/* ------------------------------------------------------------------ actions on one row */
async function openItem(item, button) {
  if (state.activeController) { notify("Stop the current translation before opening one from your history."); return; }
  button.disabled = true;
  try { openFromServer(await fetchTranslation(item.id)); }
  catch (error) { notify(error.message); }
  finally { button.disabled = false; }
}

async function toggleBookmark(item, button) {
  button.disabled = true;
  const wanted = !item.is_saved;
  try {
    await setCloudSaved(item.id, wanted);
    item.is_saved = wanted;
    syncOpenTranslation(item.id, { isSaved: wanted });
    if (state.history.filter === "saved" && !wanted) {
      state.history.items = state.history.items.filter((row) => row.id !== item.id);
    }
    await refreshCloudSaved();
    renderSaved(); refreshButtons();
    focusRequest = { id: item.id, selector: ".bookmark-toggle" };
    renderHistory();
    notify(wanted ? "Saved to your account." : "Removed from Saved.");
  } catch (error) {
    notify(error.message);
    button.disabled = false;
  }
}

async function removeItem(item, button) {
  button.disabled = true;
  try {
    await deleteCloudTranslation(item.id);
    state.history.items = state.history.items.filter((row) => row.id !== item.id);
    syncOpenTranslation(item.id, { translationId: null, isSaved: false });
    if (item.is_saved) { await refreshCloudSaved(); renderSaved(); }
    refreshButtons();
    focusRequest = { id: null, selector: ".filter-chip.is-active" };
    renderHistory();
    notify("Translation deleted.");
  } catch (error) {
    notify(error.message);
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ rendering */
function buildCard(item) {
  const title = firstLine(item.source_preview);
  const failed = item.status === "failed";
  const card = makeEl("article", `saved-card history-card is-${item.status}`);
  card.dataset.id = String(item.id);

  const badges = makeEl("div", "history-badges");
  const pair = item.source_language ? `${item.source_language} → ${item.target_language}` : item.target_language;
  badges.append(
    makeEl("span", "saved-language", pair),
    makeEl("span", `status-chip is-${item.status}`, STATUS_LABELS[item.status] || item.status)
  );
  if (item.repeat_count > 1) {
    const repeats = makeEl("span", "repeat-chip", `Repeated ×${item.repeat_count}`);
    repeats.title = `The same translation was run ${item.repeat_count} times in a row`;
    badges.append(repeats);
  }
  const top = makeEl("div", "saved-card-top");
  top.append(badges, makeEl("span", "saved-date", formatDateTime(item.created_at)));

  let previewText = String(item.target_preview || "");
  if (failed) previewText = `${STAGE_LABELS[item.error_stage] || "Problem"}: ${String(item.error_message || "").slice(0, 220)}`;
  if (item.status === "pending") previewText = "This translation didn't finish.";

  const actions = makeEl("div", "saved-card-actions");
  const openButton = makeEl("button", "text-button saved-open", item.status === "completed" ? "Open translation" : "Open source");
  openButton.type = "button";
  openButton.appendChild(makeIcon("arrow"));
  openButton.addEventListener("click", () => openItem(item, openButton));

  const tools = makeEl("div", "history-tools");
  if (item.status === "completed") {
    const label = item.is_saved ? "Remove from Saved" : "Save translation";
    const bookmark = makeEl("button", `icon-button bookmark-toggle${item.is_saved ? " is-saved" : ""}`);
    bookmark.type = "button";
    bookmark.title = label;
    bookmark.setAttribute("aria-label", `${label}: ${title}`);
    bookmark.setAttribute("aria-pressed", String(Boolean(item.is_saved)));
    bookmark.appendChild(makeIcon("bookmark"));
    bookmark.addEventListener("click", () => toggleBookmark(item, bookmark));
    tools.appendChild(bookmark);
  }

  // Deleting cannot be undone, so it takes two clicks: the first one asks "Delete?".
  const remove = makeEl("button", "icon-button delete-saved");
  remove.type = "button";
  remove.title = "Delete from history";
  remove.setAttribute("aria-label", `Delete from history: ${title}`);
  remove.append(makeIcon("trash"), makeEl("span", "confirm-label", "Delete?"));
  let timer = 0;
  const cancelConfirm = () => {
    clearTimeout(timer);
    remove.classList.remove("is-confirming");
    remove.setAttribute("aria-label", `Delete from history: ${title}`);
  };
  remove.addEventListener("click", () => {
    if (!remove.classList.contains("is-confirming")) {
      remove.classList.add("is-confirming");
      remove.setAttribute("aria-label", `Confirm delete: ${title}`);
      timer = setTimeout(cancelConfirm, 3500);
      return;
    }
    clearTimeout(timer);
    removeItem(item, remove);
  });
  remove.addEventListener("blur", cancelConfirm);
  tools.appendChild(remove);

  actions.append(openButton, tools);
  card.append(top, makeEl("h2", "", title), makeEl("pre", `saved-preview${failed ? " is-error" : ""}`, previewText), actions);
  return card;
}

export function renderHistory() {
  const signedIn = Boolean(state.user);
  $("historySignedOut").hidden = signedIn;
  $("historySignedIn").hidden = !signedIn;
  if (!signedIn) return;

  const h = state.history;
  const visible = h.items.filter((item) => matches(item, h.filter));

  document.querySelectorAll("[data-history-filter]").forEach((chip) => {
    const active = chip.dataset.historyFilter === h.filter;
    chip.classList.toggle("is-active", active);
    chip.setAttribute("aria-pressed", String(active));
  });

  const fragment = document.createDocumentFragment();
  visible.forEach((item) => fragment.appendChild(buildCard(item)));
  $("historyList").replaceChildren(fragment);
  $("historyList").setAttribute("aria-busy", String(h.loading));

  // Count line
  const countText = h.loading && !h.items.length ? "Loading…"
    : `${visible.length} ${visible.length === 1 ? "translation" : "translations"}${h.next ? " so far" : ""}`;
  $("historyCount").textContent = h.error && !h.items.length ? "" : countText;

  // Error with a retry link
  const errorBox = $("historyError");
  errorBox.hidden = !h.error;
  errorBox.replaceChildren();
  if (h.error) {
    const retry = makeEl("button", "link-button", "Try again");
    retry.type = "button";
    retry.addEventListener("click", () => loadHistory({ more: h.items.length > 0 && Boolean(h.next) }));
    errorBox.append(document.createTextNode(`${h.error} `), retry);
  }

  // Empty state and "Load more"
  const empty = !h.loading && !h.error && !visible.length && !h.next;
  $("historyEmpty").hidden = !empty;
  if (empty) {
    const [title, text] = EMPTY_TEXT[h.filter] || EMPTY_TEXT.all;
    $("historyEmptyTitle").textContent = title;
    $("historyEmptyText").textContent = text;
  }
  const more = $("historyMore");
  more.hidden = !h.next || Boolean(h.error);
  more.disabled = h.loading;
  more.textContent = h.loading && h.items.length ? "Loading…" : "Load more";

  if (focusRequest) {
    const { id, selector } = focusRequest;
    focusRequest = null;
    const scope = id ? $("historyList").querySelector(`[data-id="${id}"]`) : document;
    (scope?.querySelector(selector) || $("historyList").querySelector(".saved-open"))?.focus();
  }
}

/* ------------------------------------------------------------------ wiring */
export function initHistory() {
  document.querySelectorAll("[data-history-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const h = state.history;
      const next = chip.dataset.historyFilter;
      if (next === h.filter) return;
      const switchesList = (next === "saved") !== (h.filter === "saved");
      h.filter = next;
      if (switchesList) loadHistory();                      // "Saved" and the rest come from different queries
      else { autoPages = 0; renderHistory(); keepLoadingIfEmpty(); }
    });
  });
  $("historyMore").addEventListener("click", () => { if (!state.history.loading) loadHistory({ more: true }); });

  // Opening the page always shows fresh data (translations may have run since the last visit).
  document.addEventListener("sb:viewchange", (event) => {
    if (event.detail.view === "history" && state.user) loadHistory();
    else if (event.detail.view === "history") renderHistory();
  });

  // New account state: forget the previous person's rows straight away.
  document.addEventListener("sb:auth", (event) => {
    const h = state.history;
    if (event.detail.previous?.id !== event.detail.user?.id) {
      h.token += 1;                                          // ignore anything still on its way
      Object.assign(h, { items: [], next: null, filter: "all", source: "all", loading: false, error: "" });
    }
    renderHistory();
    if (state.user && state.currentView === "history" && event.detail.previous?.id !== event.detail.user.id) loadHistory();
  });

  renderHistory();
}