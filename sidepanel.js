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
  chatTab: document.getElementById('chat-tab'),
  settingsTab: document.getElementById('settings-tab'),
  aboutTab: document.getElementById('about-tab'),
  chatPanel: document.getElementById('chat-panel'),
  settingsPanel: document.getElementById('settings-panel'),
  aboutPanel: document.getElementById('about-panel'),
  glider: document.querySelector('.glider'),
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
}

function ensureStreamBubble() {
  if (streamingState?.el?.isConnected) return streamingState;
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.setAttribute('data-streaming', 'true');
  const content = document.createElement('div');
  content.className = 'stream-content';
  div.appendChild(content);
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  streamingState = { el: div, contentEl: content, text: '' };
  persistMessagesDebounced(false);
  return streamingState;
}

let renderThrottleTimer = null;
function appendStreamText(text) {
  const s = ensureStreamBubble();
  s.text += text;
  // Throttle expensive markdown + DOM updates
  if (renderThrottleTimer) return;
  renderThrottleTimer = setTimeout(() => {
    try {
      s.contentEl.innerHTML = renderMarkdown(s.text);
      els.messages.scrollTop = els.messages.scrollHeight;
      streamBuffer = s.text;
      chrome.storage.session.set({ ui_stream_buffer: streamBuffer });
      persistMessagesDebounced(false);
    } catch {}
    renderThrottleTimer = null;
  }, 90);
}

function endStream(totalSeconds, steps) {
  if (!streamingState) return;
  const finalMsgEl = streamingState.el;
  try { finalMsgEl.removeAttribute('data-streaming'); } catch {}
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
        const jsonDetails = document.createElement('details');
        const jsonSummary = document.createElement('summary');
        jsonSummary.textContent = 'View Raw Result';
        jsonDetails.appendChild(jsonSummary);
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(step.jsonData, null, 2);
        jsonDetails.appendChild(pre);
        body.appendChild(jsonDetails);
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
  return div;
}

function addMessageHtml(role, html) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `<span class="role">${role}</span>${html}`;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  persistMessagesDebounced(true);
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
  // Fallback: return raw HTML (extension context already isolates content scripts)
  return String(html);
}

function renderMarkdown(raw) {
  const md = (window && window.marked && typeof window.marked.parse === 'function')
    ? window.marked.parse(String(raw || ''))
    : basicMarkdown(String(raw || ''));
  return enhanceLinks(sanitize(md));
}

function basicMarkdown(text) {
  let out = text
    .replace(/^####\s+(.*)$/gm, '<h4>$1</h4>')
    .replace(/^###\s+(.*)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.*)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/^(?:\s*[-*]\s+)(.*)$/gm, '<li>$1</li>');
  out = out.replace(/<\/li>\s*<li>/g, '</li><li>');
  out = out.replace(/(<li>.*?<\/li>)/gs, (m) => `<ul>${m}</ul>`);
  out = out.replace(/<ul>\s*<ul>/g, '<ul>').replace(/<\/ul>\s*<\/ul>/g, '</ul>');
  out = out.replace(/\n/g, '<br/>');
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
  try { await chrome.storage.session.remove(['ui_messages_html', 'ui_stream_buffer']); } catch {}
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

  // Allow cancelling from the stop icon inside the loader
  const stop = button.querySelector('.cancel-stop');
  const onCancel = () => { try { chrome.runtime.sendMessage({ type: 'CANCEL_RUN' }); } catch {} };
  stop?.addEventListener('click', onCancel, { once: true });

  createThinkingBlock();
  chrome.runtime.sendMessage({ type: 'SIDE_INPUT', tabId, content });
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
      ensureStreamBubble();
    }
    if (msg.type === 'SIDE_STREAM_DELTA') {
      appendStreamText(msg.text || '');
    }
    if (msg.type === 'SIDE_STREAM_ABORT') {
      if (streamingState?.el) {
        try { streamingState.el.removeAttribute('data-streaming'); } catch {}
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
          header.innerHTML = renderMarkdown(`**${msg.text}**`);
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
            body.innerHTML = contentHtml;

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
              const jsonDetails = document.createElement('details');
              const jsonSummary = document.createElement('summary');
              jsonSummary.textContent = 'View Raw Result';
              jsonDetails.appendChild(jsonSummary);
              const pre = document.createElement('pre');
              pre.textContent = JSON.stringify(stepDetail.jsonData, null, 2);
              jsonDetails.appendChild(pre);
              body.appendChild(jsonDetails);
            }

            detailsEl.appendChild(body);
            stepContent.appendChild(detailsEl);
            els.messages.scrollTop = els.messages.scrollHeight;
            persistMessagesDebounced(false);
            return;
          }
        }

        // Fallback: if neither condition matched, append plain text into a new timeline step
        {
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
          try { thinkingState.el.open = false; } catch {}
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

