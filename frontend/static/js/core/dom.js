/* Shared DOM lookups and tiny element helpers. Modules are evaluated after the page is parsed. */
export const $ = (id) => document.getElementById(id);

export const dom = {
  form: $("form"),
  source: $("message"),
  output: $("translatedCode"),
  language: $("language"),
  sourceLanguage: $("sourceLanguage"),
  translateButton: $("translateButton"),
  sidebar: $("sidebar"),
  sidebarToggle: $("sidebarToggle")
};

export function makeEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function makeIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", name.startsWith("#") ? name : `#i-${name}`);
  svg.appendChild(use);
  return svg;
}
