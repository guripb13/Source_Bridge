/* Custom themed dropdown for the language selects (Translate from / to).
   The native <select> stays in the DOM as the source of truth, so existing
   code that reads select.value, option.disabled or listens for "change" keeps working. */

export function initLanguageDropdown() {

  const ICON_SLUGS = {
    "python": "python", "java": "java", "c": "c", "c++": "cplusplus", "cpp": "cplusplus",
    "javascript": "javascript", "js": "javascript", "typescript": "typescript", "ts": "typescript",
    "c#": "csharp", "csharp": "csharp", "go": "go", "golang": "go", "rust": "rust",
    "php": "php", "swift": "swift", "kotlin": "kotlin", "ruby": "ruby", "sql": "mysql",
    "mysql": "mysql", "node": "nodejs", "nodejs": "nodejs", "r": "r", "dart": "dart",
    "scala": "scala", "perl": "perl", "haskell": "haskell", "lua": "lua",
    "html": "html5", "css": "css3", "bash": "bash", "shell": "bash"
  };
  const iconUrl = (value) => {
    const slug = ICON_SLUGS[(value || "").trim().toLowerCase()];
    return slug ? `https://cdn.jsdelivr.net/gh/devicons/devicon/icons/${slug}/${slug}-original.svg` : "";
  };

  const instances = [];
  const closeAll = (except) => instances.forEach((inst) => { if (inst !== except) inst.close(false); });

  document.querySelectorAll(".language-select").forEach(enhance);

  // Click outside or resize closes any open list
  document.addEventListener("pointerdown", (event) => {
    instances.forEach((inst) => { if (!inst.wrap.contains(event.target)) inst.close(false); });
  });
  window.addEventListener("resize", () => closeAll());

  function enhance(wrap) {
    const select = wrap.querySelector("select");
    if (!select) return;

    const menuId = `${select.id || "lang"}Menu`;
    const menu = document.createElement("ul");
    menu.className = "lang-menu";
    menu.id = menuId;
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", select.getAttribute("aria-label") || "Language");
    wrap.appendChild(menu);
    wrap.classList.add("has-menu");

    select.setAttribute("aria-haspopup", "listbox");
    select.setAttribute("aria-expanded", "false");
    select.setAttribute("aria-controls", menuId);

    let items = [];
    let active = -1;
    let isOpen = false;
    let typed = "";
    let typedTimer = 0;

    function build() {
      menu.textContent = "";
      items = [];
      Array.from(select.options).forEach((option) => {
        if (option.disabled || option.hidden) return;   // e.g. the language already chosen as source
        const li = document.createElement("li");
        li.className = "lang-option";
        li.id = `${menuId}-${items.length}`;
        li.setAttribute("role", "option");
        li.dataset.value = option.value;
        li.setAttribute("aria-selected", String(option.value === select.value));

        const url = iconUrl(option.value);
        if (url) {
          const img = new Image();
          img.className = "lang-option-icon";
          img.alt = "";
          img.setAttribute("aria-hidden", "true");
          img.onerror = () => img.remove();
          img.src = url;
          li.appendChild(img);
        }
        const label = document.createElement("span");
        label.className = "lang-option-label";
        label.textContent = option.textContent;
        li.appendChild(label);

        const check = document.createElement("span");
        check.innerHTML = '<svg class="icon lang-check" aria-hidden="true"><use href="#i-check"/></svg>';
        li.appendChild(check.firstChild);

        items.push(li);
        menu.appendChild(li);
      });
    }

    function setActive(index) {
      if (!items.length) return;
      active = Math.max(0, Math.min(items.length - 1, index));
      items.forEach((li, i) => li.classList.toggle("is-active", i === active));
      select.setAttribute("aria-activedescendant", items[active].id);
      items[active].scrollIntoView({ block: "nearest" });
    }

    function open() {
      if (select.disabled || isOpen) return;
      closeAll(inst);
      build();
      if (!items.length) return;
      // Flip upward when there is not enough room below
      const rect = wrap.getBoundingClientRect();
      const need = Math.min(menu.scrollHeight, 320) + 16;
      const below = window.innerHeight - rect.bottom;
      wrap.classList.toggle("opens-up", below < need && rect.top > below);
      isOpen = true;
      wrap.classList.add("is-open");
      select.setAttribute("aria-expanded", "true");
      select.focus({ preventScroll: true });
      const selected = items.findIndex((li) => li.getAttribute("aria-selected") === "true");
      setActive(selected >= 0 ? selected : 0);
    }

    function close(returnFocus = true) {
      if (!isOpen) return;
      isOpen = false;
      wrap.classList.remove("is-open");
      select.setAttribute("aria-expanded", "false");
      select.removeAttribute("aria-activedescendant");
      if (returnFocus) select.focus({ preventScroll: true });
    }

    function choose(index) {
      const li = items[index];
      if (!li) return;
      const changed = select.value !== li.dataset.value;
      select.value = li.dataset.value;
      close();
      if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Mouse / touch
    wrap.addEventListener("click", (event) => {
      const li = event.target.closest(".lang-option");
      if (li && menu.contains(li)) { choose(items.indexOf(li)); return; }
      if (menu.contains(event.target)) return;
      isOpen ? close() : open();
    });
    menu.addEventListener("pointermove", (event) => {
      const li = event.target.closest(".lang-option");
      if (li) { const i = items.indexOf(li); if (i !== active) setActive(i); }
    });

    // Keyboard (the select keeps focus, so Tab order and labels are unchanged)
    select.addEventListener("keydown", (event) => {
      const key = event.key;
      if (!isOpen) {
        if (["ArrowDown", "ArrowUp", "Enter", " ", "F4"].includes(key)) {
          event.preventDefault();
          open();
        }
        return;
      }
      if (key === "ArrowDown") { event.preventDefault(); setActive(active + 1); }
      else if (key === "ArrowUp") { event.preventDefault(); setActive(active - 1); }
      else if (key === "Home") { event.preventDefault(); setActive(0); }
      else if (key === "End") { event.preventDefault(); setActive(items.length - 1); }
      else if (key === "Enter" || key === " ") { event.preventDefault(); choose(active); }
      else if (key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      else if (key === "Tab") { close(false); }
      else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        typed += key.toLowerCase();
        clearTimeout(typedTimer);
        typedTimer = setTimeout(() => { typed = ""; }, 600);
        const hit = items.findIndex((li) => li.textContent.trim().toLowerCase().startsWith(typed));
        if (hit >= 0) setActive(hit);
      }
    });
        // Pressing an option must not blur the select. Blurring closes the list
    // before the click lands, so the choice would never register.
    let pressingMenu = false;
    menu.addEventListener("pointerdown", () => { pressingMenu = true; });
    menu.addEventListener("mousedown", (event) => event.preventDefault());   // keep focus on the select
    const releaseMenu = () => { setTimeout(() => { pressingMenu = false; }, 0); };
    document.addEventListener("pointerup", releaseMenu);
    document.addEventListener("pointercancel", releaseMenu);
    select.addEventListener("blur", () => { if (!pressingMenu) close(false); });

    // Close if the select gets disabled (e.g. while a translation is running)
    new MutationObserver(() => { if (select.disabled) close(false); })
      .observe(select, { attributes: true, attributeFilter: ["disabled"] });

    const inst = { wrap, close };
    instances.push(inst);
  }
}
