// permission.js
// Offscreen documents can't show a permission prompt UI, so this ordinary
// (visible) tab exists solely to let the user grant microphone access once.
// Once granted for the extension's origin, the offscreen document's
// speech-recognition session can use the mic without prompting again.

const statusEl = document.getElementById("hc-status");

navigator.mediaDevices
  .getUserMedia({ audio: true })
  .then((stream) => {
    stream.getTracks().forEach((t) => t.stop());
    statusEl.textContent = "Microphone access granted — you can close this tab.";
  })
  .catch(() => {
    statusEl.textContent = "Microphone access was not granted. Voice narration won't work until it is — reopen this page to try again.";
  });
