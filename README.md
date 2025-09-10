## Agent Sidebar (Comet-style)

Interactive, visible in-tab agent using Manifest V3 Side Panel, OpenRouter tool-calling, and MCP stubs.

### Features
- Side panel chat UI per tab
- OpenRouter LLM with JSON tool calling (parallel enabled)
- Content-script visible actions: read_page, click, type, scroll, extract_table
- Cross-tab tools: get_tabs, open/switch/close, screenshot
- MCP stubs: mcp.fetch.get, mcp.fs.read/write, mcp.rag.query
- Governance: allowlist, robots.txt check (fetch only)

### Setup
1. Get an OpenRouter API key: https://openrouter.ai/
2. Load the extension:
   - Chrome/Edge: chrome://extensions → Load unpacked → select this folder.
   - Firefox: about:debugging#/runtime/this-firefox → Load Temporary Add-on → pick manifest.firefox.json.
3. Open any page; the side panel should be enabled. Open it via the Side Panel button.
4. In Settings, paste your OpenRouter key and optional allowlist domains.

### Notes
- MV3 service workers sleep; long tasks should chunk work and emit status.
- Screenshots via chrome.tabs.captureVisibleTab require user-visible tab.
- For Firefox, sidePanel API differs; uses sidebarAction with manifest.firefox.json.

### Development
- sw.js orchestrates LLM calls and tool dispatch.
- content.js performs visible DOM actions with ephemeral overlays.
- sidepanel.* implements the UI and messaging to sw.js.

