// offscreen.js
// Runs push-to-talk Web Speech API speech-to-text in a hidden offscreen
// document -- the background service worker can't hold a persistent mic
// stream or long-lived recognition session. No raw audio is ever stored;
// only recognized transcript text chunks (with their timestamps) are sent
// on to the background, which aligns them to capture steps at export time.

let recognition = null;
let active = false;
let lastChunkEnd = 0;

function createRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;

  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = false;
  rec.lang = "en-US";

  rec.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result.isFinal) continue;
      const text = result[0].transcript.trim();
      if (!text) continue;
      const tStart = lastChunkEnd || Date.now();
      const tEnd = Date.now();
      lastChunkEnd = tEnd;
      chrome.runtime.sendMessage({ type: "TRANSCRIPT_CHUNK", text, tStart, tEnd });
    }
  };

  // "no-speech" fires routinely on every pause and "aborted" fires whenever
  // we deliberately call .stop() on key-up -- neither is an actual problem,
  // so only genuinely actionable errors (blocked mic, network/firewall,
  // etc.) get surfaced to the user.
  rec.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      active = false;
    }
    if (event.error !== "no-speech" && event.error !== "aborted") {
      chrome.runtime.sendMessage({ type: "STT_ERROR", error: event.error });
    }
  };

  // Web Speech recognition self-terminates after a period of silence (or
  // internal limits); restart it automatically while still held down.
  rec.onend = () => {
    if (!active) return;
    setTimeout(() => {
      if (!active) return;
      try {
        rec.start();
      } catch (err) {
        // Already running -- ignore.
      }
    }, 250);
  };

  return rec;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "START_STT") {
    active = true;
    lastChunkEnd = msg.startedAt || Date.now();
    recognition = createRecognition();
    if (!recognition) {
      chrome.runtime.sendMessage({ type: "STT_ERROR", error: "unsupported" });
      return;
    }
    try {
      recognition.start();
    } catch (err) {
      // ignore
    }
  } else if (msg && msg.type === "STOP_STT") {
    active = false;
    if (recognition) {
      try {
        recognition.stop();
      } catch (err) {
        // ignore
      }
    }
  }
});

// Lets background.js know this document's listener is actually attached
// before it sends the first START_STT -- chrome.offscreen.createDocument()
// resolving doesn't guarantee this script has run yet, and a message sent
// into that gap is silently dropped with no error anywhere.
chrome.runtime.sendMessage({ type: "OFFSCREEN_READY" });
