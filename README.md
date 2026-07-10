# Code Companion — Chrome Extension

An AI code companion that captures code from any web page and helps you **debug**, **explain**, and **optimize** it using the OpenAI API, with follow-up chat.

## Install

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle, top right)
3. Click **Load unpacked** and select the `code-companion` folder
4. Open the `.env` file in the `code-companion` folder and set `OPENAI_API_KEY=sk-...` (and optionally `OPENAI_MODEL=` to change the model — defaults to `gpt-4o-mini`)
5. Click the Code Companion icon in the toolbar to open the side panel — it reads the key and model from `.env` automatically

## Use

- **Capture code from page** — grabs highlighted text if you've selected any; otherwise auto-detects code on the page (Monaco, CodeMirror, and Ace editors, `<pre>`/`<code>` blocks, textareas). You can also paste code manually.
- **Right-click** any selected code on a page → **Debug with Code Companion**
- **🐞 Debug / 💡 Explain / ⚡ Optimize** — one-click analysis of the captured code
- **Follow-up box** — ask anything about the code; conversation context is kept

## Privacy & notes

- Your API key lives only in the `.env` file shipped with the extension folder (not typed by users, not in `chrome.storage`) and is sent only to `api.openai.com`
- Captured code is sent to OpenAI when you run an action — don't use on confidential code you can't share with OpenAI
- Capture is limited to ~60k characters; Monaco editors expose only visible lines (scroll to load more)
- Doesn't work on browser-internal pages (`chrome://…`)

## Files

- `.env` — holds `OPENAI_API_KEY` and `OPENAI_MODEL` (edit this instead of entering a key or picking a model in the UI)
- `manifest.json` — Manifest V3 config
- `background.js` — service worker: side panel, context menu, capture relay
- `content.js` — extracts code from the page
- `sidepanel.html/css/js` — UI, OpenAI streaming client, chat
