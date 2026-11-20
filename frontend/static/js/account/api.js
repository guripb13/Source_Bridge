/* One small wrapper around fetch() for every account / history call.
 *  - always sends the login cookie (same origin) and never caches the answer
 *  - JSON in, JSON out
 *  - failures become an ApiError with a message that is safe to show to the person
 */
export class ApiError extends Error {
  constructor(message, { status = 0, field = null, network = false } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.field = field;        // which form field the server complained about (username / email / password)
    this.network = network;    // the request never reached the server
  }
}

let unauthorizedHandler = null;
/* Called when a protected route answers 401 ("Please sign in first."), which means the
 * login cookie expired or the account was removed. session.js uses it to sign the page out. */
export function onUnauthorized(handler) { unauthorizedHandler = handler; }

function messageFor(status, serverMessage) {
  if (serverMessage) return serverMessage;
  if (status === 429) return "Too many attempts. Wait a minute and try again.";
  if (status === 413) return "That request was too large.";
  if (status >= 500) return "The server had a problem. Please try again in a moment.";
  return `The request failed (${status}). Please try again.`;
}

/* method: "GET" | "POST" | "DELETE"; body: a plain object or undefined.
 * options.credentialsCheck: set true for routes where a 401 means "wrong password",
 * not "your session ended" (login, delete account). */
export async function api(method, url, body, options = {}) {
  const init = {
    method,
    credentials: "same-origin",
    cache: "no-store",
    signal: options.signal,
    headers: { Accept: "application/json" }
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ApiError("Can't reach the server. Check your connection and try again.", { network: true });
  }

  let data = null;
  try { data = await response.json(); } catch (_) { /* empty or non-JSON body */ }

  if (!response.ok) {
    if (response.status === 401 && !options.credentialsCheck && unauthorizedHandler) unauthorizedHandler();
    throw new ApiError(messageFor(response.status, data?.error), { status: response.status, field: data?.field || null });
  }
  return data ?? {};
}
