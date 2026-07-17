// background.js
// Handles the actual pixel capture, since captureVisibleTab is only
// available from the extension (background) context, not content scripts.
// Also owns the session/steps state machine: a session groups multiple
// captures together (plus voice narration) for a single combined export.

const SESSION_KEY = "slideshot_session";

function imgKey(stepId, suffix) {
  return "slideshot_img:" + stepId + (suffix ? ":" + suffix : "");
}

// --- offscreen document (hosts Web Speech API STT while a session records) ---

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Continuous speech-to-text narration while a capture session is recording.",
  });
}

async function closeOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
}

// Offscreen documents can't show a permission prompt, so the first time a
// session is started we open a normal tab where the user can grant mic
// access once; after that the extension's origin remembers the grant.
async function ensureMicPermissionRequested() {
  const res = await new Promise((resolve) => chrome.storage.local.get("slideshot_mic_permission_requested", resolve));
  if (res.slideshot_mic_permission_requested) return;
  await new Promise((resolve) => chrome.storage.local.set({ slideshot_mic_permission_requested: true }, resolve));
  chrome.tabs.create({ url: chrome.runtime.getURL("permission/permission.html") });
}

async function handleTranscriptChunk(text, tStart, tEnd) {
  const session = await getSession();
  if (!session || session.status !== "recording") return;
  session.transcript.push({ text, tStart, tEnd });
  await setSession(session);
}

function getSession() {
  return new Promise((resolve) => {
    chrome.storage.local.get(SESSION_KEY, (res) => resolve(res[SESSION_KEY] || null));
  });
}

function setSession(session) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SESSION_KEY]: session }, () => {
      broadcastSessionState(session);
      updateBadgeForSession(session);
      resolve();
    });
  });
}

function broadcastSessionState(session) {
  // Fire-and-forget to whoever's listening (the popup, if open). No
  // listener is the common case (popup closed) -- that's an expected
  // lastError, not a real failure, so it's swallowed.
  chrome.runtime.sendMessage({ type: "SESSION_STATE", session }, () => {
    void chrome.runtime.lastError;
  });
}

function updateBadgeForSession(session) {
  if (session && session.status === "recording") {
    chrome.action.setBadgeText({ text: String(session.steps.length) });
    chrome.action.setBadgeBackgroundColor({ color: "#ff3b30" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

function newSessionId() {
  return "s_" + Math.random().toString(36).slice(2) + "_" + Date.now();
}

async function startSession() {
  const session = {
    id: newSessionId(),
    status: "recording",
    startedAt: Date.now(),
    endedAt: null,
    steps: [],
    transcript: [],
  };
  await setSession(session);
  await ensureMicPermissionRequested();
  await ensureOffscreenDocument();
  chrome.runtime.sendMessage({ type: "START_STT", startedAt: session.startedAt }, () => {
    void chrome.runtime.lastError; // no offscreen doc yet on first-ever run -- harmless
  });
  return session;
}

async function stopSession() {
  const session = await getSession();
  if (!session) return null;
  session.status = "stopped";
  session.endedAt = Date.now();
  await setSession(session);
  chrome.runtime.sendMessage({ type: "STOP_STT" }, () => {
    void chrome.runtime.lastError;
  });
  await closeOffscreenDocument();
  return session;
}

async function toggleSession() {
  const session = await getSession();
  if (session && session.status === "recording") return stopSession();
  return startSession();
}

async function resetSession() {
  const session = await getSession();
  if (session) {
    const keysToRemove = [];
    session.steps.forEach((s) => {
      keysToRemove.push(imgKey(s.id), imgKey(s.id, "full"));
      (s.dropdowns || []).forEach((d) => keysToRemove.push(d.key));
    });
    if (keysToRemove.length) {
      await new Promise((resolve) => chrome.storage.local.remove(keysToRemove, resolve));
    }
  }
  await setSession(null);
  return null;
}

// Adds a finished capture as a session step. No-ops (returns null) if there
// is no actively-recording session -- this lets content.js call it
// unconditionally after every capture without needing to check session
// state itself first.
async function addStepToSession(step) {
  const session = await getSession();
  if (!session || session.status !== "recording") return null;

  const storageWrites = {};
  storageWrites[imgKey(step.id)] = step.croppedImage;
  storageWrites[imgKey(step.id, "full")] = step.fullImage;
  const dropdowns = (step.dropdownImages || []).map((d) => {
    const key = imgKey(step.id, "dropdown-" + d.ref);
    storageWrites[key] = d.dataUrl;
    return { ref: d.ref, filename: d.filename, key };
  });
  await new Promise((resolve) => chrome.storage.local.set(storageWrites, resolve));

  session.steps.push({
    id: step.id,
    index: session.steps.length,
    timestamp: step.timestamp,
    baseName: step.baseName,
    pageUrl: step.pageUrl,
    pageTitle: step.pageTitle,
    notesText: step.notesText,
    narrationOverride: null,
    dropdowns,
  });
  await setSession(session);
  return session;
}

async function updateStepNarration(stepId, text) {
  const session = await getSession();
  if (!session) return null;
  const step = session.steps.find((s) => s.id === stepId);
  if (step) step.narrationOverride = text;
  await setSession(session);
  return session;
}

async function deleteStep(stepId) {
  const session = await getSession();
  if (!session) return null;
  const step = session.steps.find((s) => s.id === stepId);
  if (!step) return session;
  const keysToRemove = [imgKey(step.id), imgKey(step.id, "full")];
  (step.dropdowns || []).forEach((d) => keysToRemove.push(d.key));
  await new Promise((resolve) => chrome.storage.local.remove(keysToRemove, resolve));
  session.steps = session.steps.filter((s) => s.id !== stepId).map((s, i) => ({ ...s, index: i }));
  await setSession(session);
  return session;
}

// Restore the toolbar badge on service-worker wake (MV3 workers can be
// evicted between events; storage survives, in-memory state doesn't).
getSession().then(updateBadgeForSession);

// Toggling via the keyboard command happens with no popup open and no UI of
// its own, so without this there's no way to tell it actually did anything
// short of noticing the mic indicator. Best-effort: if the active tab has
// our content script running, show its normal toast.
async function notifyActiveTab(text) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: "SESSION_TOAST", text }, () => void chrome.runtime.lastError);
    }
  } catch (err) {
    // No active tab, or no content script there (e.g. a chrome:// page) -- fine.
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-session") return;
  const session = await toggleSession();
  if (session && session.status === "recording") {
    notifyActiveTab("Slideshot session started — captures will be added as steps");
  } else {
    notifyActiveTab("Slideshot session stopped — open the toolbar popup to export");
  }
});

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

  if (msg && msg.type === "GET_SESSION") {
    getSession().then((session) => sendResponse({ session }));
    return true;
  }

  if (msg && msg.type === "TOGGLE_SESSION") {
    toggleSession().then((session) => sendResponse({ session }));
    return true;
  }

  if (msg && msg.type === "RESET_SESSION") {
    resetSession().then((session) => sendResponse({ session }));
    return true;
  }

  if (msg && msg.type === "SESSION_ADD_STEP") {
    addStepToSession(msg.step).then((session) => sendResponse({ session }));
    return true;
  }

  if (msg && msg.type === "UPDATE_STEP_NARRATION") {
    updateStepNarration(msg.stepId, msg.text).then((session) => sendResponse({ session }));
    return true;
  }

  if (msg && msg.type === "DELETE_STEP") {
    deleteStep(msg.stepId).then((session) => sendResponse({ session }));
    return true;
  }

  if (msg && msg.type === "TRANSCRIPT_CHUNK") {
    handleTranscriptChunk(msg.text, msg.tStart, msg.tEnd);
    return; // fire-and-forget from the offscreen doc, no response needed
  }
});
