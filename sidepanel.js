// UI state and messaging bridge to service worker

const els = {
  messages: document.getElementById('messages'),
  form: document.getElementById('chat-form'),
  input: document.getElementById('user-input'),
  chips: document.getElementById('suggestion-chips'),
  key: document.getElementById('openrouter-key'),
  model: document.getElementById('model'),
  modelDropdown: document.getElementById('model-dropdown'),
  modelError: document.getElementById('model-error'),
  allowlist: document.getElementById('allowlist'),
  save: document.getElementById('save-settings'),
  clear: document.getElementById('clear-chat'),
  chatTab: document.getElementById('chat-tab'),
  settingsTab: document.getElementById('settings-tab'),
  aboutTab: document.getElementById('about-tab'),
  chatPanel: document.getElementById('chat-panel'),
  settingsPanel: document.getElementById('settings-panel'),
  aboutPanel: document.getElementById('about-panel'),
  glider: document.querySelector('.glider'),
  settingsStatus: document.getElementById('settings-status'),
};

// Short, natural-language labels for tools (3-4 words max)
const TOOL_SHORT_LABELS = {
  'open_tab_and_read': 'Opening Link & Reading',
  'open_tab': 'Opening Link',
  'switch_tab': 'Switching Tab',
  'close_tab': 'Closing Tab',
  'get_tabs': 'Listing Tabs',
  'read_page': 'Reading Page',
  'click_text': 'Clicking Text',
  'click': 'Clicking Element',
  'type': 'Typing Text',
  'scroll': 'Scrolling',
  'extract_table': 'Extracting Table',
  'screenshot': 'Taking Screenshot',
  'mcp.fetch.get': 'Fetching URL',
  'mcp.fs.read': 'Reading File',
  'mcp.fs.write': 'Writing File',
  'mcp.rag.query': 'Searching Notes'
};

let thinkingState = null;
let streamingState = null;

// Tab switching logic
function openTab(tabName) {
  const tabs = ['chat', 'settings', 'about'];
  tabs.forEach(tab => {
    const isSelected = tab === tabName;
    els[`${tab}Tab`].classList.toggle('active', isSelected);
    els[`${tab}Panel`].classList.toggle('active', isSelected);
  });
  moveGlider(els[`${tabName}Tab`]);
}

els.chatTab.addEventListener('click', () => openTab('chat'));
els.settingsTab.addEventListener('click', () => openTab('settings'));
els.aboutTab.addEventListener('click', () => openTab('about'));

// Move glider
function moveGlider(target) {
  els.glider.style.width = `${target.offsetWidth}px`;
  els.glider.style.transform = `translateX(${target.offsetLeft}px)`;
}

// Set initial glider position
document.addEventListener('DOMContentLoaded', () => {
  const activeTab = document.querySelector('.tab.active');
  if (activeTab) {
    moveGlider(activeTab);
  }
  initSuggestionChips();
});

// Persist and hydrate UI across tabs/windows
let persistTimer = null;
let streamBuffer = '';
let lastPersistHtml = '';
function persistMessagesDebounced(force = false) {
  if (persistTimer) clearTimeout(persistTimer);
  const run = () => {
    try {
      const html = els.messages.innerHTML;
      // Avoid redundant writes if HTML hasn't changed
      if (!force && html === lastPersistHtml) return;
      lastPersistHtml = html;
      chrome.storage.session.set({ ui_messages_html: html });
    } catch {}
  };
  if (force) run(); else persistTimer = setTimeout(run, 600);
}

async function hydrateMessages() {
  try {
    const data = await chrome.storage.session.get(['ui_messages_html', 'ui_stream_buffer']);
    const html = data && data.ui_messages_html;
    if (html && typeof html === 'string') {
      els.messages.innerHTML = html;
      els.messages.scrollTop = els.messages.scrollHeight;
    }
    streamBuffer = data && typeof data.ui_stream_buffer === 'string' ? data.ui_stream_buffer : '';
    // Reattach to an in-progress streaming bubble if present
    const active = els.messages.querySelector('.msg.assistant[data-streaming="true"] .stream-content');
    if (active) {
      streamingState = { el: active.parentElement, contentEl: active, text: streamBuffer || active.innerText || '' };
    }
    // Reattach thinking timeline if a run is in progress
    const tb = els.messages.querySelector('.thinking-block');
    if (tb) {
      const timerSpan = tb.querySelector('.timer-text');
      const traceDiv = tb.querySelector('.trace');
      if (timerSpan && traceDiv) {
        // Only reattach a timer if still in "Thinking" state
        thinkingState = {
          el: tb,
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
    }
  } catch {}
  // Update chip visibility after hydration
  updateChipsVisibility();
}

function ensureStreamBubble() {
  if (streamingState?.el?.isConnected) return streamingState;
  // Do not create a bubble yet; it will be created lazily on first delta
  return streamingState;
}

let renderThrottleTimer = null;
function appendStreamText(text) {
  // Skip empty deltas to avoid creating empty bubbles
  if (!text || !String(text).trim()) return;
  // Lazily create bubble on first content
  if (!streamingState || !streamingState.el || !streamingState.el.isConnected) {
    const div = document.createElement('div');
    div.className = 'msg assistant';
    div.setAttribute('data-streaming', 'true');
    const content = document.createElement('div');
    content.className = 'stream-content';
    div.appendChild(content);
    els.messages.appendChild(div);
    els.messages.scrollTop = els.messages.scrollHeight;
    streamingState = { el: div, contentEl: content, text: '' };
  }
  streamingState.text += text;
  // Throttle expensive markdown + DOM updates
  if (renderThrottleTimer) return;
  renderThrottleTimer = setTimeout(() => {
    try {
      streamingState.contentEl.innerHTML = renderMarkdown(streamingState.text);
      els.messages.scrollTop = els.messages.scrollHeight;
      streamBuffer = streamingState.text;
      chrome.storage.session.set({ ui_stream_buffer: streamBuffer });
      persistMessagesDebounced(false);
    } catch {}
    renderThrottleTimer = null;
  }, 90);
}

function endStream(totalSeconds, steps) {
  if (!streamingState) return;
  const finalMsgEl = streamingState.el;
  // Force a final render of any pending buffered text before closing
  try {
    if (renderThrottleTimer) {
      clearTimeout(renderThrottleTimer);
      renderThrottleTimer = null;
    }
    if (streamingState.contentEl && typeof streamingState.text === 'string') {
      streamingState.contentEl.innerHTML = renderMarkdown(streamingState.text);
    }
  } catch {}
  const hadText = !!(streamingState.text && String(streamingState.text).trim().length);
  if (hadText) {
    try { finalMsgEl.removeAttribute('data-streaming'); } catch {}
  } else {
    try { finalMsgEl.remove(); } catch {}
  }
  // If a screenshot was taken, append preview + download link under the final streamed answer
  try {
    const shot = Array.isArray(steps) ? steps.find(s => s && s.isImage && s.jsonData?.dataUrl) : null;
    if (shot && shot.jsonData?.dataUrl) {
      const footer = document.createElement('div');
      footer.className = 'stream-footer';
      const img = document.createElement('img');
      img.src = shot.jsonData.dataUrl;
      img.className = 'thumb';
      img.style.maxWidth = '100%';
      img.style.display = 'block';
      img.style.marginTop = '6px';
      const link = document.createElement('a');
      link.href = shot.jsonData.dataUrl;
      link.download = 'screenshot.png';
      link.textContent = 'Download screenshot';
      link.style.display = 'inline-block';
      link.style.marginTop = '6px';
      footer.appendChild(img);
      footer.appendChild(link);
      finalMsgEl.appendChild(footer);
    }
  } catch {}
  streamingState = null;
  streamBuffer = '';
  try { chrome.storage.session.remove(['ui_stream_buffer']); } catch {}
  // After streaming finishes, also render the steps (collapsed)
  if (steps && steps.length) {
    const details = document.createElement('details');
    details.className = 'steps-container';
    const summary = document.createElement('summary');
    summary.textContent = `Show ${steps.length} Actions Taken`;
    details.appendChild(summary);
    for (const step of steps) {
      const stepDetailsEl = document.createElement('details');
      stepDetailsEl.className = 'step';
      const sum = document.createElement('summary');
      sum.textContent = step.title || 'Action';
      stepDetailsEl.appendChild(sum);
      const body = document.createElement('div');
      let contentHtml = '';
      if (step.humanReadable) contentHtml += `<div>${renderMarkdown(step.humanReadable)}</div>`;
      body.innerHTML = contentHtml;
      // Input args viewer if present
      if (step.input && typeof step.input === 'object') {
        const inputDetails = document.createElement('details');
        const inputSummary = document.createElement('summary');
        inputSummary.textContent = 'View Input';
        inputDetails.appendChild(inputSummary);
        const preIn = document.createElement('pre');
        try { preIn.textContent = JSON.stringify(step.input, null, 2); } catch { preIn.textContent = String(step.input); }
        inputDetails.appendChild(preIn);
        body.appendChild(inputDetails);
      }
      if (step.isImage && step.jsonData?.dataUrl) {
        const img = document.createElement('img');
        img.src = step.jsonData.dataUrl;
        img.className = 'thumb';
        body.appendChild(img);
        const a = document.createElement('a');
        a.href = step.jsonData.dataUrl;
        a.download = 'screenshot.png';
        a.textContent = 'Download image';
        a.style.display = 'inline-block';
        a.style.marginTop = '6px';
        body.appendChild(a);
      }
      if (step.jsonData) {
        body.appendChild(createJsonViewer(step.jsonData));
      }
      stepDetailsEl.appendChild(body);
      details.appendChild(stepDetailsEl);
    }
    addMessageHtml('assistant', details.outerHTML);
  }
  persistMessagesDebounced(true);
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const html = renderMarkdown(text);
  div.innerHTML = `<span class="role">${role}</span>${html}`;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  persistMessagesDebounced(true);
  updateChipsVisibility();
  return div;
}

function addMessageHtml(role, html) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `<span class="role">${role}</span>${html}`;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  persistMessagesDebounced(true);
  updateChipsVisibility();
}

function basicSanitize(text) {
  const div = document.createElement('div');
  div.innerText = String(text);
  return div.innerHTML;
}

function sanitize(html) {
  const purify = (window && window.DOMPurify) ? window.DOMPurify : null;
  if (purify && typeof purify.sanitize === 'function') {
    return purify.sanitize(String(html), { USE_PROFILES: { html: true } });
  }
  // Fallback: allowlist sanitizer to preserve basic formatting safely
  try {
    const ALLOWED_TAGS = new Set(['b','strong','i','em','u','code','pre','p','br','ul','ol','li','h1','h2','h3','h4','blockquote','a','table','thead','tbody','tr','th','td']);
    const ALLOWED_ATTRS = {
      a: new Set(['href','title','target','rel'])
    };
    const isSafeUrl = (url) => {
      try {
        const u = String(url || '').trim();
        if (u.startsWith('#')) return true;
        const parsed = new URL(u, 'https://example.com');
        return ['http:','https:','mailto:','tel:'].includes(parsed.protocol);
      } catch { return false; }
    };
    const tmp = document.createElement('div');
    tmp.innerHTML = String(html);
    const all = tmp.querySelectorAll('*');
    all.forEach((el) => {
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (!ALLOWED_TAGS.has(tag)) {
        const parent = el.parentNode;
        if (parent) {
          while (el.firstChild) parent.insertBefore(el.firstChild, el);
          parent.removeChild(el);
        }
        return;
      }
      const allowed = ALLOWED_ATTRS[tag] || new Set();
      Array.from(el.attributes || []).forEach((attr) => {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || name === 'style' || name === 'srcdoc') {
          el.removeAttribute(attr.name);
          return;
        }
        if (!allowed.has(name)) {
          el.removeAttribute(attr.name);
          return;
        }
        if (tag === 'a' && name === 'href') {
          if (!isSafeUrl(attr.value)) {
            el.setAttribute('href', '#');
          }
          if (el.getAttribute('target') === '_blank') {
            const rel = (el.getAttribute('rel') || '').split(/\s+/).filter(Boolean);
            if (!rel.includes('noopener')) rel.push('noopener');
            if (!rel.includes('noreferrer')) rel.push('noreferrer');
            el.setAttribute('rel', rel.join(' '));
          } else {
            el.removeAttribute('target');
          }
        }
      });
    });
    return tmp.innerHTML;
  } catch {
    return basicSanitize(String(html));
  }
}

function renderMarkdown(raw) {
  const md = (window && window.marked && typeof window.marked.parse === 'function')
    ? window.marked.parse(String(raw || ''))
    : basicMarkdown(String(raw || ''));
  return enhanceLinks(sanitize(md));
}

// Convert simple GitHub-style pipe tables (| a | b |) into HTML tables
function convertPipeTablesToHtml(input) {
  try {
    const lines = String(input || '').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; ) {
      const headerLine = lines[i];
      const isHeader = /^\s*\|.+\|\s*$/.test(headerLine || '');
      const sepLine = lines[i + 1] || '';
      const isSeparator = /^\s*\|\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|\s*$/.test(sepLine);
      if (isHeader && isSeparator) {
        const headerCells = headerLine.trim().slice(1, -1).split('|').map(s => s.trim());
        const bodyRows = [];
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          bodyRows.push(lines[i]);
          i++;
        }
        const thead = headerCells.map(c => `<th>${c}</th>`).join('');
        const tbody = bodyRows.map(r => {
          const cells = r.trim().slice(1, -1).split('|').map(s => s.trim());
          const formatCell = (c) => {
            const parts = String(c).split(/<br\s*\/?>|\n/).map(s => s.trim()).filter(s => s);
            if (parts.length && parts.every(p => /^[-*]\s+/.test(p))) {
              const lis = parts.map(p => `<li>${p.replace(/^[-*]\s+/, '')}</li>`).join('');
              return `<ul>${lis}</ul>`;
            }
            return c;
          };
          const tds = cells.map(c => `<td>${formatCell(c)}</td>`).join('');
          return `<tr>${tds}</tr>`;
        }).join('');
        out.push(`<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`);
        continue;
      }
      out.push(headerLine);
      i++;
    }
    return out.join('\n');
  } catch {
    return String(input || '');
  }
}

function basicMarkdown(text) {
  let out = String(text || '');
  out = out.replace(/\r\n/g, '\n');
  out = out
    .replace(/^####\s+(.*)$/gm, '<h4>$1</h4>')
    .replace(/^###\s+(.*)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.*)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');
  out = out
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  out = out.replace(/^(?:\s*[-*]\s+)(.*)$/gm, '<li>$1</li>');
  out = out.replace(/<\/li>\s*<li>/g, '</li><li>');
  out = out.replace(/(<li>.*?<\/li>)/gs, (m) => `<ul>${m}</ul>`);
  out = out.replace(/<ul>\s*<ul>/g, '<ul>').replace(/<\/ul>\s*<\/ul>/g, '</ul>');
  out = convertPipeTablesToHtml(out);
  out = out.replace(/\n/g, '<br/>' );
  out = out.replace(/(?:<br\/>\s*){2,}/g, '<br/>' );
  out = out.replace(/(<h[1-4][^>]*>.*?<\/h[1-4]>)(?:<br\/>\s*)+/g, '$1');
  out = out.replace(/<ul>\s*(?:<br\/>\s*)+/g, '<ul>');
  out = out.replace(/(?:<br\/>\s*)+<\/ul>/g, '</ul>');
  return out;
}

function enhanceLinks(html) {
  try {
    const div = document.createElement('div');
    div.innerHTML = html;
    const anchors = div.querySelectorAll('a[href]');
    anchors.forEach(a => {
      const href = a.getAttribute('href') || '';
      const text = (a.textContent || '').trim();
      let icon = '';
      const host = (() => { try { return new URL(href).hostname; } catch { return ''; } })();
      const isMail = href.startsWith('mailto:') || /@/.test(text);
      const isGitHub = /github\.com/i.test(href) || /github\.com/i.test(text);
      const isLinkedIn = /linkedin\.com/i.test(href) || /linkedin\.com/i.test(text);
      const isLinktree = /linktr\.ee/i.test(href) || /linktr\.ee/i.test(text);
      if (isMail) {
        icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="m22 6-10 7L2 6"/></svg>';
      } else if (isGitHub) {
        icon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5a12 12 0 0 0-3.79 23.4c.6.1.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.09 1.83 1.23 1.83 1.23 1.07 1.82 2.81 1.29 3.5.99.11-.78.42-1.29.76-1.59-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.23-3.22-.12-.3-.54-1.52.12-3.17 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.87.12 3.17.76.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.63-5.48 5.93.43.37.81 1.1.81 2.22v3.29c0 .32.21.69.82.58A12 12 0 0 0 12 .5z"/></svg>';
      } else if (isLinkedIn) {
        icon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.98 3.5C4.98 4.88 3.86 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1s2.48 1.12 2.48 2.5zM.5 8h4V24h-4zM8.5 8h3.8v2.2h.05c.53-1 1.83-2.2 3.77-2.2 4.03 0 4.77 2.65 4.77 6.1V24h-4v-7.1c0-1.7 0-3.9-2.37-3.9-2.38 0-2.75 1.86-2.75 3.78V24h-4z"/></svg>';
      } else if (isLinktree) {
        icon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.5 6H20l-4 4 2 10-6-4-6 4 2-10-4-4h4.5L12 2z"/></svg>';
      } else if (host) {
        icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
      }
      const chip = document.createElement('span');
      chip.className = 'link-chip';
      chip.innerHTML = `${icon}<span>${a.outerHTML}</span>`;
      a.replaceWith(chip);
    });
    return div.innerHTML;
  } catch {
    return html;
  }
}

// Build a JSON viewer with heavy HTML/text fields truncated and an incremental preview
function createJsonViewer(jsonData) {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'View Raw Result';
  details.appendChild(summary);

  // Stringify with placeholder for any key exactly named 'html' or 'text'
  const placeholderFor = (name, len) => `[${name} omitted: ${len} chars]`;
  let hasHeavy = false;
  const safeString = (() => {
    try {
      return JSON.stringify(jsonData, (key, value) => {
        if (key && key.toLowerCase && typeof value === 'string') {
          const k = key.toLowerCase();
          if (k === 'html' || k === 'text') {
            hasHeavy = true;
            return placeholderFor(k, value.length);
          }
        }
        return value;
      }, 2);
    } catch {
      try { return JSON.stringify(jsonData); } catch { return String(jsonData); }
    }
  })();

  const pre = document.createElement('pre');
  pre.textContent = safeString;
  details.appendChild(pre);

  // If we found an HTML/text field, provide an incremental preview viewer
  if (hasHeavy) {
    const findFirstHeavy = (obj) => {
      try {
        const stack = [{ value: obj, path: [] }];
        while (stack.length) {
          const { value, path } = stack.shift();
          if (value && typeof value === 'object') {
            for (const k of Object.keys(value)) {
              const v = value[k];
              const p = path.concat(k);
              if (k && k.toLowerCase && typeof v === 'string') {
                const kl = k.toLowerCase();
                if (kl === 'html' || kl === 'text') {
                  return { key: kl, value: v, path: p };
                }
              }
              if (v && typeof v === 'object') stack.push({ value: v, path: p });
            }
          }
        }
      } catch {}
      return null;
    };
    const hit = findFirstHeavy(jsonData);
    if (hit && typeof hit.value === 'string') {
      const container = document.createElement('div');
      container.style.marginTop = '8px';
      const hint = document.createElement('div');
      hint.style.fontSize = '12px';
      hint.style.color = 'var(--fg-muted)';
      hint.textContent = `${hit.key.toUpperCase()} preview (${hit.path.join('.')}):`;
      container.appendChild(hint);

      const preview = document.createElement('pre');
      preview.className = 'html-preview';
      preview.style.maxHeight = '220px';
      preview.style.overflow = 'auto';
      container.appendChild(preview);

      const controls = document.createElement('div');
      controls.style.display = 'flex';
      controls.style.gap = '8px';
      controls.style.marginTop = '6px';
      const moreBtn = document.createElement('button');
      moreBtn.textContent = 'Read more (+500)';
      moreBtn.className = 'confirm-btn';
      const allBtn = document.createElement('button');
      allBtn.textContent = 'Show all';
      allBtn.className = 'confirm-btn';
      controls.appendChild(moreBtn);
      controls.appendChild(allBtn);
      container.appendChild(controls);

      const FULL = hit.value;
      let shown = 1000;
      const STEP = 500;
      const render = () => {
        const slice = FULL.slice(0, shown);
        preview.textContent = slice;
        if (shown >= FULL.length) {
          moreBtn.disabled = true;
          allBtn.disabled = true;
        }
      };
      moreBtn.addEventListener('click', () => { shown = Math.min(FULL.length, shown + STEP); render(); });
      allBtn.addEventListener('click', () => { shown = FULL.length; render(); });
      render();
      details.appendChild(container);
    }
  }

  return details;
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
  try { await ensureModelsLoaded(); } catch {}
}

async function saveSettings() {
  const allow = els.allowlist.value.split(',').map(s => s.trim()).filter(Boolean);
  const model = String(els.model.value || '').trim();
  // Validate model not empty
  if (!model) {
    if (els.model) els.model.classList.add('input-error');
    if (els.modelError) { els.modelError.textContent = 'Please choose a model.'; els.modelError.style.display = 'block'; }
    if (els.settingsStatus) els.settingsStatus.textContent = '';
    return;
  }
  // Clear errors
  if (els.model) els.model.classList.remove('input-error');
  if (els.modelError) els.modelError.style.display = 'none';

  await chrome.storage.local.set({ openrouterKey: els.key.value, model, allowlist: allow });
  // Show confirmation in Settings tab instead of chat
  if (els.settingsStatus) {
    els.settingsStatus.textContent = 'Settings saved.';
    setTimeout(() => { if (els.settingsStatus) els.settingsStatus.textContent = ''; }, 2000);
  }
}

els.save.addEventListener('click', saveSettings);
els.clear?.addEventListener('click', async () => {
  els.messages.innerHTML = '';
  chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
  try { await chrome.storage.session.remove(['ui_messages_html', 'ui_stream_buffer']); } catch {}
  updateChipsVisibility();
});

async function sendPrompt(text) {
  const content = String(text || '').trim();
  if (!content) return;
  const tabId = await getActiveTabId();
  addMessage('user', content);
  updateChipsVisibility();

  const button = els.form.querySelector('button[type="submit"]');
  button.classList.add('loading');
  button.disabled = true;
  els.input.disabled = true;

  // Allow cancelling from the stop icon inside the loader
  const stop = button.querySelector('.cancel-stop');
  const onCancel = () => { try { chrome.runtime.sendMessage({ type: 'CANCEL_RUN' }); } catch {} };
  stop?.addEventListener('click', onCancel, { once: true });

  createThinkingBlock();
  chrome.runtime.sendMessage({ type: 'SIDE_INPUT', tabId, content });
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = els.input.value.trim();
  if (!content) return;
  els.input.value = '';
  updateChipsVisibility();
  await sendPrompt(content);
});

function createThinkingBlock() {
  const details = document.createElement('details');
  details.className = 'msg assistant thinking-block';
  details.open = true;
  
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
  persistMessagesDebounced(false);

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

chrome.runtime.onMessage.addListener((msg) => {
  function render() {
    if (msg.type === 'SIDE_STREAM_START') {
      // Defer bubble creation until we actually have text to show
    }
    if (msg.type === 'SIDE_STREAM_DELTA') {
      appendStreamText(msg.text || '');
    }
    if (msg.type === 'SIDE_STREAM_ABORT') {
      // Always remove any partial streaming bubble to avoid showing truncated text
      if (streamingState?.el) {
        try { streamingState.el.remove(); } catch {}
      }
      streamingState = null;
      streamBuffer = '';
      try { chrome.storage.session.remove(['ui_stream_buffer']); } catch {}
      persistMessagesDebounced(true);
    }
    if (msg.type === 'SIDE_STREAM_END') {
      endStream(msg.totalDuration, msg.steps);
    }

    if (msg.type === 'SIDE_FINAL_RESPONSE') {
      if (thinkingState) {
        clearInterval(thinkingState.timer);
        const summary = thinkingState.el.querySelector('summary');
        summary.innerHTML = `Thought for ${msg.totalDuration || thinkingState.seconds} seconds`;
        // Keep open until we receive 'idle' to finalize and collapse
      }
      const finalEl = addMessage('assistant', msg.finalAnswer);
      try {
        const stepsArr = Array.isArray(msg.steps) ? msg.steps : [];
        const shot = stepsArr.slice().reverse().find(s => s && s.isImage && s.jsonData?.dataUrl);
        if (shot && shot.jsonData?.dataUrl) {
          const footer = document.createElement('div');
          footer.className = 'stream-footer';
          const img = document.createElement('img');
          img.src = shot.jsonData.dataUrl;
          img.className = 'thumb';
          img.style.maxWidth = '100%';
          img.style.display = 'block';
          img.style.marginTop = '6px';
          const link = document.createElement('a');
          link.href = shot.jsonData.dataUrl;
          link.download = 'screenshot.png';
          link.textContent = 'Download screenshot';
          link.style.display = 'inline-block';
          link.style.marginTop = '6px';
          footer.appendChild(img);
          footer.appendChild(link);
          finalEl.appendChild(footer);
          persistMessagesDebounced(true);
        }
      } catch {}
    }

    if (msg.type === 'SIDE_ASSISTANT') {
      addMessage('assistant', msg.text || '');
    }

    if (msg.type === 'SIDE_CONFIRM') {
      // Render confirm UI as a message with buttons
      const div = document.createElement('div');
      div.className = 'msg assistant';
      const body = document.createElement('div');
      body.innerHTML = renderMarkdown(`**Confirm:** ${msg.promptText || 'Proceed?'}`);
      const actions = document.createElement('div');
      actions.className = 'confirm-actions';
      const okBtn = document.createElement('button');
      okBtn.className = 'confirm-btn';
      okBtn.textContent = 'Allow';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'confirm-btn deny';
      cancelBtn.textContent = 'Deny';
      const finalize = (ok) => {
        try { chrome.runtime.sendMessage({ type: 'CONFIRM_RESPONSE', ok, callId: msg.callId }); } catch {}
        try { okBtn.disabled = true; cancelBtn.disabled = true; } catch {}
      };
      okBtn.addEventListener('click', () => finalize(true));
      cancelBtn.addEventListener('click', () => finalize(false));
      actions.appendChild(okBtn);
      actions.appendChild(cancelBtn);
      div.appendChild(body);
      div.appendChild(actions);
      els.messages.appendChild(div);
      els.messages.scrollTop = els.messages.scrollHeight;
      persistMessagesDebounced(true);
    }

    if (msg.type === 'SIDE_STATUS') {
      if (msg.status === 'working' && thinkingState) {
        const stepDetail = msg.stepDetail;
        // If this is an "Executing: ..." message (no detail yet), create a new running step
        if (!stepDetail && typeof msg.text === 'string' && /^Executing:\s+/i.test(msg.text)) {
          const stepWrapper = document.createElement('div');
          stepWrapper.className = 'step';
          stepWrapper.innerHTML = `
            <div class="timeline">
              <div class="timeline-circle">
                <svg class="checkmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">
                  <path class="checkmark__check" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
                </svg>
              </div>
              <div class="timeline-line"></div>
            </div>
          `;
          const stepContent = document.createElement('div');
          stepContent.className = 'step-content';
          // Show the executing text as the visible summary
          const header = document.createElement('div');
          // Replace the verbose tool name with a short label when available
          try {
            const m = msg.text.match(/^Executing:\s+(.+)$/i);
            const toolName = m && m[1] ? m[1].trim() : '';
            const short = TOOL_SHORT_LABELS[toolName] || toolName;
            header.innerHTML = renderMarkdown(`**${short}**`);
          } catch {
            // Fallback: strip the Executing: prefix if present
            const cleaned = String(msg.text || '').replace(/^Executing:\s+/i, '');
            header.innerHTML = renderMarkdown(`**${cleaned}**`);
          }
          stepContent.appendChild(header);
          stepWrapper.appendChild(stepContent);
          thinkingState.traceEl.appendChild(stepWrapper);
          els.messages.scrollTop = els.messages.scrollHeight;
          persistMessagesDebounced(false);
          return;
        }

        // If we received detail for the just executed step, complete and enrich the last step
        if (stepDetail) {
          const lastStep = thinkingState.traceEl.querySelector('.step:last-child');
          if (lastStep) {
            // mark as completed to animate tick + line
            lastStep.classList.add('completed');
            // append details panel under the existing header
            const stepContent = lastStep.querySelector('.step-content') || lastStep.appendChild(document.createElement('div'));
            if (!stepContent.classList.contains('step-content')) stepContent.className = 'step-content';

            const detailsEl = document.createElement('details');
            const sum = document.createElement('summary');
            sum.textContent = stepDetail.title || 'Action';
            detailsEl.appendChild(sum);

            const body = document.createElement('div');
            let contentHtml = '';
            if (stepDetail.humanReadable) {
              contentHtml += `<div>${renderMarkdown(stepDetail.humanReadable)}</div>`;
            }
            // First set main HTML content
            body.innerHTML = contentHtml;
            // Then append input args viewer if present
            if (stepDetail.input && typeof stepDetail.input === 'object') {
              const inputDetails = document.createElement('details');
              const inputSummary = document.createElement('summary');
              inputSummary.textContent = 'View Input';
              inputDetails.appendChild(inputSummary);
              const preIn = document.createElement('pre');
              try { preIn.textContent = JSON.stringify(stepDetail.input, null, 2); } catch { preIn.textContent = String(stepDetail.input); }
              inputDetails.appendChild(preIn);
              body.appendChild(inputDetails);
            }

            if (stepDetail.isImage && stepDetail.jsonData?.dataUrl) {
              const img = document.createElement('img');
              img.src = stepDetail.jsonData.dataUrl;
              img.className = 'thumb';
              body.appendChild(img);
              const a = document.createElement('a');
              a.href = stepDetail.jsonData.dataUrl;
              a.download = 'screenshot.png';
              a.textContent = 'Download image';
              a.style.display = 'inline-block';
              a.style.marginTop = '6px';
              body.appendChild(a);
            }

            if (stepDetail.jsonData) {
              body.appendChild(createJsonViewer(stepDetail.jsonData));
            }

            detailsEl.appendChild(body);
            stepContent.appendChild(detailsEl);
            els.messages.scrollTop = els.messages.scrollHeight;
            persistMessagesDebounced(false);
            return;
          }
        }

        // Fallback: append plain text into a new timeline step (skip generic "Thinking..." noise)
        if (typeof msg.text === 'string' && msg.text.trim() && !/^thinking\b/i.test(msg.text)) {
          const stepWrapper = document.createElement('div');
          stepWrapper.className = 'step';
          stepWrapper.innerHTML = `
            <div class="timeline">
              <div class="timeline-circle">
                <svg class="checkmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">
                  <path class="checkmark__check" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
                </svg>
              </div>
              <div class="timeline-line"></div>
            </div>
          `;
          const stepContent = document.createElement('div');
          stepContent.className = 'step-content';
          const p = document.createElement('div');
          p.innerHTML = renderMarkdown(msg.text || '');
          stepContent.appendChild(p);
          stepWrapper.appendChild(stepContent);
          thinkingState.traceEl.appendChild(stepWrapper);
          els.messages.scrollTop = els.messages.scrollHeight;
          persistMessagesDebounced(false);
        }
      } else if (msg.status === 'idle') {
        if (thinkingState) {
          clearInterval(thinkingState.timer);
          const lastStep = thinkingState.traceEl.querySelector('.step:last-child');
          if (lastStep) lastStep.classList.add('completed');
          const summary = thinkingState.el.querySelector('summary');
          summary.innerHTML = `Finished in ${thinkingState.seconds} seconds`;
          // Keep the timeline open for the user to review; do not auto-collapse
          thinkingState = null;
        }
        const button = els.form.querySelector('button[type="submit"]');
        if (button) {
          button.classList.remove('loading');
          button.disabled = false;
        }
        els.input.disabled = false;
        persistMessagesDebounced(true);
      }
    }
  }
  // Render messages globally across tabs (no tabId filtering)
  render();
});

hydrateMessages();
restoreSettings();
// -------------------- Model autocomplete --------------------
let allModels = [];
let modelsLoaded = false;
let dropdownHoverIndex = -1;

async function fetchOpenRouterModels() {
  try {
    const { openrouterKey } = await chrome.storage.local.get(['openrouterKey']);
    const headers = openrouterKey ? { 'Authorization': `Bearer ${openrouterKey}` } : {};
    const res = await fetch('https://openrouter.ai/api/v1/models', { headers });
    const data = await res.json().catch(() => ({}));
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : (Array.isArray(data) ? data : []));
    // Normalize minimal fields
    return (list || []).map(m => ({ id: m.id || m.slug || '', name: m.name || '', pricing: m.pricing || m.price || null })).filter(m => m.id);
  } catch {
    return [];
  }
}

async function ensureModelsLoaded() {
  if (modelsLoaded && allModels.length) return;
  allModels = await fetchOpenRouterModels();
  modelsLoaded = true;
}

function isFreeModel(id) {
  return /:free\s*$/i.test(id || '');
}

function isStealthModel(id) {
  return /^openrouter\//.test(id || '') && id !== 'openrouter/auto' && id !== 'openrouter/auto:free';
}

function fuzzyScore(hay, needle) {
  hay = String(hay || '').toLowerCase();
  needle = String(needle || '').toLowerCase();
  if (!needle) return 0;
  // Simple subsequence scoring with bonus for startswith and contiguous hits
  let score = 0, j = 0, run = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) {
    if (hay[i] === needle[j]) {
      j++; run++; score += 2 + Math.min(run, 3);
    } else { run = 0; }
  }
  if (j < needle.length) return -1; // not a subsequence
  if (hay.startsWith(needle)) score += 8;
  return score;
}

function renderModelDropdown(items, query) {
  const el = els.modelDropdown;
  if (!el) return;
  if (!items || items.length === 0) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  dropdownHoverIndex = -1;
  const makeItem = (m) => `<div class="model-item" data-id="${m.id}">${m.id}${m.name && m.name !== m.id ? ` — <span style="color: var(--fg-muted)">${m.name}</span>` : ''}</div>`;
  el.innerHTML = items.map(makeItem).join('');
  el.classList.remove('hidden');
}

function pickModel(id) {
  if (!id) return;
  els.model.value = id;
  if (els.modelDropdown) els.modelDropdown.classList.add('hidden');
}

function buildDefaultLists() {
  const stealth = allModels.filter(m => isStealthModel(m.id));
  const free = allModels.filter(m => isFreeModel(m.id));
  return { stealth, free };
}

function limitPaid(items) {
  // limit to keep list manageable
  return items.slice(0, 50);
}

function filterModels(query, onlyFree) {
  query = String(query || '').trim();
  if (!query) {
    const { stealth, free } = buildDefaultLists();
    const list = [
      { type: 'group', title: 'OpenRouter Stealth', items: stealth },
      { type: 'group', title: 'Free', items: free }
    ];
    return list;
  }
  const scored = allModels.map(m => ({ m, s: fuzzyScore(m.id, query) })).filter(x => x.s >= 0);
  let items = scored.sort((a,b) => b.s - a.s).map(x => x.m);
  if (onlyFree) items = items.filter(m => isFreeModel(m.id));
  // show all free, limit paid
  const freeItems = items.filter(m => isFreeModel(m.id));
  const paidItems = items.filter(m => !isFreeModel(m.id));
  return [
    { type: 'group', title: 'Free', items: freeItems },
    { type: 'group', title: 'Paid', items: limitPaid(paidItems) }
  ];
}

function flattenGroups(groups) {
  const out = [];
  for (const g of groups) {
    if (!g.items.length) continue;
    out.push({ type: 'header', title: g.title });
    out.push(...g.items.map(m => ({ type: 'item', model: m })));
  }
  return out;
}

function renderGroups(groups) {
  const el = els.modelDropdown;
  if (!el) return;
  const flat = flattenGroups(groups);
  if (!flat.length) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  const html = flat.map(entry => {
    if (entry.type === 'header') return `<div class="model-group">${entry.title}</div>`;
    const m = entry.model;
    return `<div class="model-item" data-id="${m.id}">${m.id}${m.name && m.name !== m.id ? ` — <span style=\"color: var(--fg-muted)\">${m.name}</span>` : ''}</div>`;
  }).join('');
  el.innerHTML = html;
  el.classList.remove('hidden');
}

function onModelInputFocusOrChange() {
  const q = els.model.value;
  const groups = filterModels(q, false);
  renderGroups(groups);
}

function initModelAutocomplete() {
  if (!els.model || !els.modelDropdown) return;
  els.model.addEventListener('click', async () => { await ensureModelsLoaded(); onModelInputFocusOrChange(); });
  els.model.addEventListener('input', onModelInputFocusOrChange);
  els.model.addEventListener('input', () => {
    const v = String(els.model.value || '').trim();
    if (v) { els.model.classList.remove('input-error'); if (els.modelError) els.modelError.style.display = 'none'; }
  });
  els.modelDropdown.addEventListener('click', (e) => {
    const item = e.target.closest('.model-item');
    if (!item) return;
    pickModel(item.getAttribute('data-id'));
    // Clear errors after selection
    if (els.model) els.model.classList.remove('input-error');
    if (els.modelError) els.modelError.style.display = 'none';
  });
  document.addEventListener('click', (e) => {
    if (!els.modelDropdown.contains(e.target) && e.target !== els.model) {
      els.modelDropdown.classList.add('hidden');
    }
  });
}

initModelAutocomplete();


function initSuggestionChips() {
  if (!els.chips) return;
  const onClick = (ev) => {
    const btn = ev.target.closest('.suggestion-chip');
    if (!btn) return;
    const prefix = btn.getAttribute('data-prefix') || '';
    // Hide immediately and send, don't populate the input
    try { els.chips.classList.add('hidden'); } catch {}
    sendPrompt(prefix);
  };
  els.chips.addEventListener('click', onClick);
  updateChipsVisibility();
}

function hasMessages() {
  return !!els.messages && els.messages.querySelector('.msg');
}

function updateChipsVisibility() {
  if (!els.chips) return;
  const show = !hasMessages();
  els.chips.classList.toggle('hidden', !show);
}

els.input.addEventListener('input', () => updateChipsVisibility());