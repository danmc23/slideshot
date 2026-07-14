// background.js
// Handles the actual pixel capture, since captureVisibleTab is only
// available from the extension (background) context, not content scripts.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "CAPTURE_TAB") {
    if (!sender.tab || !sender.tab.windowId) {
      sendResponse({ error: "No active tab/window to capture." });
      return true;
    }
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ dataUrl });
      }
    });
    return true; // keep the message channel open for the async callback
  }

  if (msg && msg.type === "DOWNLOAD_FILE") {
    // Downloading via chrome.downloads (instead of a content-script <a
    // download> click) avoids Chrome's "multiple automatic downloads"
    // block, which silently drops the 2nd/3rd file when a page triggers
    // several downloads back to back.
    chrome.downloads.download({ url: msg.url, filename: msg.filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ downloadId });
      }
    });
    return true;
  }
});
