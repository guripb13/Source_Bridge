/* Language logos: shown in the panel headings. Loaded from the CDN; hidden if it can't be reached. */
import { logoUrl } from "../core/config.js";

// `img` is the <img> in the heading; `heading` is its <h2> (gets .has-logo so the generic icon hides).
export function setHeadingLogo(img, heading, language) {
  const url = language ? logoUrl(language) : "";
  if (!url) { img.hidden = true; heading.classList.remove("has-logo"); img.removeAttribute("src"); return; }
  if (img.getAttribute("src") === url) return;
  img.onload = () => { img.hidden = false; heading.classList.add("has-logo"); };
  img.onerror = () => { img.hidden = true; heading.classList.remove("has-logo"); };
  img.src = url;
}
