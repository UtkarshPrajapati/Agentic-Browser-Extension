// UI state and messaging bridge to service worker

const els = {
  toggle: document.getElementById('toggle-collapse'),
  messages: document.getElementById('messages'),
  form: document.getElementById('chat-form'),
  input: document.getElementById('user-input'),
  key: document.getElementById('openrouter-key'),
  model: document.getElementById('model'),
  allowlist: document.getElementById('allowlist'),
  save: document.getElementById('save-settings'),
  clear: document.getElementById('clear-chat'),
};

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  // Render simple markdown (headings, bold, lists, code blocks)
  const html = renderMarkdown(text);
  div.innerHTML = `<span class="role">${role}</span>${html}`;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function addMessageHtml(role, html) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `<span class="role">${role}</span>${html}`;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function sanitize(text) {
  const div = document.createElement('div');
  div.innerText = text;
  return div.innerHTML;
}

function renderMarkdown(raw) {
  if (!raw) return '';

  // Convert to string and handle line breaks
  let text = String(raw);

  // Process markdown before sanitization
  let out = text
    // Headings (h3, h2, h1)
    .replace(/^###\s+(.*)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.*)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.*)$/gm, '<h1>$1</h1>')
    // Bold text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bullet lists - convert markdown list items to HTML
    .replace(/^\-\s+(.*)$/gm, '<li>$1</li>');

  // Handle lists by wrapping consecutive <li> elements in <ul>
  out = out.replace(/(<li>.*?<\/li>\s*)+/g, (match) => `<ul>${match}</ul>`);
  // Code blocks
  out = out.replace(/```([\s\S]*?)```/g, (match, code) => `<pre><code>${sanitize(code)}</code></pre>`);

  // Handle line breaks
  out = out.replace(/\n/g, '<br/>');

  // Sanitize the final HTML (but allow our generated tags)
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = out;
  // Remove any potentially dangerous elements/attributes
  const allowedTags = ['h1', 'h2', 'h3', 'strong', 'code', 'pre', 'ul', 'li', 'br'];
  const walker = document.createTreeWalker(tempDiv, NodeFilter.SHOW_ELEMENT);
  let node;
  while (node = walker.nextNode()) {
    if (!allowedTags.includes(node.tagName.toLowerCase())) {
      node.parentNode.removeChild(node);
    } else {
      // Remove any attributes
      while (node.attributes.length > 0) {
        node.removeAttribute(node.attributes[0].name);
      }
    }
  }

  return tempDiv.innerHTML;
}

function addCollapsedJson(role, title, obj) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const safeTitle = sanitize(title);
  const pretty = sanitize(JSON.stringify(obj, null, 2));
  div.innerHTML = `<span class="role">${role}</span><details><summary>${safeTitle}</summary><pre>${pretty}</pre></details>`;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function restoreSettings() {
  const { openrouterKey, model, allowlist } = await chrome.storage.local.get(['openrouterKey', 'model', 'allowlist']);
  if (openrouterKey) els.key.value = openrouterKey;
  if (model) els.model.value = model;
  if (allowlist) els.allowlist.value = allowlist.join(', ');
}

async function saveSettings() {
  const allow = els.allowlist.value.split(',').map(s => s.trim()).filter(Boolean);
  await chrome.storage.local.set({ openrouterKey: els.key.value, model: els.model.value, allowlist: allow });
  addMessage('assistant', 'Settings saved.');
}

els.save.addEventListener('click', saveSettings);
els.clear?.addEventListener('click', async () => {
  els.messages.innerHTML = '';
  const tabId = await getActiveTabId();
  if (tabId) {
    chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY', tabId });
  }
});

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = els.input.value.trim();
  if (!content) return;
  const tabId = await getActiveTabId();
  addMessage('user', content);
  els.input.value = '';
  
  const button = els.form.querySelector('button[type="submit"]');
  button.classList.add('loading');
  button.disabled = true;
  els.input.disabled = true;

  chrome.runtime.sendMessage({ type: 'SIDE_INPUT', tabId, content });
});

chrome.runtime.onMessage.addListener((msg) => {
  function render() {
    if (msg.type === 'SIDE_ASSISTANT') addMessage('assistant', msg.text);
    if (msg.type === 'SIDE_STATUS') {
      if (msg.status === 'working') {
        // This is a progress update, keep loader active but show text
        addMessageHtml('assistant', `<span class="pill">${sanitize(msg.status)}</span> ${sanitize(msg.text)}`);
      } else if (msg.status === 'idle') {
        // This is the final message, hide loader
        const button = els.form.querySelector('button[type="submit"]');
        button.classList.remove('loading');
        button.disabled = false;
        els.input.disabled = false;
      }
    }
    if (msg.type === 'SIDE_JSON') addCollapsedJson('assistant', msg.title || 'Result', msg.payload);
    if (msg.type === 'SIDE_IMAGE') {
      const div = document.createElement('div');
      div.className = 'msg assistant';
      const href = msg.dataUrl;
      div.innerHTML = `<span class="role">assistant</span><a href="${href}" download="screenshot.jpg">Download</a><br/><img class="thumb" src="${href}" alt="screenshot"/>`;
      els.messages.appendChild(div);
      els.messages.scrollTop = els.messages.scrollHeight;
    }
  }
  if (msg.tabId) {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => {
      if (t && t.id === msg.tabId) render();
    });
  } else {
    render();
  }
  // Let's remove the old logic that stops the loader too early
  // if (['SIDE_ASSISTANT','SIDE_STATUS','SIDE_JSON','SIDE_IMAGE'].includes(msg.type)) {
  //   const button = els.form.querySelector('button[type="submit"]');
  //   button.classList.remove('loading');
  //   button.disabled = false;
  //   els.input.disabled = false;
  // }
});

restoreSettings();

