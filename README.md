## Agent Sidebar – In‑Tab AI Agent (MV3 Side Panel)

A Comet‑style, visible, in‑tab agent that understands the current page, takes actions in the DOM via content scripts, coordinates tools via a MV3 service worker, and chats from a persistent Side Panel. Powered by OpenRouter (OpenAI‑compatible) tool calling and MCP stubs.

### Highlights
- Global Side Panel chat across tab switches (no session loss on navigate/switch)
- Tool streaming: assistant text streams live; actions are shown as a collapsible log
- Real‑time “Thinking” timeline with animated steps, tick marks, and connectors
- Markdown rendering (fallback safe parser) with sanitization when available
- Visible, user‑approved actions in the page (highlight + confirm)
- Robust content‑script injection/retry to avoid “Receiving end does not exist”
- Fuzzy tab switching; human‑readable feedback for each tool
- Screenshot display with download link
- Clear Chat, settings for OpenRouter key/model/allowlist
- Toolbar icon opens the Side Panel
- Extension logo support (manifest + sidebar header)

### Tools Available
- Page/DOM: `read_page`, `click(selector)`, `click_text(text)`, `type(selector,text)`, `scroll({top,behavior})`, `extract_table(selector)`
- Tabs: `get_tabs`, `open_tab(url)`, `switch_tab(match)`, `close_tab`
- Media: `screenshot` (visible tab capture via background)
- MCP stubs: `mcp.fetch.get(url, headers?)`, `mcp.fs.read(path)`, `mcp.fs.write(path,content)`, `mcp.rag.query(q)`

### How It Behaves
- Agentic loop (Observe → Plan → Act → Analyze → Repeat) with up to 10 steps
- Read‑only first: proactively navigate and read pages before asking for creds
- Ask confirmation before any modifying/irreversible action
- Streams text responses via SSE; shows step log in a collapsed “Actions Taken” block
- Per‑step live timeline in the thinking box: hollow circle → tick on completion; vertical connector animates to the next step

### Screenshots/UX
- Loader spinner centered in the Send button; icon fades during processing
- Per‑tool natural‑language feedback (tabs list, switched tab name, etc.)
- Collapsible JSON results; images display inline with download links

### Setup
1) Get an OpenRouter API key (`https://openrouter.ai/`).
2) Place your logo file at:
   - `icons/logo.png` (declared in manifest and shown in the sidebar header)
3) Load the extension:
   - Chrome/Edge: `chrome://extensions` → Enable Developer mode → Load unpacked → pick this folder
   - Firefox (temporary): `about:debugging#/runtime/this-firefox` → Load Temporary Add‑on → select `manifest.firefox.json`
4) Open the Side Panel, expand Settings, and set:
   - OpenRouter API Key
   - Model (defaults to `anthropic/claude-3.7-sonnet`)
   - Allowlist (optional, comma‑separated domains)

### Usage Tips
- Ask natural requests like “summarise this page”, “list tabs”, “switch to github”, “extract table at #prices”.
- For actions, you’ll see a thinking timeline with “Executing: …” followed by a ticked step and details.
- Tool outputs are collapsed by default; expand “Actions Taken” to inspect details and raw JSON.
- The panel is global—switching tabs will not interrupt a run.

### Architecture
- `manifest.json` – MV3 config; background service worker; side panel; icons
- `sw.js` – Orchestrator:
  - Builds system prompt (proactive read‑only first, session‑aware)
  - Calls OpenRouter (chat + SSE stream) with parallel tool calls
  - Dispatches tools to content script/background helpers
  - Emits status/events for streaming UI + final response + step logs
- `content.js` – DOM tools with visible overlays + user confirmation
- `sidepanel.html/css/js` – Side Panel UI, streaming rendering, timeline, markdown
- `vendor/*` – small utility modules (placeholders)

### Security/Privacy
- Read‑only first policy: try page navigation and reading before requesting secrets
- Confirmation required before any modifying action
- Page content is untrusted for instructions (prompt‑injection aware)
- CSP‑safe: no remote script imports; optional local `marked`/`DOMPurify` supported if bundled

### Developing
- Service worker sleeps in MV3; all long tasks must emit progress and avoid silent waits
- If you hit “Receiving end does not exist”, the background will auto‑inject `content.js` and retry
- Streaming uses SSE; tool‑call deltas are rendered live

### Add/Change Logo
- Add your PNG to: `icons/logo.png`
- Manifest already references `icons/logo.png`; header shows it next to the title

### Known Limits
- Some sites (e.g., highly dynamic/locked down) can block script injection; `read_page` may be limited
- Private dashboards require you to be logged in within the same browser profile

