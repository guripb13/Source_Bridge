/* Sign in / create account dialog, the header account button, and the "Your account" dialog.
 *
 * Security notes (the server enforces all of this again; the page only gives quick feedback):
 *  - the password goes straight into one JSON request over the page's own origin. It is never
 *    written to storage or the DOM, and the fields are emptied whenever a dialog closes
 *  - error text is set with textContent only, so nothing a server returns can inject markup
 *  - sign-in failures use one generic message, so the page never reveals which accounts exist
 *  - the login cookie is HttpOnly + SameSite, so this script cannot read or leak it
 */
import { $ } from "../core/dom.js";
import { AUTH_RULES, endpoints } from "../core/config.js";
import { state } from "../core/state.js";
import { notify } from "../core/feedback.js";
import { signIn, signUp, signOut, deleteAccount } from "./session.js";
import { api } from "./api.js";
import { showAppDialog } from "../ui/dialogs.js";

const MODES = {
  login: {
    title: "Welcome back",
    lead: "Sign in to keep a history of your translations and save the ones you like.",
    submit: "Sign in", busy: "Signing in…",
    switchText: "New here?", switchLabel: "Create an account", switchTo: "signup",
    fields: ["identifier", "password"], passwordHint: "Your password", autocomplete: "current-password"
  },
  signup: {
    title: "Create your account",
    lead: "An account keeps every translation you run and lets you save your favourites.",
    submit: "Create account", busy: "Creating account…",
    switchText: "Already have an account?", switchLabel: "Sign in", switchTo: "login",
    fields: ["username", "email", "password", "confirm"], passwordHint: `At least ${AUTH_RULES.passwordMin} characters`, autocomplete: "new-password"
  }
};

const FIELDS = {
  username:   { wrap: "fieldUsername",   input: "authUsername",   error: "errorUsername" },
  identifier: { wrap: "fieldIdentifier", input: "authIdentifier", error: "errorIdentifier" },
  email:      { wrap: "fieldEmail",      input: "authEmail",      error: "errorEmail" },
  password:   { wrap: "fieldPassword",   input: "authPassword",   error: "errorPassword" },
  confirm:    { wrap: "fieldConfirm",    input: "authConfirm",    error: "errorConfirm" }
};

let mode = "login";
let busy = false;

/* ------------------------------------------------------------------ small helpers */
const input = (name) => $(FIELDS[name].input);

function showFieldError(name, message) {
  const field = FIELDS[name];
  $(field.error).textContent = message || "";
  $(field.error).hidden = !message;
  if (message) input(name).setAttribute("aria-invalid", "true");
  else input(name).removeAttribute("aria-invalid");
}

function showMessage(id, message) {
  $(id).textContent = message || "";
  $(id).hidden = !message;
}

function clearErrors() {
  Object.keys(FIELDS).forEach((name) => showFieldError(name, ""));
  showMessage("authMessage", "");
  resetUsernameCheck();
}

/* ------------------------------------------------------------------ live username check
 * While someone types a new username, ask the server (it answers from username_index.db) and
 * show "available" / "taken" straight away. This is only a convenience: the server checks again
 * when the account is really created, so a stale answer can never create a duplicate. */
const USERNAME_CHECK_DELAY = 300;     // ms of silence after typing before we ask
let usernameTimer = 0;
let usernameRequest = null;           // AbortController of the request in flight
let usernameResult = null;            // { value, available } of the last answer for the current text

function usernameStatusEl() {
  let el = $("statusUsername");
  if (!el) {                                    // created once, right under the username field
    el = document.createElement("small");
    el.id = "statusUsername";
    el.className = "field-status";
    el.setAttribute("aria-live", "polite");
    el.hidden = true;
    $(FIELDS.username.error).after(el);
  }
  return el;
}

function showUsernameStatus(message, kind) {
  const el = usernameStatusEl();
  el.textContent = message || "";
  el.hidden = !message;
  el.dataset.kind = kind || "";
}

function resetUsernameCheck() {
  clearTimeout(usernameTimer);
  if (usernameRequest) { usernameRequest.abort(); usernameRequest = null; }
  usernameResult = null;
  showUsernameStatus("", "");
}

function normalizeLowercaseInput(field) {
  const original = field.value;
  const normalized = original.toLowerCase();
  if (original === normalized) return;

  const start = field.type === "email" ? null : field.selectionStart;
  const end = field.type === "email" ? null : field.selectionEnd;
  field.value = normalized;
  if (start !== null && end !== null) {
    field.setSelectionRange(
      original.slice(0, start).toLowerCase().length,
      original.slice(0, end).toLowerCase().length
    );
  }
}

function onUsernameTyping() {
  const usernameInput = input("username");
  normalizeLowercaseInput(usernameInput);
  resetUsernameCheck();
  if (mode !== "signup") return;
  const value = usernameInput.value.trim();
  if (!value) return;
  if (!/^[A-Za-z0-9_.\-]*$/.test(value) || value.length > 30) {
    showUsernameStatus("Only letters, numbers, . _ - (max 30 characters).", "bad");
    return;
  }
  if (!AUTH_RULES.usernamePattern.test(value)) return;     // still too short: stay quiet
  showUsernameStatus("Checking…", "wait");
  usernameTimer = setTimeout(() => checkUsername(value), USERNAME_CHECK_DELAY);
}

async function checkUsername(value) {
  const controller = new AbortController();
  usernameRequest = controller;
  try {
    const url = `${endpoints.usernameAvailable}?username=${encodeURIComponent(value)}`;
    const data = await api("GET", url, undefined, { signal: controller.signal, credentialsCheck: true });
    if (controller.signal.aborted || input("username").value.trim() !== value) return;
    usernameResult = { value, available: Boolean(data.available) };
    if (data.available) showUsernameStatus("Username is available.", "ok");
    else { showUsernameStatus("", ""); showFieldError("username", "That username is already taken."); }
  } catch (error) {
    if (error?.name === "AbortError") return;
    showUsernameStatus("", "");                 // couldn't check: the real sign-up still checks
  } finally {
    if (usernameRequest === controller) usernameRequest = null;
  }
}

function values() {
  return {
    username: input("username").value.trim().toLowerCase(),
    identifier: input("identifier").value.trim().toLowerCase(),
    email: input("email").value.trim().toLowerCase(),
    password: input("password").value,        // never trimmed: spaces may be part of a password
    confirm: input("confirm").value
  };
}

/* ------------------------------------------------------------------ password strength (advisory only) */
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "12345678", "123456789", "1234567890", "qwertyui", "qwerty123",
  "qwertyuiop", "iloveyou", "11111111", "abc12345", "letmein123", "welcome123", "admin123", "00000000"
]);

export function passwordStrength(password) {
  if (!password) return { level: 0, label: "" };
  if (password.length < AUTH_RULES.passwordMin) return { level: 1, label: `Weak. Use at least ${AUTH_RULES.passwordMin} characters.` };
  if (COMMON_PASSWORDS.has(password.toLowerCase()) || /^(.)\1+$/.test(password)) return { level: 1, label: "Weak. That is too easy to guess." };
  let score = 0;
  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;
  if (score <= 1) return { level: 2, label: "Fair. Add length or a mix of characters." };
  if (score <= 3) return { level: 3, label: "Good." };
  return { level: 4, label: "Strong." };
}

function renderStrength() {
  const meter = $("passwordMeter");
  const result = mode === "signup" ? passwordStrength(input("password").value) : { level: 0, label: "" };
  meter.hidden = result.level === 0;
  meter.dataset.level = String(result.level);
  $("passwordMeterLabel").textContent = result.label ? `Password strength: ${result.label}` : "";
}

/* ------------------------------------------------------------------ mode (sign in <-> create account) */
function setMode(next) {
  mode = next;
  const config = MODES[mode];
  $("authTitle").textContent = config.title;
  $("authLead").textContent = config.lead;
  $("authSubmitLabel").textContent = config.submit;
  $("authSwitchText").textContent = config.switchText;
  $("authSwitch").textContent = config.switchLabel;
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    const active = tab.dataset.authMode === mode;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  Object.entries(FIELDS).forEach(([name, field]) => { $(field.wrap).hidden = !config.fields.includes(name); });
  input("identifier").autocomplete = mode === "login" ? "username" : "off";
  input("password").autocomplete = config.autocomplete;
  input("confirm").autocomplete = "off";
  input("password").placeholder = config.passwordHint;
  clearErrors();
  renderStrength();
}

function focusFirstField() {
  const first = MODES[mode].fields[0];
  requestAnimationFrame(() => input(first).focus());
}

export function openAuthDialog(next = "login") {
  if (state.user) { openAccountDialog(); return; }
  const dialog = $("authDialog");
  setMode(next);
  showAppDialog(dialog);
  focusFirstField();
}

/* ------------------------------------------------------------------ validation */
function validate() {
  const v = values();
  const errors = {};
  if (mode === "login") {
    if (!v.identifier) errors.identifier = "Enter your username or email.";
    if (!v.password) errors.password = "Enter your password.";
    return errors;
  }
  if (!AUTH_RULES.usernamePattern.test(v.username)) errors.username = "Username must be 3-30 characters: letters, numbers, . _ -";
  else if (usernameResult && usernameResult.value === v.username && !usernameResult.available) errors.username = "That username is already taken.";
  if (v.email.length > AUTH_RULES.emailMax || !AUTH_RULES.emailPattern.test(v.email)) errors.email = "Please enter a valid email address.";
  if (v.password.length < AUTH_RULES.passwordMin || v.password.length > AUTH_RULES.passwordMax) {
    errors.password = `Password must be ${AUTH_RULES.passwordMin}-${AUTH_RULES.passwordMax} characters long.`;
  } else if (!v.confirm) {
    errors.confirm = "Type the password again to confirm it.";
  } else if (v.confirm !== v.password) {
    errors.confirm = "The two passwords don't match.";
  }
  return errors;
}

function showErrors(errors) {
  let first = null;
  MODES[mode].fields.forEach((name) => {
    showFieldError(name, errors[name]);
    if (errors[name] && !first) first = name;
  });
  if (first) input(first).focus();
}

function setBusy(value) {
  busy = value;
  $("authForm").setAttribute("aria-busy", String(value));
  $("authSubmit").disabled = value;
  $("authSwitch").disabled = value;
  document.querySelectorAll(".auth-tab").forEach((tab) => { tab.disabled = value; });
  $("authSubmitLabel").textContent = value ? MODES[mode].busy : MODES[mode].submit;
}

/* The server answered with an error: show it on the right field, or above the button. */
function showServerError(error) {
  const field = error.field && MODES[mode].fields.includes(error.field) ? error.field : null;
  if (field) { showFieldError(field, error.message); input(field).focus(); return; }
  showMessage("authMessage", error.message || "Something went wrong. Please try again.");
}

async function submitAuth(event) {
  event.preventDefault();
  if (busy) return;
  clearErrors();
  const errors = validate();
  if (Object.keys(errors).length) { showErrors(errors); return; }

  const v = values();
  const creating = mode === "signup";
  const remember = $("authRemember").checked;     // "Keep me signed in on this device"
  setBusy(true);
  try {
    const user = creating
      ? await signUp({ username: v.username, email: v.email, password: v.password, remember })
      : await signIn(v.identifier, v.password, remember);
    $("authDialog").close();                       // the close handler empties every field
    notify(creating ? `Account created. Welcome, ${user.username}!` : `Welcome back, ${user.username}.`);
  } catch (error) {
    if (error?.name === "ApiError") showServerError(error);
    else showMessage("authMessage", "Something went wrong. Please try again.");
    input("password").value = "";                  // a failed attempt never leaves the password behind
    input("confirm").value = "";
    renderStrength();
  } finally {
    setBusy(false);
  }
}

function resetAuthDialog() {
  input("password").value = "";
  input("confirm").value = "";
  $("authShowPassword").checked = false;
  togglePasswordVisibility(false);
  clearErrors();
  renderStrength();
  setBusy(false);
}

function togglePasswordVisibility(show) {
  input("password").type = show ? "text" : "password";
  input("confirm").type = show ? "text" : "password";
}

/* ------------------------------------------------------------------ header button + account dialog */
function renderAccountButton() {
  const user = state.user;
  const button = $("accountButton");
  const username = user?.username || "";
  const displayName = username
    ? username[0].toUpperCase() + username.slice(1).toLowerCase()
    : "";
  const label = user ? `Account: ${displayName}` : "Sign in or create an account";
  button.classList.toggle("is-signed-in", Boolean(user));
  $("accountInitial").textContent = displayName[0] || "";
  $("accountLabel").textContent = user ? displayName : "Sign In";
  button.setAttribute("aria-label", label);
  button.title = label;
}

function openAccountDialog() {
  const user = state.user;
  if (!user) { openAuthDialog("login"); return; }
  const joined = new Date(user.created_at);
  $("accountAvatar").textContent = (user.username[0] || "?").toUpperCase();
  $("accountName").textContent = user.username;
  $("accountEmail").textContent = user.email;
  $("accountSince").textContent = Number.isNaN(joined.getTime()) ? "" : `Member since ${joined.toLocaleDateString(undefined, { month: "long", year: "numeric" })}`;
  resetAccountDialog();
  const dialog = $("accountDialog");
  showAppDialog(dialog);
}

function resetAccountDialog() {
  $("deletePassword").value = "";
  $("deleteForm").hidden = true;
  $("deleteToggle").setAttribute("aria-expanded", "false");
  showMessage("deleteMessage", "");
  showMessage("accountMessage", "");
  $("deleteSubmit").disabled = false;
  $("accountSignOut").disabled = false;
  $("accountSignOutLabel").textContent = "Sign out";
}

async function handleSignOut() {
  const button = $("accountSignOut");
  button.disabled = true;
  $("accountSignOutLabel").textContent = "Signing out…";
  showMessage("accountMessage", "");
  try {
    await signOut();
    $("accountDialog").close();
    notify("Signed out. Your history stays safe in your account.");
  } catch (error) {
    // The request failed, so the server may still consider us signed in: say so honestly.
    showMessage("accountMessage", error?.message || "Couldn't sign out. Please try again.");
    button.disabled = false;
    $("accountSignOutLabel").textContent = "Sign out";
  }
}

async function handleDelete(event) {
  event.preventDefault();
  const password = $("deletePassword").value;
  showMessage("deleteMessage", "");
  if (!password) { showMessage("deleteMessage", "Enter your password to confirm."); $("deletePassword").focus(); return; }
  $("deleteSubmit").disabled = true;
  try {
    await deleteAccount(password);
    $("accountDialog").close();
    notify("Your account and its history were deleted.");
  } catch (error) {
    showMessage("deleteMessage", error?.message || "Couldn't delete the account. Please try again.");
    $("deletePassword").value = "";
    $("deletePassword").focus();
    $("deleteSubmit").disabled = false;
  }
}

/* ------------------------------------------------------------------ wiring */
export function initAuth() {
  // Header button: sign in when visiting, account menu when signed in.
  $("accountButton").addEventListener("click", () => (state.user ? openAccountDialog() : openAuthDialog("login")));
  $("historySignInButton").addEventListener("click", () => openAuthDialog("login"));

  // Sign in / create account form
  $("authForm").addEventListener("submit", submitAuth);
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => { if (!busy) { setMode(tab.dataset.authMode); focusFirstField(); } });
    tab.addEventListener("keydown", (event) => {            // arrow keys move between the two tabs
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || busy) return;
      event.preventDefault();
      const next = MODES[tab.dataset.authMode].switchTo;
      setMode(next);
      $(next === "login" ? "tabLogin" : "tabSignup").focus();
    });
  });
  $("authSwitch").addEventListener("click", () => { if (!busy) { setMode(MODES[mode].switchTo); focusFirstField(); } });
  $("authShowPassword").addEventListener("change", (event) => togglePasswordVisibility(event.target.checked));
  input("password").addEventListener("input", () => { renderStrength(); showFieldError("password", ""); showFieldError("confirm", ""); });
  Object.keys(FIELDS).forEach((name) => {
    if (name !== "password") input(name).addEventListener("input", () => {
      if (name === "identifier" || name === "email") normalizeLowercaseInput(input(name));
      showFieldError(name, "");
      showMessage("authMessage", "");
    });
  });
  input("username").addEventListener("input", onUsernameTyping);
  $("authDialog").addEventListener("close", resetAuthDialog);

  // Account dialog
  $("accountHistory").addEventListener("click", () => { $("accountDialog").close(); $("historyNav").click(); });
  $("accountSignOut").addEventListener("click", handleSignOut);
  $("deleteToggle").addEventListener("click", () => {
    const open = $("deleteForm").hidden;
    $("deleteForm").hidden = !open;
    $("deleteToggle").setAttribute("aria-expanded", String(open));
    if (open) $("deletePassword").focus();
  });
  $("deleteForm").addEventListener("submit", handleDelete);
  $("accountDialog").addEventListener("close", resetAccountDialog);

  // Keep the header (and any open dialog) in step with the real sign-in state.
  document.addEventListener("sb:auth", () => {
    renderAccountButton();
    if (state.user && $("authDialog").open) $("authDialog").close();
    if (!state.user && $("accountDialog").open) $("accountDialog").close();
  });
  renderAccountButton();
  setMode("login");
}