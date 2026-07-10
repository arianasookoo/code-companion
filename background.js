// Code Companion - background service worker

// Open the side panel when the toolbar icon is clicked
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error(e));

// Context menu: right-click selected text -> analyze in Code Companion
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'code-companion-analyze',
    title: 'Debug with Code Companion',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'code-companion-analyze' || !tab?.id) return;
  // Stash the selection so the panel can pick it up when it opens
  await chrome.storage.session.set({
    pendingCapture: {
      code: info.selectionText || '',
      source: 'selection',
      url: info.pageUrl || tab.url || '',
      ts: Date.now(),
    },
  });
  await chrome.sidePanel.open({ tabId: tab.id });
});

// Relay capture requests from the side panel to the active tab's content script
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'CAPTURE_CODE') return;
  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab found.');
      if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
        throw new Error('Cannot capture code from browser-internal pages. Open a regular web page.');
      }
      let response;
      try {
        response = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_CODE' });
      } catch {
        // Content script may not be injected yet (e.g., page loaded before install)
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        response = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_CODE' });
      }
      sendResponse({ ok: true, ...response, url: tab.url, title: tab.title });
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // keep the message channel open for async response
});
