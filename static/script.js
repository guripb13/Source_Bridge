const page = document.querySelector(".page");        
  const form = document.getElementById("form");
  const box = document.getElementById("message");
  const messages = document.getElementById("messages");

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

    page.classList.remove("empty");                    // starts the smooth slide down

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
    } else {
      langMenu.classList.remove("show-other");
      langLabel.textContent = lang;
      languageField.value = lang;
      langPicker.classList.remove("open");        // close after choosing
    }
  });
});

// Typing a custom language
langOther.addEventListener("input", function () {
  const custom = langOther.value.trim() || "Other";
  langLabel.textContent = custom;
  languageField.value = custom;
});

// Pressing Enter in the custom box closes the menu (and does not send the chat)
langOther.addEventListener("keydown", function (event) {
  if (event.key === "Enter") {
    event.preventDefault();
    langPicker.classList.remove("open");
  }
});