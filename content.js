// Content script: DOM read/write and visible action helpers

const overlayId = '__agent_overlay__';

function ensureOverlay() {
  let el = document.getElementById(overlayId);
  if (el) return el;
  el = document.createElement('div');
  el.id = overlayId;
  el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  document.documentElement.appendChild(el);
  return el;
}

function highlightElement(target) {
  const overlay = ensureOverlay();
  const rect = target.getBoundingClientRect();
  const box = document.createElement('div');
  box.style.cssText = `position:fixed;left:${rect.left + window.scrollX}px;top:${rect.top + window.scrollY}px;width:${rect.width}px;height:${rect.height}px;border:2px solid #6aa3ff;border-radius:6px;background:rgba(106,163,255,0.1);box-shadow:0 0 0 9999px rgba(0,0,0,0.35);pointer-events:none;transition:opacity .3s;`;
  overlay.appendChild(box);
  setTimeout(() => { box.style.opacity = '0'; setTimeout(() => box.remove(), 300); }, 900);
}

function findElement(selector) {
  try { return document.querySelector(selector) || null; } catch { return null; }
}

async function waitForUserConfirm(promptText) {
  return new Promise((resolve) => {
    const ok = window.confirm(`[Agent] ${promptText}`);
    resolve(ok);
  });
}

async function tool_read_page() {
  return {
    url: location.href,
    title: document.title,
    selection: window.getSelection()?.toString() || '',
    html: document.documentElement.outerHTML.slice(0, 300000)
  };
}

async function tool_click(selector) {
  const el = findElement(selector);
  if (!el) throw new Error(`Selector not found: ${selector}`);
  highlightElement(el);
  const ok = await waitForUserConfirm(`Click element matching selector: ${selector}?`);
  if (!ok) return { cancelled: true };
  el.click();
  return { ok: true };
}

function findClickableByText(text) {
  const t = (text || '').toLowerCase();
  const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
  return candidates.find(el => (el.innerText || el.value || '').toLowerCase().includes(t)) || null;
}

async function tool_click_text(text) {
  const el = findClickableByText(text);
  if (!el) throw new Error(`No clickable element containing text: ${text}`);
  highlightElement(el);
  const ok = await waitForUserConfirm(`Click the element containing text: "${text}"?`);
  if (!ok) return { cancelled: true };
  el.click();
  return { ok: true };
}

async function tool_type(selector, text) {
  const el = findElement(selector);
  if (!el) throw new Error(`Selector not found: ${selector}`);
  highlightElement(el);
  const ok = await waitForUserConfirm(`Type into ${selector}: "${text}"?`);
  if (!ok) return { cancelled: true };
  el.focus();
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return { ok: true };
}

async function tool_scroll(arg) {
  const { top = 0, behavior = 'smooth' } = arg || {};
  window.scrollTo({ top, behavior });
  return { ok: true };
}

async function tool_extract_table(selector) {
  const el = findElement(selector);
  if (!el) throw new Error(`Selector not found: ${selector}`);
  const rows = Array.from(el.querySelectorAll('tr')).map(tr => Array.from(tr.querySelectorAll('th,td')).map(td => td.innerText.trim()));
  return { rows };
}

async function tool_screenshot() {
  // Placeholder: content scripts cannot directly screenshot; handled by background via chrome.tabs.captureVisibleTab
  return { error: 'use background screenshot' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'EXT_TOOL') {
        const { name, args, callId } = msg;
        let result;
        switch (name) {
          case 'read_page': result = await tool_read_page(); break;
          case 'click': result = await tool_click(args.selector); break;
          case 'click_text': result = await tool_click_text(args.text); break;
          case 'type': result = await tool_type(args.selector, args.text); break;
          case 'scroll': result = await tool_scroll(args); break;
          case 'extract_table': result = await tool_extract_table(args.selector); break;
          case 'screenshot': result = await tool_screenshot(); break;
          default: result = { error: `Unknown tool: ${name}` };
        }
        sendResponse({ ok: true, result, callId });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true;
});


