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
  const safe = sanitize(String(raw));
  // very light markdown: headings, bold, lists, inline code, code blocks
  let out = safe
    .replace(/^### (.*)$/gm, '<strong>$1</strong>')
    .replace(/^## (.*)$/gm, '<strong>$1</strong>')
    .replace(/^# (.*)$/gm, '<strong>$1</strong>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^\-\s+(.*)$/gm, '<div>• $1</div>');
  // code fences
  out = out.replace(/```[\s\S]*?```/g, (m) => `<pre>${sanitize(m.replace(/```/g, ''))}</pre>`);
  // restore basic line breaks and allowed <br> tags
  out = out.replace(/&lt;br\/?&gt;/gi, '<br/>');
  out = out.replace(/\n/g, '<br/>');
  return out;
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
els.clear?.addEventListener('click', () => { els.messages.innerHTML = ''; });

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = els.input.value.trim();
  if (!content) return;
  const tabId = await getActiveTabId();
  addMessage('user', content);
  els.input.value = '';
  document.body.classList.add('loading');
  chrome.runtime.sendMessage({ type: 'SIDE_INPUT', tabId, content });
});

chrome.runtime.onMessage.addListener((msg) => {
  function render() {
    if (msg.type === 'SIDE_ASSISTANT') addMessage('assistant', msg.text);
    if (msg.type === 'SIDE_STATUS') addMessageHtml('assistant', `<span class="pill">${sanitize(msg.status)}</span> ${sanitize(msg.text)}`);
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
  // any assistant/status/json/image message ends the loading state
  if (['SIDE_ASSISTANT','SIDE_STATUS','SIDE_JSON','SIDE_IMAGE'].includes(msg.type)) {
    document.body.classList.remove('loading');
  }
});

restoreSettings();

