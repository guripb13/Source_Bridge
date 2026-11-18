/* Constants. Nothing here talks to the server; the endpoints are the existing ones. */
export const keys = {
  preferences: "sourceBridge.preferences.v1",
  saved: "sourceBridge.saved.v1",
  sidebar: "sourceBridge.sidebarCollapsed",
  editorHeight: "sourceBridge.editorHeight"
};

export const endpoints = { execute: document.body.dataset.executeUrl || "/execute" };

// Languages compiler.py can build and run -> the name /execute expects.
export const executableLanguages = { python: "python", java: "java", c: "c", "c++": "cpp" };

export const extensionMap = {
  python: "py", java: "java", c: "c", "c++": "cpp", javascript: "js",
  typescript: "ts", "c#": "cs", go: "go", rust: "rs", php: "php",
  swift: "swift", kotlin: "kt", ruby: "rb", sql: "sql", html: "html",
  css: "css", json: "json", xml: "xml", bash: "sh", shell: "sh",
  r: "r", lua: "lua", scala: "scala", dart: "dart"
};

// Upload whitelist: only source files of the four supported languages.
export const uploadExtensions = {
  py: "Python",
  java: "Java",
  c: "C", h: "C",
  cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++", hh: "C++", hxx: "C++"
};
export const MAX_UPLOAD_BYTES = 1024 * 1024;

// Devicon slugs for the language logos (loaded from the CDN; hidden if unreachable).
export const logoSlugs = { python: "python", java: "java", c: "c", "c++": "cplusplus" };
export const logoUrl = (language) => {
  const slug = logoSlugs[String(language || "").trim().toLowerCase()];
  return slug ? `https://cdn.jsdelivr.net/gh/devicons/devicon/icons/${slug}/${slug}-original.svg` : "";
};

// Personalization: the text is sent as this extra form field, only when the box is not empty.
// The current server ignores unknown fields, so it has no effect until the server reads it.
export const INSTRUCTIONS_FIELD = "instructions";
export const MAX_INSTRUCTIONS = 500;

export const MAX_SAVED = 30;
