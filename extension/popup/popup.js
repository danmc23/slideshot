// popup.js
// Session status/controls, plus the export pipeline: reads the session and
// its stored step images, aligns narration to steps, renders a PDF (one
// page per step, splitting into multiple parts if a part would exceed a
// safe size threshold under Claude's per-file upload limit), and bundles
// everything (PDF part(s) + combined notes.md + raw per-step PNGs) into one
// zip download.

const PDF_SPLIT_TARGET_BYTES = 25 * 1024 * 1024; // stay well under Claude's 30MB/file cap
const MAX_IMG_DIM = 1600;
const JPEG_QUALITY = 0.8;
const POST_STEP_NARRATION_BUFFER_MS = 4000;

let currentSession = null;
let discardArmed = false;

function imgKey(stepId, suffix) {
  return "slideshot_img:" + stepId + (suffix ? ":" + suffix : "");
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// Downscales + re-encodes as JPEG so embedded PDF pages stay well under the
// upload-size limit even for a 15-20+ step session.
function downscaleToJpeg(img) {
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  const longEdge = Math.max(w, h);
  if (longEdge > MAX_IMG_DIM) {
    const scale = MAX_IMG_DIM / longEdge;
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { dataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY), width: w, height: h };
}

// Time-window heuristic: attributes each transcript chunk to the step whose
// [previous step timestamp, this step timestamp + buffer) window it falls
// in. Not semantic alignment -- just proximity in time.
function computeNarrationForSteps(session) {
  return session.steps.map((step, i) => {
    const windowStart = i === 0 ? session.startedAt : session.steps[i - 1].timestamp;
    const nextTs = i + 1 < session.steps.length ? session.steps[i + 1].timestamp : session.endedAt || Date.now();
    const windowEnd = Math.min(step.timestamp + POST_STEP_NARRATION_BUFFER_MS, nextTs);
    const chunks = (session.transcript || []).filter((c) => c.tStart >= windowStart && c.tStart < windowEnd);
    return chunks
      .map((c) => c.text.trim())
      .filter(Boolean)
      .join(" ");
  });
}

async function exportSession(session) {
  setProgress("Preparing export…");
  const narrations = computeNarrationForSteps(session);

  const allKeys = [];
  session.steps.forEach((s) => {
    allKeys.push(imgKey(s.id), imgKey(s.id, "full"));
    (s.dropdowns || []).forEach((d) => allKeys.push(d.key));
  });
  const imageData = await storageGet(allKeys);

  const files = [];
  const notesLines = [
    "# Slideshot session",
    "Recorded " + new Date(session.startedAt).toLocaleString() + " — " + session.steps.length + " step" + (session.steps.length === 1 ? "" : "s"),
    "",
  ];

  let pdfParts = [];
  let builder = createPdfBuilder();

  for (let i = 0; i < session.steps.length; i++) {
    const step = session.steps[i];
    const narration = step.narrationOverride != null && step.narrationOverride !== "" ? step.narrationOverride : narrations[i];
    setProgress("Rendering step " + (i + 1) + " of " + session.steps.length + "…");

    const stepNum = String(i + 1).padStart(2, "0");
    const croppedPng = imageData[imgKey(step.id)];
    const fullPng = imageData[imgKey(step.id, "full")];

    if (croppedPng) files.push({ name: "step-" + stepNum + ".png", data: dataUrlToBytes(croppedPng) });
    if (fullPng) files.push({ name: "step-" + stepNum + "-full.png", data: dataUrlToBytes(fullPng) });
    (step.dropdowns || []).forEach((d) => {
      const raw = imageData[d.key];
      if (raw) files.push({ name: "step-" + stepNum + "-" + d.filename, data: dataUrlToBytes(raw) });
    });

    notesLines.push(
      "## Step " + (i + 1),
      "Page: " + (step.pageTitle || "(none)") + " — " + step.pageUrl,
      "Image: step-" + stepNum + ".png",
      ...(narration ? ["Narration: " + narration] : []),
      "",
      step.notesText || "",
      ""
    );

    if (croppedPng) {
      const img = await loadImage(croppedPng);
      const { dataUrl: jpegUrl, width, height } = downscaleToJpeg(img);
      const jpegBytes = dataUrlToBytes(jpegUrl);

      if (builder.pageCount() > 0 && builder.currentSize() + jpegBytes.length > PDF_SPLIT_TARGET_BYTES) {
        pdfParts.push(builder.finish());
        builder = createPdfBuilder();
      }

      const textBlock =
        "Step " + (i + 1) + (step.pageTitle ? " — " + step.pageTitle : "") + "\n" + (step.notesText || "") + (narration ? "\n\nNarration: " + narration : "");
      builder.addImagePage(jpegBytes, width, height, [textBlock]);
    }
  }
  pdfParts.push(builder.finish());

  if (pdfParts.length > 1) {
    notesLines.splice(
      2,
      0,
      "Exported as " + pdfParts.length + " PDF parts (session-part1.pdf … session-part" + pdfParts.length + ".pdf) — upload all of them to the same Claude Project conversation.",
      ""
    );
  }

  pdfParts.forEach((bytes, i) => {
    const name = pdfParts.length > 1 ? "session-part" + (i + 1) + ".pdf" : "session.pdf";
    files.push({ name, data: bytes });
  });
  files.push({ name: "session-notes.md", data: new TextEncoder().encode(notesLines.join("\n")) });

  setProgress("Building zip…");
  const zipBytes = createZip(files);
  const blob = new Blob([zipBytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const ts = new Date(session.startedAt).toISOString().replace(/[:.]/g, "-");
  chrome.downloads.download({ url, filename: "slideshot-session-" + ts + ".zip", saveAs: false }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
  setProgress("Export complete — " + pdfParts.length + " PDF part" + (pdfParts.length === 1 ? "" : "s") + ", " + files.length + " files total.");
}

function setProgress(text) {
  document.getElementById("hc-progress").textContent = text || "";
}

function render() {
  const statusEl = document.getElementById("hc-status");
  const stepsEl = document.getElementById("hc-steps");
  const toggleBtn = document.getElementById("hc-toggle-btn");
  const discardBtn = document.getElementById("hc-discard-btn");
  const exportBtn = document.getElementById("hc-export-btn");

  if (!currentSession) {
    statusEl.textContent = "No active session.";
    stepsEl.innerHTML = "";
    toggleBtn.textContent = "Start session (Ctrl+Shift+E)";
    discardBtn.disabled = true;
    exportBtn.disabled = true;
    return;
  }

  const recording = currentSession.status === "recording";
  const count = currentSession.steps.length;
  statusEl.textContent = (recording ? "● Recording" : "Stopped") + " — " + count + " step" + (count === 1 ? "" : "s");

  stepsEl.innerHTML = "";
  currentSession.steps.forEach((s, i) => {
    const li = document.createElement("li");
    li.textContent = i + 1 + ". " + (s.pageTitle || s.pageUrl || "(untitled)");
    stepsEl.appendChild(li);
  });

  toggleBtn.textContent = recording ? "Stop session (Ctrl+Shift+E)" : "Start new session";
  discardBtn.disabled = false;
  exportBtn.disabled = recording || count === 0;
}

function refresh() {
  chrome.runtime.sendMessage({ type: "GET_SESSION" }, (resp) => {
    currentSession = (resp && resp.session) || null;
    render();
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "SESSION_STATE") {
    currentSession = msg.session;
    render();
  }
});

document.getElementById("hc-toggle-btn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "TOGGLE_SESSION" }, (resp) => {
    currentSession = (resp && resp.session) || null;
    render();
  });
});

// Popups can't use window.confirm/alert (Chrome disables blocking dialogs
// there), so discard is a two-click arm/confirm instead.
document.getElementById("hc-discard-btn").addEventListener("click", () => {
  const btn = document.getElementById("hc-discard-btn");
  if (!discardArmed) {
    discardArmed = true;
    btn.textContent = "Really discard? Click again";
    setTimeout(() => {
      discardArmed = false;
      btn.textContent = "Discard";
    }, 3000);
    return;
  }
  discardArmed = false;
  btn.textContent = "Discard";
  chrome.runtime.sendMessage({ type: "RESET_SESSION" }, (resp) => {
    currentSession = (resp && resp.session) || null;
    render();
  });
});

document.getElementById("hc-export-btn").addEventListener("click", async () => {
  if (!currentSession || currentSession.steps.length === 0) return;
  const exportBtn = document.getElementById("hc-export-btn");
  exportBtn.disabled = true;
  try {
    await exportSession(currentSession);
  } catch (err) {
    console.error("Slideshot: export failed", err);
    setProgress("Export failed — see console (F12 on this popup) for details.");
  }
  exportBtn.disabled = false;
});

refresh();
