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
let streamingState = null;

function ensureStreamBubble() {
  if (streamingState?.el?.isConnected) return streamingState;
  const div = document.createElement('div');
  div.className = 'msg assistant';
  const content = document.createElement('div');
  content.className = 'stream-content';
  div.appendChild(content);
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  streamingState = { el: div, contentEl: content, text: '' };
  return streamingState;
}

function appendStreamText(text) {
  const s = ensureStreamBubble();
  s.text += text;
  s.contentEl.innerHTML = renderMarkdown(s.text);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function endStream(totalSeconds, steps) {
  if (!streamingState) return;
  streamingState = null;
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
  return sanitize(md);
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

chrome.runtime.onMessage.addListener((msg) => {
  function render() {
    if (msg.type === 'SIDE_STREAM_START') {
      ensureStreamBubble();
    }
    if (msg.type === 'SIDE_STREAM_DELTA') {
      appendStreamText(msg.text || '');
    }
    if (msg.type === 'SIDE_STREAM_END') {
      endStream(msg.totalDuration, msg.steps);
    }

    if (msg.type === 'SIDE_FINAL_RESPONSE') {
      if (thinkingState) {
        clearInterval(thinkingState.timer);
        const summary = thinkingState.el.querySelector('summary');
        summary.innerHTML = `Thought for ${msg.totalDuration || thinkingState.seconds} seconds`;
        thinkingState = null;
      }
      addMessage('assistant', msg.finalAnswer);
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
        }
      } else if (msg.status === 'idle') {
        if (thinkingState) {
          clearInterval(thinkingState.timer);
          const lastStep = thinkingState.traceEl.querySelector('.step:last-child');
          if (lastStep) lastStep.classList.add('completed');
          const summary = thinkingState.el.querySelector('summary');
          summary.innerHTML = `Finished in ${thinkingState.seconds} seconds`;
          thinkingState = null;
        }
        const button = els.form.querySelector('button[type="submit"]');
        if (button) {
          button.classList.remove('loading');
          button.disabled = false;
        }
        els.input.disabled = false;
      }
    }
  }
  // Render messages globally across tabs (no tabId filtering)
  render();
});

restoreSettings();

