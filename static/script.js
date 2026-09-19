const page = document.querySelector(".page");        
  const form = document.getElementById("form");
  const box = document.getElementById("message");
  const messages = document.getElementById("messages");
  const title = document.getElementById("title");

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

        leaveEmptyState();                                 // smooth slide to the final layout

    // 1. Show the user's message
    const userDiv = document.createElement("div");
    userDiv.className = "message";
    userDiv.style.whiteSpace = "pre-wrap";
    userDiv.textContent = text;
    messages.appendChild(userDiv);

    // 2. Create an empty reply box that we will fill up
    const replyDiv = document.createElement("div");
    replyDiv.className = "message reply";
    replyDiv.style.whiteSpace = "pre-wrap";
    messages.appendChild(replyDiv);
    messages.scrollTop = messages.scrollHeight;

    // 3. Send the form to Flask
    const data = new FormData(form);
    box.value = "";

    // 4. Read the reply piece by piece
    try {
      const response = await fetch("/send", { method: "POST", body: data });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const result = await reader.read();
        if (result.done) break;
        replyDiv.textContent += decoder.decode(result.value, { stream: true });
        messages.scrollTop = messages.scrollHeight;
      }
    } catch (error) {
      replyDiv.textContent = "Error: " + error.message;
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