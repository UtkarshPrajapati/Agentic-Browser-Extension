// Service worker orchestrator: OpenRouter LLM, MCP stubs, tool dispatch

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

chrome.runtime.onInstalled.addListener(() => {
  console.log('Agent Sidebar installed');
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  try {
    if (!tab.url) return;
    await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
  } catch (e) {
    console.warn('sidePanel.setOptions error', e);
  }
});

function status(tabId, text, st = 'info') {
  if (!tabId) return;
  chrome.runtime.sendMessage({ type: 'SIDE_STATUS', status: st, text, tabId }).catch(() => {});
}

async function callContentTool(tabId, name, args) {
  const payload = { type: 'EXT_TOOL', name, args, callId: crypto.randomUUID() };
  function send() {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, payload, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp);
        }
      });
    });
  }
  let resp = await send();
  if (!resp?.ok && String(resp?.error || '').includes('Receiving end does not exist')) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      resp = await send();
    } catch (e) {
      return { ok: false, error: `Injection failed: ${String(e)}` };
    }
  }
  return resp;
}

async function screenshotVisible(tabId) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab();
    return { ok: true, dataUrl };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId }));
}

async function openTab(url) {
  const t = await chrome.tabs.create({ url, active: true });
  return { id: t.id, url: t.url, title: t.title };
}

async function activateTabByMatch(match) {
  const tabs = await chrome.tabs.query({});
  const needle = match.toLowerCase();
  let t = tabs.find(x => (x.title?.toLowerCase().includes(needle) || x.url?.toLowerCase().includes(needle)));
  if (!t) {
    // Fuzzy match on title/hostname
    function sim(a, b) {
      a = (a || '').toLowerCase(); b = (b || '').toLowerCase();
      if (!a.length && !b.length) return 1;
      const dp = Array(a.length + 1).fill(null).map(() => Array(b.length + 1).fill(0));
      for (let i = 0; i <= a.length; i++) dp[i][0] = i;
      for (let j = 0; j <= b.length; j++) dp[0][j] = j;
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
        }
      }
      const dist = dp[a.length][b.length];
      const maxLen = Math.max(a.length, b.length) || 1;
      return 1 - dist / maxLen;
    }
    let best = null;
    let bestScore = 0;
    for (const x of tabs) {
      const host = (() => { try { return new URL(x.url || '').hostname; } catch { return ''; } })();
      const score = Math.max(sim(x.title || '', needle), sim(x.url || '', needle), sim(host, needle));
      if (score > bestScore) { bestScore = score; best = x; }
    }
    if (bestScore >= 0.6) t = best;
  }
  if (!t) return { ok: false, error: 'No tab matched' };
  await chrome.tabs.update(t.id, { active: true });
  try {
    const tab = await getTab(t.id);
    chrome.runtime.sendMessage({ type: 'SIDE_ASSISTANT', text: `Switched to tab: ${tab?.title || t.id}`, tabId: t.id });
  } catch {}
  return { ok: true, result: { id: t.id, title: t.title, url: t.url } };
}

function getTab(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.get(tabId, (tab) => resolve(tab));
    } catch (e) {
      resolve(null);
    }
  });
}

async function closeTabByMatch(match) {
  const tabs = await chrome.tabs.query({});
  const needle = match.toLowerCase();
  const t = tabs.find(x => (x.title?.toLowerCase().includes(needle) || x.url?.toLowerCase().includes(needle)));
  if (!t) return { ok: false, error: 'No tab matched' };
  await chrome.tabs.remove(t.id);
  return { ok: true };
}

// Governance: simple allowlist and robots.txt awareness
async function isAllowed(url) {
  const { allowlist = [] } = await chrome.storage.local.get(['allowlist']);
  if (allowlist.length === 0) return true; // default allow
  try {
    const host = new URL(url).hostname;
    return allowlist.some(d => host === d || host.endsWith(`.${d}`));
  } catch { return false; }
}

async function checkRobotsTxt(url) {
  try {
    const u = new URL(url);
    const robotsUrl = `${u.origin}/robots.txt`;
    const res = await fetch(robotsUrl, { method: 'GET' });
    const text = await res.text();
    return { ok: true, robots: text.slice(0, 2000) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// MCP client stubs (placeholder interfaces for future MCP SDK integration)
async function mcp_fetch_get(input) {
  const { url, headers } = input;
  const allowed = await isAllowed(url);
  if (!allowed) return { ok: false, error: 'Domain not allowed by policy' };
  const res = await fetch(url, { headers: headers || {} });
  const body = await res.text();
  return { ok: true, status: res.status, headers: Object.fromEntries(res.headers.entries()), body: body.slice(0, 500000) };
}

async function mcp_fs_read(path) {
  const { fs = {} } = await chrome.storage.local.get(['fs']);
  return { ok: true, content: fs[path] || '' };
}

async function mcp_fs_write(path, content) {
  const data = await chrome.storage.local.get(['fs']);
  const fs = data.fs || {};
  fs[path] = content;
  await chrome.storage.local.set({ fs });
  return { ok: true };
}

async function mcp_rag_query(q) {
  // simple in-memory notes from storage as corpus
  const { notes = [] } = await chrome.storage.local.get(['notes']);
  const scored = notes.map((n) => ({ n, score: (n.text || '').toLowerCase().includes(q.toLowerCase()) ? 1 : 0 }))
    .filter(x => x.score > 0);
  return { ok: true, results: scored.map(s => s.n).slice(0, 10) };
}

// OpenRouter tool-calling
async function openrouterCall(messages, tools) {
  const { openrouterKey, model = 'anthropic/claude-3.7-sonnet' } = await chrome.storage.local.get(['openrouterKey', 'model']);
  if (!openrouterKey) throw new Error('OpenRouter API key not set in Settings');
  const body = { model, messages, tools, parallel_tool_calls: true };
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${openrouterKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`OpenRouter error: ${res.status}`);
  return res.json();
}

function fn(name, description, parameters) {
  return { type: 'function', function: { name, description, parameters } };
}

function buildToolSchemas() {
  return [
    fn('read_page', 'Read current page DOM and metadata', { type: 'object', properties: {} }),
    fn('click', 'Click element by CSS selector', { type: 'object', required: ['selector'], properties: { selector: { type: 'string' } } }),
    fn('click_text', 'Click first clickable element containing given text', { type: 'object', required: ['text'], properties: { text: { type: 'string' } } }),
    fn('type', 'Type text into element by selector', { type: 'object', required: ['selector','text'], properties: { selector: { type: 'string' }, text: { type: 'string' } } }),
    fn('scroll', 'Scroll page to top offset', { type: 'object', properties: { top: { type: 'number' }, behavior: { type: 'string', enum: ['auto','smooth'] } } }),
    fn('extract_table', 'Extract table data at selector', { type: 'object', required: ['selector'], properties: { selector: { type: 'string' } } }),
    fn('open_tab', 'Open a new tab to URL', { type: 'object', required: ['url'], properties: { url: { type: 'string' } } }),
    fn('switch_tab', 'Activate a tab by matching title or URL', { type: 'object', required: ['match'], properties: { match: { type: 'string' } } }),
    fn('close_tab', 'Close a tab by matching title or URL', { type: 'object', required: ['match'], properties: { match: { type: 'string' } } }),
    fn('get_tabs', 'List open tabs', { type: 'object', properties: {} }),
    fn('screenshot', 'Capture visible tab image', { type: 'object', properties: {} }),
    // MCP
    fn('mcp.fetch.get', 'GET fetch via MCP', { type: 'object', required: ['url'], properties: { url: { type: 'string' }, headers: { type: 'object' } } }),
    fn('mcp.fs.read', 'Read virtual file', { type: 'object', required: ['path'], properties: { path: { type: 'string' } } }),
    fn('mcp.fs.write', 'Write virtual file', { type: 'object', required: ['path','content'], properties: { path: { type: 'string' }, content: { type: 'string' } } }),
    fn('mcp.rag.query', 'Query notes corpus', { type: 'object', required: ['q'], properties: { q: { type: 'string' } } }),
  ];
}

async function dispatchToolCall(tabId, call) {
  let name = call.name;
  let args = call.arguments;
  if (!args && call.function) {
    name = call.function.name;
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
  }
  switch (name) {
    case 'read_page': return callContentTool(tabId, 'read_page', args);
    case 'click': return callContentTool(tabId, 'click', args);
    case 'click_text': return callContentTool(tabId, 'click_text', args);
    case 'type': return callContentTool(tabId, 'type', args);
    case 'scroll': return callContentTool(tabId, 'scroll', args);
    case 'extract_table': return callContentTool(tabId, 'extract_table', args);
    case 'screenshot': return screenshotVisible(tabId);
    case 'get_tabs': return { ok: true, result: await listTabs() };
    case 'open_tab': return { ok: true, result: await openTab(args.url) };
    case 'switch_tab': return await activateTabByMatch(args.match);
    case 'close_tab': return await closeTabByMatch(args.match);
    // MCP
    case 'mcp.fetch.get': return await mcp_fetch_get(args);
    case 'mcp.fs.read': return await mcp_fs_read(args.path);
    case 'mcp.fs.write': return await mcp_fs_write(args.path, args.content);
    case 'mcp.rag.query': return await mcp_rag_query(args.q);
    default: return { ok: false, error: `Unknown tool ${name}` };
  }
}

// New helper functions for conversation history
async function getHistory() {
  const data = await chrome.storage.session.get(['chat_history']);
  return data['chat_history'] || [];
}

async function saveHistory(messages) {
  await chrome.storage.session.set({ 'chat_history': messages });
}

async function clearHistory() {
  await chrome.storage.session.remove(['chat_history']);
}

// Helper for human-friendly tool messages
function sendHumanToolFeedback(tabId, call, r) {
    if (!r.ok) {
        chrome.runtime.sendMessage({ type: 'SIDE_ASSISTANT', text: `Tool error (${call.function.name}): ${r.error}`, tabId });
        return;
    }
    const name = call.function.name;
    if (name === 'screenshot') {
        chrome.runtime.sendMessage({ type: 'SIDE_IMAGE', dataUrl: r.dataUrl, tabId });
    } else if (name === 'get_tabs') {
        const tabs = r.result || [];
        const list = tabs.slice(0, 10).map(t => `- ${t.active ? '**' : ''}${t.title || t.url}${t.active ? '**' : ''}`).join('\n');
        chrome.runtime.sendMessage({ type: 'SIDE_ASSISTANT', text: `Open tabs:\n${list}${tabs.length > 10 ? '\n…' : ''}`, tabId });
    } else if (name === 'switch_tab') {
      if (r.ok) {
          chrome.runtime.sendMessage({ type: 'SIDE_ASSISTANT', text: `Switched to: **${r.result.title}**`, tabId });
      } else {
          chrome.runtime.sendMessage({ type: 'SIDE_ASSISTANT', text: `Could not switch tab: ${r.error}`, tabId });
      }
    } else if (name === 'open_tab') {
        chrome.runtime.sendMessage({ type: 'SIDE_ASSISTANT', text: `Opened: ${r.result?.title || r.result?.url || ''}`, tabId });
    } else if (name === 'click_text' || name === 'click') {
        chrome.runtime.sendMessage({ type: 'SIDE_ASSISTANT', text: `Clicked element.`, tabId });
    }
}


async function handleSideInput(tabId, content) {
  status(tabId, 'Thinking...', 'working');
  const tools = buildToolSchemas();
  
  let messages = await getHistory();
  if (messages.length === 0) {
    messages.push({ role: 'system', content: 'You are Sonoma, a Comet-style in-tab agent. You prefer taking visible actions using tools. For complex tasks, break them down into steps. After using a tool, analyze the result and decide the next step. When the task is complete, provide a final, clear answer to the user.' });
  }
  messages.push({ role: 'user', content });

  try {
    const MAX_TURNS = 5;
    let finalAnswerGenerated = false;

    for (let i = 0; i < MAX_TURNS; i++) {
      const completion = await openrouterCall(messages, tools);
      const choice = completion.choices?.[0];
      if (!choice) throw new Error('No choices from OpenRouter');

      const assistantMessage = choice.message;
      messages.push(assistantMessage);

      if (assistantMessage.tool_calls) {
        let tool_outputs = [];
        for (const call of assistantMessage.tool_calls) {
          status(tabId, `Executing: ${call.function.name}`, 'working');
          const result = await dispatchToolCall(tabId, call);
          
          sendHumanToolFeedback(tabId, call, result);

          chrome.runtime.sendMessage({ type: 'SIDE_JSON', title: `${call.function.name} Result`, payload: result, tabId });

          tool_outputs.push({
            tool_call_id: call.id,
            role: 'tool',
            name: call.function.name,
            content: JSON.stringify(result),
          });
        }
        messages.push(...tool_outputs);
      }

      if (assistantMessage.content) {
        chrome.runtime.sendMessage({ type: 'SIDE_ASSISTANT', text: assistantMessage.content, tabId });
        finalAnswerGenerated = true;
        break; 
      }

      if (!assistantMessage.tool_calls) {
        if (!finalAnswerGenerated) {
           chrome.runtime.sendMessage({ type: 'SIDE_ASSISTANT', text: "Completed the requested actions.", tabId });
        }
        break;
      }
    }
    
    await saveHistory(messages);

  } catch (e) {
    chrome.runtime.sendMessage({ type: 'SIDE_ASSISTANT', text: `Error: ${String(e)}`, tabId });
  } finally {
    status(tabId, '', 'idle');
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  (async () => {
    if (msg?.type === 'SIDE_INPUT') {
      await handleSideInput(msg.tabId, msg.content);
    } else if (msg?.type === 'CLEAR_HISTORY') {
      await clearHistory();
    }
  })();
  return true; // Keep message channel open for async response
});


