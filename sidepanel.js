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

let thinkingState = null;

function createThinkingBlock() {
  const details = document.createElement('details');
  details.className = 'msg assistant thinking-block';
  
  const summary = document.createElement('summary');
  const timerSpan = document.createElement('span');
  timerSpan.className = 'timer-text';
  timerSpan.textContent = 'Thinking for 0 seconds';
  
  const ellipsisSpan = document.createElement('span');
  ellipsisSpan.className = 'ellipsis';
  
  summary.appendChild(timerSpan);
  summary.appendChild(ellipsisSpan);
  details.appendChild(summary);

  const traceDiv = document.createElement('div');
  traceDiv.className = 'trace';
  details.appendChild(traceDiv);

  els.messages.appendChild(details);
  els.messages.scrollTop = els.messages.scrollHeight;

  thinkingState = {
    el: details,
    traceEl: traceDiv,
    seconds: 0,
    timer: setInterval(() => {
      if (thinkingState) {
        thinkingState.seconds++;
        timerSpan.textContent = `Thinking for ${thinkingState.seconds} seconds`;
      }
    }, 1000)
  };
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
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
  let text = String(raw);
  let out = text
    .replace(/^####\s+(.*)$/gm, '<h4>$1</h4>')
    .replace(/^###\s+(.*)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.*)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  
  out = out.replace(/^(?:\s*[-*]\s+)(.*)$/gm, '<li>$1</li>');
  out = out.replace(/<\/li>\s*<li>/g, '</li><li>');
  out = out.replace(/(<li>.*?<\/li>)/gs, (match) => `<ul>${match}</ul>`);
  out = out.replace(/<ul>\s*<ul>/g, '<ul>').replace(/<\/ul>\s*<\/ul>/g, '</ul>');

  out = out.replace(/\n/g, '<br/>');

  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = out;
  const allowedTags = ['h1', 'h2', 'h3', 'h4', 'strong', 'code', 'pre', 'ul', 'li', 'br'];
  const walker = document.createTreeWalker(tempDiv, NodeFilter.SHOW_ELEMENT);
  let node;
  while (node = walker.nextNode()) {
    if (!allowedTags.includes(node.tagName.toLowerCase())) {
      node.parentNode.removeChild(node);
    } else {
      while (node.attributes.length > 0) {
        node.removeAttribute(node.attributes[0].name);
      }
    }
  }
  return tempDiv.innerHTML;
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
  chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
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

  createThinkingBlock();
  chrome.runtime.sendMessage({ type: 'SIDE_INPUT', tabId, content });
});

chrome.runtime.onMessage.addListener((msg) => {
  function render() {
    if (msg.type === 'SIDE_FINAL_RESPONSE') {
      if (thinkingState) {
        clearInterval(thinkingState.timer);
        const summary = thinkingState.el.querySelector('summary');
        summary.innerHTML = `Thought for ${msg.totalDuration} seconds`;
        
        const traceEl = thinkingState.traceEl;
        traceEl.innerHTML = ''; 

        for (const step of msg.steps) {
          const stepDiv = document.createElement('div');
          stepDiv.className = 'step';

          let contentHtml = `<strong>${sanitize(step.title)}</strong>`;
          if (step.humanReadable) {
            contentHtml += `<div>${renderMarkdown(step.humanReadable)}</div>`;
          }
          
          if (step.isImage) {
            const img = document.createElement('img');
            img.src = step.jsonData.dataUrl;
            img.className = 'thumb';
            stepDiv.innerHTML = contentHtml;
            stepDiv.appendChild(img);
          } else {
            stepDiv.innerHTML = contentHtml;
          }
          
          if (step.jsonData) {
            const jsonDetails = document.createElement('details');
            const jsonSummary = document.createElement('summary');
            jsonSummary.textContent = 'View Raw Result';
            jsonDetails.appendChild(jsonSummary);
            const pre = document.createElement('pre');
            pre.textContent = JSON.stringify(step.jsonData, null, 2);
            jsonDetails.appendChild(pre);
            stepDiv.appendChild(jsonDetails);
          }
          traceEl.appendChild(stepDiv);
        }
        thinkingState = null;
      }
      addMessage('assistant', msg.finalAnswer);
    }

    if (msg.type === 'SIDE_STATUS') {
      if (msg.status === 'working' && thinkingState) {
        const p = document.createElement('p');
        p.textContent = msg.text;
        thinkingState.traceEl.appendChild(p);
        els.messages.scrollTop = els.messages.scrollHeight;
      } else if (msg.status === 'idle') {
        const button = els.form.querySelector('button[type="submit"]');
        button.classList.remove('loading');
        button.disabled = false;
        els.input.disabled = false;
      }
    }
  }
  if (msg.tabId) {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => {
      if (t && t.id === msg.tabId) render();
    });
  } else {
    render();
  }
});

restoreSettings();

