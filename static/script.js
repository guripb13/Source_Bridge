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