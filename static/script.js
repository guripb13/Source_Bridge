const page = document.querySelector(".page");        
const form = document.getElementById("form");
const box = document.getElementById("message");
const messages = document.getElementById("messages");
const title = document.getElementById("title");
// Outward arrows = expand, inward arrows = shrink

const composer = form;
const expandBtn = document.getElementById("expandBtn");

expandBtn.addEventListener("click", function () {
  const expanded = composer.classList.toggle("expanded");
  expandBtn.title = expanded ? "Shrink input" : "Expand input";
  box.focus();
});


// ---------- Hint: "click here to expand" when the text gets long ----------
const expandHint = document.getElementById("expandHint");
let hintShown = false;                 // only show it once per page load
let hintTimer;

function hideExpandHint() {
  expandHint.classList.remove("show");
  expandBtn.classList.remove("attention");
  clearTimeout(hintTimer);
}

// Counts how many lines the text takes up, including wrapped lines
function countLines() {
  const lineHeight = parseFloat(getComputedStyle(box).lineHeight) || 24;
  return Math.round(box.scrollHeight / lineHeight);
}

box.addEventListener("input", function () {
  if (hintShown) return;                                   // already shown once
  if (composer.classList.contains("expanded")) return;     // already expanded
  if (countLines() <= 2) return;                           // still short

  hintShown = true;
  expandHint.classList.add("show");
  expandBtn.classList.add("attention");
  hintTimer = setTimeout(hideExpandHint, 6000);            // auto-hide after 6 seconds
});

// Clicking the expand button dismisses the hint
expandBtn.addEventListener("click", hideExpandHint);

// one time tip about dragging messages

const tip = document.getElementById("tip");
const tipClose = document.getElementById("tipClose");
let tipTimer;

function hideTip() {
  tip.classList.remove("show");
  clearTimeout(tipTimer);

  // the tip is gone, so now the Tips button can appear
  setTimeout(function () {
    document.getElementById("tipsCorner").classList.add("available");
  }, 400);                                  // wait for the tip's slide-away to finish
}

// Shows the tip only the very first time (remembered in this browser)
function showTipOnce() {
  if (localStorage.getItem("dragTipSeen")) return;      // already seen, do nothing
  localStorage.setItem("dragTipSeen", "yes");

  setTimeout(function () {
    tip.classList.add("show");
    tipTimer = setTimeout(hideTip, 7000);
  }, 700);
}



// Returning users who already saw the first tip get the Tips button immediately
if (localStorage.getItem("dragTipSeen")) {
  document.getElementById("tipsCorner").classList.add("available");
}
tipClose.addEventListener("click", hideTip);




// adding the copy button to the message div
// Builds a message bubble with a copy button under it.
// Returns the bubble (so text can be added to it later).
function createBubble(className, text) {
  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap";

  const bubble = document.createElement("div");
  bubble.className = className;
  bubble.textContent = text;
  bubble.draggable = document.body.classList.contains("drag-mode"); 
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "copy-btn";
  copyBtn.title = "Copy";
  copyBtn.innerHTML = COPY_ICON;

  copyBtn.addEventListener("click", async function () {
    try {
      await navigator.clipboard.writeText(bubble.textContent);
      copyBtn.innerHTML = TICK_ICON;
      copyBtn.classList.add("copied");
      setTimeout(function () {
        copyBtn.innerHTML = COPY_ICON;
        copyBtn.classList.remove("copied");
      }, 1500);
    } catch (error) {
      copyBtn.title = "Copy failed";
    }
  });

  wrap.appendChild(bubble);
  wrap.appendChild(copyBtn);
  messages.appendChild(wrap);

  // Show the copy button only when there is text
  wrap.classList.toggle("has-text", text.trim() !== "");

  return bubble;
}

// Marks only the newest message and reply as "latest"
function markLatest(...wraps) {
  document.querySelectorAll(".bubble-wrap.latest").forEach(function (w) {
    w.classList.remove("latest");
  });
  wraps.forEach(function (w) { w.classList.add("latest"); });
}


// The two icons (copy and tick)
const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const TICK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
// Leaves the empty state with a smooth animation
function leaveEmptyState() {
  if (!page.classList.contains("empty")) return;     // only runs once

  // 1. Measure where the heading and input box are now
  const titleBefore = title.getBoundingClientRect();
  const formBefore = form.getBoundingClientRect();

  // 2. Switch to the final layout (this happens instantly)
  page.classList.remove("empty");

  // 3. Measure where they ended up
  const titleAfter = title.getBoundingClientRect();
  const formAfter = form.getBoundingClientRect();

  // 4. Animate each one from its old position to its new position
  const timing = { duration: 600, easing: "ease" };

  title.animate([
    { transform: `translateY(${titleBefore.top - titleAfter.top}px)` },
    { transform: "translateY(0)" }
  ], timing);

  form.animate([
    { transform: `translateY(${formBefore.top - formAfter.top}px)` },
    { transform: "translateY(0)" }
  ], timing);

  messages.animate([
    { opacity: 0 },
    { opacity: 1 }
  ], timing);
}


// Makes a new bubble fly up from the input box to its place in the chat
function flyFromInput(bubbleWrap, inputRect) {
  const end = bubbleWrap.getBoundingClientRect();

  // Offset from the final spot back to the input box
  const dx = inputRect.left - end.left;
  const dy = inputRect.top - end.top;

  bubbleWrap.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(0.92)`, opacity: 0.3 },
    { transform: "translate(0, 0) scale(1)", opacity: 1 }
  ], { duration: 550, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
}

// Slides the older messages smoothly when new content pushes them
function slideOlderMessages(oldPositions) {
  document.querySelectorAll(".bubble-wrap").forEach(function (wrap) {
    const before = oldPositions.get(wrap);
    if (before === undefined) return;            // new bubbles are handled elsewhere

    const shift = before - wrap.getBoundingClientRect().top;
    if (shift === 0) return;

    wrap.animate([
      { transform: `translateY(${shift}px)` },
      { transform: "translateY(0)" }
    ], { duration: 450, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
  });
}



  // Enter sends, Shift+Enter makes a new line
  box.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener("submit", async function (event) {
    event.preventDefault();

    const text = box.value.trim();
    if (!text) return;

    // Remember where the typed text is, before anything changes
    const inputRect = box.getBoundingClientRect();

    // Remember where every older message is right now
    const oldPositions = new Map();
    document.querySelectorAll(".bubble-wrap").forEach(function (wrap) {
      oldPositions.set(wrap, wrap.getBoundingClientRect().top);
    });

    leaveEmptyState();                                 // smooth slide to the final layout
    showTipOnce();

    // 1. Show the user's message
    const userDiv = createBubble("message", text);

    // 2. Create an empty reply box that we will fill up
    const replyDiv = createBubble("message reply", "");

    // Only this new pair keeps its copy button visible
    markLatest(userDiv.parentElement, replyDiv.parentElement);

    // Scroll to the newest message, then animate
    messages.scrollTop = messages.scrollHeight;
    slideOlderMessages(oldPositions);
    flyFromInput(userDiv.parentElement, inputRect);

    // 3. Send the form to Flask
    const data = new FormData(form);
    box.value = "";
    composer.classList.remove("expanded"); 

    // 4. Read the reply piece by piece
    try {
      const response = await fetch("/send", { method: "POST", body: data });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const result = await reader.read();
        if (result.done) break;
        replyDiv.textContent += decoder.decode(result.value, { stream: true });
        replyDiv.parentElement.classList.add("has-text");
        messages.scrollTop = messages.scrollHeight;
      }
    } catch (error) {
      replyDiv.textContent = "Error: " + error.message;
      replyDiv.parentElement.classList.add("has-text");
    }
  });

  // language selector
  // ---------- Language picker ----------
const langPicker = document.getElementById("langPicker");
const langBtn = document.getElementById("langBtn");
const langMenu = document.getElementById("langMenu");
const langLabel = document.getElementById("langLabel");
const langOther = document.getElementById("langOther");
const languageField = document.getElementById("language");
const options = document.querySelectorAll(".lang-option");

// Open / close the menu when the button is clicked
langBtn.addEventListener("click", function (event) {
  event.stopPropagation();
  langPicker.classList.toggle("open");
});

// Clicking anywhere else closes the menu
document.addEventListener("click", function (event) {
  if (!langPicker.contains(event.target)) {
    langPicker.classList.remove("open");
  }
});

// Choosing an option
options.forEach(function (option) {
  option.addEventListener("click", function () {
    options.forEach(function (o) { o.classList.remove("active"); });
    option.classList.add("active");

    const lang = option.dataset.lang;

    if (lang === "other") {
      langMenu.classList.add("show-other");       // reveal the text box
      langOther.focus();
      langLabel.textContent = langOther.value.trim() || "Other";
      languageField.value = langOther.value.trim() || "Other";
      langDone.disabled = langOther.value.trim() === "";  
    } else {
      langMenu.classList.remove("show-other");
      langLabel.textContent = lang;
      languageField.value = lang;
      langPicker.classList.remove("open");        // close after choosing
    }
  });
});
const langDone = document.getElementById("langDone");
// Typing a custom language
langOther.addEventListener("input", function () {
  const custom = langOther.value.trim();

  langLabel.textContent = custom || "Other";
  languageField.value = custom || "Other";

  langDone.disabled = custom === "";   
});

// Pressing Enter in the custom box closes the menu (and does not send the chat)
langOther.addEventListener("keydown", function (event) {
 if (event.key === "Enter") {
    event.preventDefault();
    if (langOther.value.trim() !== "") {
      langPicker.classList.remove("open");
    }
  }
});
// Tick button: close the language menu


langDone.addEventListener("click", function () {
  langPicker.classList.remove("open");
});



// ---------- Ctrl + drag a message anywhere ----------

// While Ctrl is held, messages become draggable (and show a grab hint)
function setDragMode(on) {
  document.body.classList.toggle("drag-mode", on);
  if (!on) document.body.classList.remove("hover-started");    
  document.querySelectorAll(".message").forEach(function (bubble) {
    bubble.draggable = on;
  });
}

document.addEventListener("keydown", function (event) {
  if (event.key === "Alt") {
    event.preventDefault();          // stops the browser menu from grabbing focus on Windows
    setDragMode(true);
  }
});

document.addEventListener("keyup", function (event) {
  if (event.key === "Alt") {
    event.preventDefault();
    setDragMode(false);
  }
});

// If the window loses focus while Ctrl is down, turn the mode off
window.addEventListener("blur", function () {
  setDragMode(false);
});

// When a drag starts, put the message text into the drag
messages.addEventListener("dragstart", function (event) {
  const bubble = event.target.closest(".message");
  if (!bubble) return;

  event.dataTransfer.setData("text/plain", bubble.textContent);
  event.dataTransfer.effectAllowed = "copy";

  bubble.classList.add("dragging");
});

messages.addEventListener("dragend", function (event) {
  const bubble = event.target.closest(".message");
  if (bubble) bubble.classList.remove("dragging");
});
// Once the mouse hovers a message while Ctrl is held, start the fading
messages.addEventListener("mouseover", function (event) {
  if (!document.body.classList.contains("drag-mode")) return;
  if (event.target.closest(".message")) {
    document.body.classList.add("hover-started");
  }
});





// ---------- Top-left tips button ----------
const tipsCorner = document.getElementById("tipsCorner");
const tipsBtn = document.getElementById("tipsBtn");

// Click the button to open / close the tips card
tipsBtn.addEventListener("click", function (event) {
  event.stopPropagation();
  tipsCorner.classList.toggle("open");
});

// Clicking anywhere else closes it
document.addEventListener("click", function (event) {
  if (!tipsCorner.contains(event.target)) {
    tipsCorner.classList.remove("open");
  }
});

// Escape key closes it too
document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") {
    tipsCorner.classList.remove("open");
  }
});