document.addEventListener('DOMContentLoaded', () => {
  const composer     = document.getElementById('composer');
  const editor       = document.getElementById('editor');
  const sendBtn      = document.getElementById('sendBtn');
  const sendIcon     = document.getElementById('sendIcon');
  const attachBtn    = document.getElementById('attachBtn');
  const fileInput    = document.getElementById('fileInput');
  const attachWrap   = document.getElementById('attachments');
  const toast        = document.getElementById('toast');
  const conversation = document.getElementById('conversation');

  // ---- focus ring animation ----
  editor.addEventListener('focus', () => composer.classList.add('focused'));
  editor.addEventListener('blur',  () => composer.classList.remove('focused'));

  // ---- send button enable/disable based on content ----
  function hasContent(){
    return editor.textContent.trim().length > 0 || attachWrap.children.length > 0;
  }

  function refreshSendState(){
    if (!sendBtn.classList.contains('loading')){
      sendBtn.classList.toggle('active', hasContent());
    }
  }

  editor.addEventListener('input', refreshSendState);

  // ---- CORE FEATURE: paste as plain text ----
  // Whatever is copied (rich HTML from a webpage, a Word doc, formatted email, etc.)
  // gets converted into plain text before it lands in the input box.
  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const plainText = (e.clipboardData || window.clipboardData).getData('text/plain');
    insertPlainText(plainText);
  });

  function insertPlainText(text){
    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();

    const lines = text.split(/\r\n|\r|\n/);
    const frag = document.createDocumentFragment();
    lines.forEach((line, i) => {
      frag.appendChild(document.createTextNode(line));
      if (i < lines.length - 1) frag.appendChild(document.createElement('br'));
    });

    range.insertNode(frag);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);

    refreshSendState();
  }

  // ---- Enter to send, Shift+Enter for newline ----
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey){
      e.preventDefault();
      trySend();
    }
  });

  sendBtn.addEventListener('click', trySend);

  // ---- GET/POST integration with Flask ----
  async function trySend(){
    if (!hasContent() || sendBtn.classList.contains('loading')) return;

    const messageText = editor.textContent;

    addBubble(messageText, 'user');

    sendBtn.classList.remove('pulse');
    void sendBtn.offsetWidth; // restart animation
    sendBtn.classList.add('pulse');

    editor.textContent = '';
    attachWrap.innerHTML = '';
    editor.focus();

    setLoading(true);

    try {
      const response = await fetch('/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: messageText })
      });

      const data = await response.json();

      if (!response.ok){
        addBubble(data.error || 'Something went wrong.', 'ai', true);
      } else {
        addBubble(data.reply, 'ai');
      }
    } catch (err) {
      console.error(err);
      addBubble('Could not reach the server.', 'ai', true);
    } finally {
      setLoading(false);
    }
  }

  function setLoading(isLoading){
    sendBtn.classList.toggle('loading', isLoading);
    sendBtn.disabled = isLoading;
    if (isLoading){
      sendIcon.innerHTML = '<div class="spinner"></div>';
    } else {
      sendIcon.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="19" x2="12" y2="5"></line>
          <polyline points="5 12 12 5 19 12"></polyline>
        </svg>`;
      refreshSendState();
    }
  }

  function addBubble(text, who, isError){
    const bubble = document.createElement('div');
    bubble.className = `bubble ${who}` + (isError ? ' error' : '');
    bubble.textContent = text;
    conversation.appendChild(bubble);
    bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  function showToast(msg){
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 1600);
  }

  // ---- file attachment chips ----
  attachBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    [...fileInput.files].forEach(addChip);
    fileInput.value = '';
    refreshSendState();
  });

  function addChip(file){
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.innerHTML = `
      <div class="chip-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
      </div>
      <span class="chip-name">${escapeHtml(file.name)}</span>
      <button class="chip-remove" title="Remove">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    `;
    chip.querySelector('.chip-remove').addEventListener('click', () => {
      chip.remove();
      refreshSendState();
    });
    attachWrap.appendChild(chip);
  }

  function escapeHtml(str){
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // allow dropping files onto the composer too
  ['dragover'].forEach(evt => composer.addEventListener(evt, (e) => e.preventDefault()));
  composer.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length){
      [...e.dataTransfer.files].forEach(addChip);
      refreshSendState();
    }
  });

  refreshSendState();
});
