// content.js
// Hotkey capture tool.
//
// Shift+1         -> enter capture mode; press again while already in capture
//                    mode to open the capture-area selector, confirm it, then
//                    optionally name the capture before it's finalized as
//                    PNG (+ full-page PNG) + .txt
// Shift+G         -> queue a small red-box highlight on the hovered element
// Ctrl+Shift+G    -> queue a jagged-outline "key field" highlight on the hovered element
// Shift+H         -> queue a callout: text box + arrow pointing at the hovered element
// Shift+D         -> flag the hovered (open) dropdown; works even before
//                    Shift+1 (silently enters capture mode if needed, with
//                    zero visual change before the screenshot is taken, so
//                    the dropdown's hover state can't be disturbed first),
//                    captures it separately, then crop just that region out
//                    of the frozen shot
// Escape          -> (while in capture mode, not mid area-select/manual-draw/
//                    dropdown-crop) cancel capture mode entirely -- discards
//                    everything marked so far, produces no output
// Shift+J         -> describe the highlight under the cursor (title + notes)
// Shift+K         -> add a "top-level" overview note for the whole capture
// Shift+N         -> toggle number mode (then press 0-9 over a highlight to tag it)
// Shift+C         -> tag the hovered element as "additional context" (auto-captured, no typing)
// Ctrl+Z          -> undo the last marking action (highlight, context tag, number, description/overview)
//
// Design notes (see README for the full list):
// - Hotkeys are ignored whenever any input/textarea/contenteditable is focused
//   (including this extension's own text panel), so normal typing is never hijacked.
// - "Hovering a highlight" is spatial (cursor inside the element's live bounding box),
//   not exact element identity, and picks the smallest/innermost match if nested.
// - Numbers are single digits (0-9) in this prototype.
// - Context entries auto-associate with any highlight (that has a number or a
//   description) whose bounding box overlaps them -- no manual linking needed.
// - captureVisibleTab only sees the current viewport, so the area selector is
//   bounded to what's on-screen right now, not the full scrollable page.
// - Every highlight's number/context badge is draggable to one of 10 preset
//   anchor points (corners, side-centers, offset-left/right); default anchor
//   tries offset-left first, falling back if that would collide with another
//   highlight.
// - Badges are always drawn in a pass strictly after all highlight shapes
//   are drawn.
// - Repeating the same hotkey on the same element toggles it off (removes the
//   highlight or context tag) instead of creating a duplicate.
// - A callout (Shift+H) requires text before it's created -- cancelling the
//   text prompt discards it rather than leaving an empty marker.

(function () {
  let captureMode = false;
  let numberMode = false;
  let captureName = "";
  let mouseX = 0;
  let mouseY = 0;
  let annotations = []; // { id, type:'small'|'big'|'key', el, number, title, description, numberAnchor, overlayEl, badgeEl }
  let contextEntries = []; // { id, el, label, snippet, overlayEl }
  let topLevelNotes = [];
  let annotationIdCounter = 0;
  let contextIdCounter = 0;
  let historyStack = []; // undo stack; see pushHistory()/undoLastAction()

  let badgeEl = null;
  let toastEl = null;
  let toastTimer = null;
  let repositionScheduled = false;

  // --- area selection state ---
  let selectingArea = false;
  let awaitingFreshDraw = false;
  let activeDrag = null; // { type:'move'|'resize'|'draw', handle?, startMouse, startRect }
  let selectRect = null; // { left, top, width, height } in viewport CSS px
  let selectBoxEl = null;
  let handleEls = [];
  let toolbarEl = null;

  // --- badge drag state ---
  let draggingBadge = null; // annotation currently being repositioned, or null

  // --- text-label / callout arrow drag state ---
  let draggingTextLabel = null; // { annotation, offsetX, offsetY } or null

  // --- dropdown-flag capture state (separate small screenshot of an open
  // dropdown, correlated to a highlight marker on the main capture) ---
  let dropdownCapture = null; // { dataUrl, targetEl, naturalWidth, naturalHeight } while cropping, else null
  let dropdownOverlayEl = null;
  let dropdownDrawStart = null;
  let dropdownDrawBox = null;

  const SNAP_PX = 10;
  const ANCHORS = ["nw", "n", "ne", "e", "se", "s", "sw", "w", "offset-left", "offset-right"];

  const HIGHLIGHT_COLORS = [
    { name: "Red", hex: "#ff3b30" },
    { name: "Neon Green", hex: "#39ff14" },
    { name: "Neon Pink", hex: "#ff6ec7" },
    { name: "Yellow", hex: "#ffff00" },
    { name: "Neon Blue", hex: "#04d9ff" },
    { name: "Neon Purple", hex: "#bf00ff" },
  ];
  const BADGE_COLORS = [
    { name: "Black", hex: "#111111" },
    { name: "Red", hex: "#ff3b30" },
    { name: "Neon Green", hex: "#39ff14" },
    { name: "Neon Pink", hex: "#ff6ec7" },
    { name: "Yellow", hex: "#ffff00" },
    { name: "Neon Blue", hex: "#04d9ff" },
    { name: "Neon Purple", hex: "#bf00ff" },
  ];

  let currentHighlightColor = "#ff3b30";
  let currentBadgeColor = "#111111";
  let safetyStripeActive = false;
  let manualDrawMode = false;
  let manualDrawPending = null; // { type } when waiting for user to draw a manual box
  let freezeActive = false;

  // --- track mouse position so hotkeys know what element to target ---
  document.addEventListener(
    "mousemove",
    (e) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
    },
    true
  );

  window.addEventListener(
    "scroll",
    () => {
      if (!captureMode || repositionScheduled) return;
      repositionScheduled = true;
      requestAnimationFrame(() => {
        repositionAllOverlays();
        repositionScheduled = false;
      });
    },
    true
  );
  window.addEventListener("resize", () => {
    if (captureMode) repositionAllOverlays();
  });

  // --- badge drag (reposition number/context badge to a preset anchor) ---
  document.addEventListener(
    "mousemove",
    (e) => {
      if (!draggingBadge || selectingArea) return;
      const a = draggingBadge;
      if (!a.el || !a.el.isConnected) return;
      const r = a.el.getBoundingClientRect();
      a.numberAnchor = nearestAnchor(r, e.clientX, e.clientY);
      positionBadgeEl(a);
    },
    true
  );
  document.addEventListener(
    "mouseup",
    () => {
      if (!draggingBadge) return;
      if (draggingBadge.badgeEl) {
        draggingBadge.badgeEl.style.cursor = "grab";
        draggingBadge.badgeEl.classList.remove("hc-dragging");
      }
      draggingBadge = null;
    },
    true
  );

  // --- text-label drag (reposition the callout box; the arrow's anchor on
  // the target element snaps to the same 10 preset points badges use) ---
  document.addEventListener(
    "mousemove",
    (e) => {
      if (!draggingTextLabel || selectingArea) return;
      const a = draggingTextLabel.annotation;
      if (!a.el || !a.el.isConnected || !a.textLabel) return;
      a.textLabel.left = e.clientX - draggingTextLabel.offsetX;
      a.textLabel.top = e.clientY - draggingTextLabel.offsetY;
      const r = a.el.getBoundingClientRect();
      a.textLabelAnchor = nearestAnchor(r, e.clientX, e.clientY);
      positionTextLabelEl(a);
    },
    true
  );
  document.addEventListener(
    "mouseup",
    () => {
      if (!draggingTextLabel) return;
      if (draggingTextLabel.annotation.textLabelEl) {
        draggingTextLabel.annotation.textLabelEl.style.cursor = "grab";
        draggingTextLabel.annotation.textLabelEl.classList.remove("hc-dragging");
      }
      draggingTextLabel = null;
    },
    true
  );

  // --- hotkey handling ---
  window.addEventListener("keydown", handleKeydown, true);

  // Session start/stop (Ctrl+Shift+E) is a background-only command with no
  // UI of its own -- this is the only on-page confirmation that it fired.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "SESSION_TOAST") {
      toast(msg.text);
    }
  });

  // =========================================================================
  // On-page session panel: a collapsible floating panel (shown whenever a
  // session exists) with status, the step list, and Start/Stop/Discard plus
  // per-step Delete/Edit-narration. Reads chrome.storage.local directly
  // (content scripts can read it) but routes every write through
  // background.js's message handlers, same as the toolbar popup, so all the
  // side effects (badge, offscreen doc, image-key cleanup) stay centralized.
  // Export itself stays a toolbar-popup action (chrome.downloads isn't
  // reachable from a content script).
  // =========================================================================

  let sessionPanelEl = null;
  let sessionPanelCollapsed = false;
  let currentSessionState = null;
  let sessionDiscardArmed = false;

  function ensureSessionPanel() {
    if (sessionPanelEl) return;
    sessionPanelEl = document.createElement("div");
    sessionPanelEl.id = "hc-session-panel";
    document.body.appendChild(sessionPanelEl);
  }

  function removeSessionPanel() {
    if (sessionPanelEl) {
      sessionPanelEl.remove();
      sessionPanelEl = null;
    }
  }

  function editStepNarration(step) {
    showTextPanel({
      heading: "Edit narration — step",
      hideTitleField: true,
      descValue: step.narrationOverride != null ? step.narrationOverride : "",
      onSave: (_title, desc) => {
        chrome.runtime.sendMessage({ type: "UPDATE_STEP_NARRATION", stepId: step.id, text: desc.trim() }, () => {
          void chrome.runtime.lastError;
        });
      },
    });
  }

  function renderSessionPanel() {
    const session = currentSessionState;
    if (!session) {
      removeSessionPanel();
      return;
    }
    ensureSessionPanel();

    const recording = session.status === "recording";
    const count = session.steps.length;

    sessionPanelEl.innerHTML = "";

    const header = document.createElement("div");
    header.className = "hc-session-header";
    header.innerHTML =
      '<span class="hc-session-title">' +
      (recording ? "● Slideshot session" : "Slideshot session") +
      '</span><span class="hc-session-count">' +
      count +
      " step" +
      (count === 1 ? "" : "s") +
      '</span><span class="hc-session-chevron">' +
      (sessionPanelCollapsed ? "▸" : "▾") +
      "</span>";
    header.addEventListener("click", () => {
      sessionPanelCollapsed = !sessionPanelCollapsed;
      renderSessionPanel();
    });
    sessionPanelEl.appendChild(header);

    if (sessionPanelCollapsed) return;

    const body = document.createElement("div");
    body.className = "hc-session-body";

    const list = document.createElement("ul");
    list.className = "hc-session-steps";
    session.steps.forEach((s, i) => {
      const li = document.createElement("li");

      const label = document.createElement("span");
      label.className = "hc-session-step-label";
      label.textContent = i + 1 + ". " + (s.pageTitle || s.pageUrl || "(untitled)");
      li.appendChild(label);

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "hc-session-step-btn";
      editBtn.textContent = "Narration";
      editBtn.title = "Edit narration text for this step";
      editBtn.addEventListener("click", () => editStepNarration(s));
      li.appendChild(editBtn);

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "hc-session-step-btn hc-session-step-del";
      delBtn.textContent = "✕";
      delBtn.title = "Delete this step";
      delBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "DELETE_STEP", stepId: s.id }, () => {
          void chrome.runtime.lastError;
        });
      });
      li.appendChild(delBtn);

      list.appendChild(li);
    });
    body.appendChild(list);

    const actions = document.createElement("div");
    actions.className = "hc-session-actions";

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.textContent = recording ? "Stop session" : "Start new session";
    toggleBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "TOGGLE_SESSION" }, () => {
        void chrome.runtime.lastError;
      });
    });
    actions.appendChild(toggleBtn);

    const discardBtn = document.createElement("button");
    discardBtn.type = "button";
    discardBtn.className = "hc-session-discard";
    discardBtn.textContent = "Discard";
    discardBtn.addEventListener("click", () => {
      if (!sessionDiscardArmed) {
        sessionDiscardArmed = true;
        discardBtn.textContent = "Click again to confirm";
        setTimeout(() => {
          sessionDiscardArmed = false;
          discardBtn.textContent = "Discard";
        }, 3000);
        return;
      }
      sessionDiscardArmed = false;
      chrome.runtime.sendMessage({ type: "RESET_SESSION" }, () => {
        void chrome.runtime.lastError;
      });
    });
    actions.appendChild(discardBtn);
    body.appendChild(actions);

    const hint = document.createElement("div");
    hint.className = "hc-session-hint";
    hint.textContent = recording ? "Stop the session, then click the toolbar icon to export." : "Click the Slideshot toolbar icon to export.";
    body.appendChild(hint);

    sessionPanelEl.appendChild(body);
  }

  function refreshSessionState() {
    chrome.storage.local.get("slideshot_session", (res) => {
      currentSessionState = res.slideshot_session || null;
      renderSessionPanel();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Object.prototype.hasOwnProperty.call(changes, "slideshot_session")) {
      currentSessionState = changes.slideshot_session.newValue || null;
      renderSessionPanel();
    }
  });

  refreshSessionState();

  function isEditableActive() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function handleKeydown(e) {
    // Never hijack typing -- on the host page, or inside our own text panel.
    if (isEditableActive()) return;

    if (selectingArea) {
      if (e.key === "Enter" || e.key === "y" || e.key === "Y") {
        e.preventDefault();
        e.stopPropagation();
        acceptSelection();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelSelection();
      }
      return; // swallow everything else while selecting an area
    }

    if (manualDrawPending) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelManualDraw();
      }
      return;
    }

    if (dropdownCapture) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelDropdownCropSelect();
        toast("Dropdown capture cancelled");
      }
      return;
    }

    const code = e.code;
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;

    if (ctrl && shift && code === "KeyG") {
      e.preventDefault();
      e.stopPropagation();
      if (captureMode) {
        if (manualDrawMode) beginManualDraw("key");
        else queueAnnotation("key");
      } else toast("Not in capture mode — press Shift+1 first");
      return;
    }

    if (ctrl && !shift && code === "KeyZ") {
      e.preventDefault();
      e.stopPropagation();
      if (captureMode) undoLastAction();
      else toast("Not in capture mode — press Shift+1 first");
      return;
    }

    if (shift && !ctrl && code === "Digit1") {
      e.preventDefault();
      e.stopPropagation();
      if (captureMode) beginAreaSelection();
      else enterCaptureMode();
      return;
    }

    // Dropdown flagging works whether or not capture mode has been entered
    // yet -- entering capture mode first (even silently) risks disturbing
    // the dropdown's hover state before you get a chance to flag it, so
    // this is a standalone action instead of being gated behind captureMode.
    if (shift && !ctrl && code === "KeyD") {
      e.preventDefault();
      e.stopPropagation();
      handleDropdownFlag();
      return;
    }

    if (captureMode && !ctrl && !shift && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancelCaptureMode();
      return;
    }

    if (!captureMode) return;

    if (shift && !ctrl && code === "KeyG") {
      e.preventDefault();
      e.stopPropagation();
      if (manualDrawMode) beginManualDraw("small");
      else queueAnnotation("small");
      return;
    }

    if (shift && !ctrl && code === "KeyH") {
      e.preventDefault();
      e.stopPropagation();
      if (manualDrawMode) beginManualDraw("callout");
      else queueCalloutFlow();
      return;
    }

    if (shift && !ctrl && code === "KeyT") {
      e.preventDefault();
      e.stopPropagation();
      handleTextAnnotation();
      return;
    }

    if (shift && !ctrl && code === "KeyJ") {
      e.preventDefault();
      e.stopPropagation();
      handleDescribeHighlight();
      return;
    }

    if (shift && !ctrl && code === "KeyK") {
      e.preventDefault();
      e.stopPropagation();
      handleOverviewNote();
      return;
    }

    if (shift && !ctrl && code === "KeyN") {
      e.preventDefault();
      e.stopPropagation();
      toggleNumberMode();
      return;
    }

    if (shift && !ctrl && code === "KeyC") {
      e.preventDefault();
      e.stopPropagation();
      addContextEntry();
      return;
    }

    if (numberMode && !ctrl && !shift && /^Digit[0-9]$/.test(code)) {
      e.preventDefault();
      e.stopPropagation();
      assignNumber(parseInt(code.slice(5), 10));
      return;
    }
  }

  // --- capture mode state ---
  // Split so handleDropdownFlag() can enter capture mode silently, deferring
  // every visual side effect (badge/freeze/toast/flash) until after a
  // screenshot is already safely in hand -- entering capture mode should
  // never itself be the thing that disturbs an open dropdown's hover state.
  function resetCaptureState() {
    captureMode = true;
    numberMode = false;
    captureName = "";
    annotations = [];
    contextEntries = [];
    topLevelNotes = [];
    historyStack = [];
  }

  function showCaptureModeEnteredFeedback() {
    showBadge();
    freezePage();
    toast("Capture mode ON");
    lightFlash();
  }

  function enterCaptureMode() {
    resetCaptureState();
    showCaptureModeEnteredFeedback();
  }

  function toggleNumberMode() {
    numberMode = !numberMode;
    updateBadge();
    toast(numberMode ? "Number mode ON — press 0–9 over a highlight" : "Number mode OFF");
  }

  // --- targeting helpers ---
  function findAnnotationAtPoint() {
    let best = null;
    let bestArea = Infinity;
    for (const a of annotations) {
      if (!a.el || !a.el.isConnected) continue;
      const r = a.el.getBoundingClientRect();
      if (mouseX >= r.left && mouseX <= r.right && mouseY >= r.top && mouseY <= r.bottom) {
        const area = r.width * r.height;
        if (area < bestArea) {
          bestArea = area;
          best = a;
        }
      }
    }
    return best;
  }

  function rectsOverlap(a, b) {
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  function annotationHasContext(annotation) {
    if (!(annotation.number != null || annotation.description)) return false;
    if (!annotation.el || !annotation.el.isConnected) return false;
    const r = annotation.el.getBoundingClientRect();
    return contextEntries.some((c) => c.el && c.el.isConnected && rectsOverlap(r, c.el.getBoundingClientRect()));
  }

  function guessTitle(el) {
    if (!el) return "";
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();

    const titleAttr = el.getAttribute && el.getAttribute("title");
    if (titleAttr && titleAttr.trim()) return titleAttr.trim();

    if (el.id) {
      try {
        const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lbl && lbl.textContent.trim()) return lbl.textContent.trim();
      } catch (err) {
        /* ignore invalid selector */
      }
    }

    const cell = el.closest && el.closest("td, th");
    if (cell) {
      const table = cell.closest("table");
      if (table && cell.cellIndex != null) {
        const headerRow = table.querySelector("thead tr") || table.querySelector("tr");
        if (headerRow && headerRow.cells && headerRow.cells[cell.cellIndex]) {
          const headerText = headerRow.cells[cell.cellIndex].textContent.trim();
          if (headerText) return headerText;
        }
      }
    }

    if (el.placeholder && el.placeholder.trim()) return el.placeholder.trim();

    const txt = (el.textContent || "").trim().replace(/\s+/g, " ");
    if (txt && txt.length <= 40) return txt;

    return "";
  }

  // =========================================================================
  // Undo (Ctrl+Z)
  // =========================================================================

  function cloneAnnotationsForHistory() {
    return annotations.map((a) => ({
      id: a.id,
      type: a.type,
      el: a.el,
      number: a.number,
      title: a.title,
      description: a.description,
      numberAnchor: a.numberAnchor || null,
      color: a.color,
      badgeColor: a.badgeColor,
      textLabel: a.textLabel ? { ...a.textLabel } : null,
      textLabelAnchor: a.textLabelAnchor || null,
      dropdownImage: a.dropdownImage || null,
    }));
  }

  function cloneContextForHistory() {
    return contextEntries.map((c) => ({ id: c.id, el: c.el, label: c.label, snippet: c.snippet }));
  }

  function pushHistory() {
    historyStack.push({
      annotations: cloneAnnotationsForHistory(),
      contextEntries: cloneContextForHistory(),
      topLevelNotes: [...topLevelNotes],
    });
    if (historyStack.length > 25) historyStack.shift(); // cap memory use
  }

  function undoLastAction() {
    if (!historyStack.length) {
      toast("Nothing to undo");
      return;
    }
    const prev = historyStack.pop();
    clearAllPersistentOverlays();
    annotations = prev.annotations.map((a) => ({ ...a, overlayEl: null, badgeEl: null, textLabelEl: null }));
    contextEntries = prev.contextEntries.map((c) => ({ ...c, overlayEl: null }));
    topLevelNotes = prev.topLevelNotes;

    annotations.forEach((a) => {
      if (a.el && a.el.isConnected) createPersistentOverlay(a);
      if (a.textLabel) createTextLabelOverlay(a);
    });
    contextEntries.forEach((c) => {
      if (c.el && c.el.isConnected) createPersistentContextOverlay(c);
    });
    updateBadge();
    toast("Undid last action");
  }

  // --- queueing highlights ---
  function queueAnnotation(type) {
    const el = document.elementFromPoint(mouseX, mouseY);
    if (!el) {
      toast("Nothing under the cursor to mark");
      return;
    }
    // Toggle: if the same element already has this type of highlight, remove it.
    const existing = annotations.find((a) => a.el === el && a.type === type);
    if (existing) {
      pushHistory();
      if (existing.overlayEl) existing.overlayEl.remove();
      if (existing.badgeEl) existing.badgeEl.remove();
      annotations = annotations.filter((a) => a !== existing);
      updateBadge();
      const label = type === "small" ? "Small" : "Key field";
      toast(label + " highlight removed");
      return;
    }
    const rect = el.getBoundingClientRect();
    pushHistory();
    const annotation = {
      id: ++annotationIdCounter,
      type,
      el,
      number: null,
      title: guessTitle(el),
      description: "",
      numberAnchor: null,
      color: safetyStripeActive ? "safety" : currentHighlightColor,
      badgeColor: currentBadgeColor,
      textLabel: null, // { text, left, top } or null
      textLabelEl: null,
      overlayEl: null,
      badgeEl: null,
    };
    annotations.push(annotation);
    createPersistentOverlay(annotation);
    flashConfirm(rect, type);
    updateBadge();
    const label = type === "small" ? "Small" : "Key field";
    toast(label + " highlight queued");
  }

  // --- callout: text box + arrow, requires text before it's created ---
  function queueCalloutFlow() {
    const el = document.elementFromPoint(mouseX, mouseY);
    if (!el) {
      toast("Nothing under the cursor to mark");
      return;
    }
    const existing = annotations.find((a) => a.el === el && a.type === "callout");
    if (existing) {
      pushHistory();
      if (existing.overlayEl) existing.overlayEl.remove();
      if (existing.badgeEl) existing.badgeEl.remove();
      if (existing.textLabelEl) existing.textLabelEl.remove();
      annotations = annotations.filter((a) => a !== existing);
      updateBadge();
      toast("Callout removed");
      return;
    }
    createCalloutViaPanel(el, el.getBoundingClientRect());
  }

  function createCalloutViaPanel(el, rect) {
    const annotation = {
      id: ++annotationIdCounter,
      type: "callout",
      el,
      number: null,
      title: guessTitle(el),
      description: "",
      numberAnchor: null,
      color: safetyStripeActive ? "safety" : currentHighlightColor,
      badgeColor: currentBadgeColor,
      textLabel: null,
      textLabelEl: null,
      overlayEl: null,
      badgeEl: null,
    };
    showTextPanel({
      heading: "Callout text",
      hideTitleField: true,
      descValue: "",
      onSave: (_title, desc) => {
        const text = desc.trim();
        if (!text) {
          toast("Callout needs text — highlight not created");
          return;
        }
        pushHistory();
        annotation.textLabel = { text, left: rect.right + 30, top: rect.top - 10 };
        annotation.textLabelAnchor = "e";
        annotations.push(annotation);
        createPersistentOverlay(annotation);
        createTextLabelOverlay(annotation);
        flashConfirm(rect, "callout");
        updateBadge();
        toast("Callout added — drag its box to aim the arrow at a different point");
      },
      onCancel: () => toast("Callout cancelled"),
    });
  }

  // =========================================================================
  // Shift+D: dropdown flag -- native hover dropdowns close the instant the
  // mouse moves toward our own UI, so we screenshot the viewport immediately
  // (before any interaction), then let the user crop just that region out of
  // the already-frozen image rather than the live (possibly-closed) page.
  // =========================================================================

  function handleDropdownFlag() {
    const el = document.elementFromPoint(mouseX, mouseY);
    if (!el) {
      toast("Hover the open dropdown, then press Shift+D");
      return;
    }

    // If capture mode isn't active yet, enter it silently -- no toast/
    // flash/badge until *after* the screenshot is safely captured below,
    // so literally nothing changes on screen before the dropdown is frozen
    // into the image.
    const enteringCaptureMode = !captureMode;
    if (enteringCaptureMode) resetCaptureState();

    try {
      chrome.runtime.sendMessage({ type: "CAPTURE_TAB" }, (resp) => {
        if (enteringCaptureMode) showCaptureModeEnteredFeedback();
        if (chrome.runtime.lastError || !resp || resp.error) {
          const msg = (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "unknown error";
          toast("Dropdown capture failed: " + msg);
          return;
        }
        beginDropdownCropSelect(resp.dataUrl, el);
      });
    } catch (err) {
      if (enteringCaptureMode) showCaptureModeEnteredFeedback();
      console.error("Slideshot: dropdown capture message failed", err);
      toast("Extension connection lost — refresh this page (F5) and try again");
    }
  }

  function beginDropdownCropSelect(dataUrl, targetEl) {
    const img = new Image();
    img.onload = () => {
      dropdownCapture = { dataUrl, targetEl, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
      dropdownOverlayEl = document.createElement("div");
      dropdownOverlayEl.id = "hc-dropdown-overlay";
      const imgEl = document.createElement("img");
      imgEl.id = "hc-dropdown-img";
      imgEl.src = dataUrl;
      dropdownOverlayEl.appendChild(imgEl);
      document.body.appendChild(dropdownOverlayEl);
      document.addEventListener("mousedown", onDropdownDrawDown, true);
      toast("Drag a box around the dropdown, then release • Esc to cancel");
    };
    img.onerror = () => toast("Could not load dropdown capture");
    img.src = dataUrl;
  }

  function onDropdownDrawDown(e) {
    if (!dropdownCapture) return;
    e.preventDefault();
    e.stopPropagation();
    dropdownDrawStart = { x: e.clientX, y: e.clientY };
    dropdownDrawBox = document.createElement("div");
    dropdownDrawBox.className = "hc-manual-draw-box";
    dropdownOverlayEl.appendChild(dropdownDrawBox);
    document.addEventListener("mousemove", onDropdownDrawMove, true);
    document.addEventListener("mouseup", onDropdownDrawUp, true);
  }

  function onDropdownDrawMove(e) {
    if (!dropdownDrawStart || !dropdownDrawBox) return;
    const left = Math.min(dropdownDrawStart.x, e.clientX);
    const top = Math.min(dropdownDrawStart.y, e.clientY);
    const w = Math.abs(e.clientX - dropdownDrawStart.x);
    const h = Math.abs(e.clientY - dropdownDrawStart.y);
    dropdownDrawBox.style.left = left + "px";
    dropdownDrawBox.style.top = top + "px";
    dropdownDrawBox.style.width = w + "px";
    dropdownDrawBox.style.height = h + "px";
  }

  function onDropdownDrawUp(e) {
    document.removeEventListener("mousemove", onDropdownDrawMove, true);
    document.removeEventListener("mouseup", onDropdownDrawUp, true);
    document.removeEventListener("mousedown", onDropdownDrawDown, true);
    if (!dropdownDrawStart || !dropdownCapture) {
      cancelDropdownCropSelect();
      return;
    }
    const left = Math.min(dropdownDrawStart.x, e.clientX);
    const top = Math.min(dropdownDrawStart.y, e.clientY);
    const w = Math.abs(e.clientX - dropdownDrawStart.x);
    const h = Math.abs(e.clientY - dropdownDrawStart.y);
    if (w < 10 || h < 10) {
      toast("Selection too small — dropdown capture cancelled");
      cancelDropdownCropSelect();
      return;
    }
    finishDropdownCrop({ left, top, width: w, height: h });
  }

  function cancelDropdownCropSelect() {
    document.removeEventListener("mousemove", onDropdownDrawMove, true);
    document.removeEventListener("mouseup", onDropdownDrawUp, true);
    document.removeEventListener("mousedown", onDropdownDrawDown, true);
    if (dropdownDrawBox) {
      dropdownDrawBox.remove();
      dropdownDrawBox = null;
    }
    if (dropdownOverlayEl) {
      dropdownOverlayEl.remove();
      dropdownOverlayEl = null;
    }
    dropdownCapture = null;
    dropdownDrawStart = null;
  }

  function finishDropdownCrop(rectViewport) {
    const capture = dropdownCapture;
    const scale = capture.naturalWidth / window.innerWidth;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(rectViewport.width * scale));
      canvas.height = Math.max(1, Math.round(rectViewport.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(
        img,
        rectViewport.left * scale,
        rectViewport.top * scale,
        rectViewport.width * scale,
        rectViewport.height * scale,
        0,
        0,
        canvas.width,
        canvas.height
      );
      // Deliberately no border baked onto the crop itself -- kept as a
      // clean, unmodified image so it can be stitched back together with
      // other captures manually later if needed. The dashed marker on the
      // main capture (below) is the only visual link between the two.

      // Mark the exact area the dropdown occupied (the crop box just drawn)
      // rather than just the small trigger element originally under the
      // cursor -- the trigger might not reflect the expanded menu's extent.
      // Its title is still worth guessing from the original trigger element
      // though, since the manual anchor itself has no attributes to read.
      const anchorEl = createManualAnchor(rectViewport);
      createDropdownAnnotation(anchorEl, canvas.toDataURL("image/png"), guessTitle(capture.targetEl));
      cancelDropdownCropSelect();
      toast("Dropdown capture added");
    };
    img.src = capture.dataUrl;
  }

  function createDropdownAnnotation(el, croppedDataUrl, titleOverride) {
    const rect = el.getBoundingClientRect();
    pushHistory();
    const annotation = {
      id: ++annotationIdCounter,
      type: "dropdown",
      el,
      number: null,
      title: titleOverride || guessTitle(el),
      description: "",
      numberAnchor: null,
      color: safetyStripeActive ? "safety" : currentHighlightColor,
      badgeColor: currentBadgeColor,
      textLabel: null,
      textLabelEl: null,
      overlayEl: null,
      badgeEl: null,
      dropdownImage: croppedDataUrl,
    };
    annotations.push(annotation);
    createPersistentOverlay(annotation);
    flashConfirm(rect, "dropdown");
    updateBadge();
  }

  function assignNumber(n) {
    const annotation = findAnnotationAtPoint();
    if (!annotation) {
      toast("Hover directly over a marked highlight to tag #" + n);
      return;
    }
    pushHistory();
    annotation.number = n;
    updateOverlayBadge(annotation);
    toast("Highlight tagged #" + n);
  }

  function handleDescribeHighlight() {
    const annotation = findAnnotationAtPoint();
    if (!annotation) {
      toast("Hover directly over a marked highlight, then press Shift+J");
      return;
    }
    const guessed = guessTitle(annotation.el);
    showTextPanel({
      heading: "Describe highlight" + (annotation.number != null ? " #" + annotation.number : ""),
      titleValue: annotation.title || guessed,
      descValue: annotation.description,
      onSave: (title, desc) => {
        pushHistory();
        annotation.title = title.trim() || "Untitled";
        annotation.description = desc.trim();
        updateOverlayBadge(annotation);
        toast("Description saved");
      },
    });
  }

  function handleOverviewNote() {
    showTextPanel({
      heading: "Overview note (top-level)",
      hideTitleField: true,
      descValue: "",
      onSave: (_title, desc) => {
        if (desc.trim()) {
          pushHistory();
          topLevelNotes.push(desc.trim());
          toast("Overview note added");
        }
      },
    });
  }

  // --- context mode (Shift+C): auto-captured, no typing ---
  function addContextEntry() {
    const el = document.elementFromPoint(mouseX, mouseY);
    if (!el) {
      toast("Nothing under the cursor to mark as context");
      return;
    }
    // Toggle: if this element already has a context entry, remove it.
    const existingCtx = contextEntries.find((c) => c.el === el);
    if (existingCtx) {
      pushHistory();
      if (existingCtx.overlayEl) existingCtx.overlayEl.remove();
      contextEntries = contextEntries.filter((c) => c !== existingCtx);
      annotations.forEach(updateOverlayBadge);
      toast("Context removed: " + existingCtx.label);
      return;
    }
    const label = guessTitle(el) || el.tagName.toLowerCase();
    const snippet = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 150);
    pushHistory();
    const entry = { id: ++contextIdCounter, el, label, snippet, overlayEl: null };
    contextEntries.push(entry);
    createPersistentContextOverlay(entry);
    flashConfirm(el.getBoundingClientRect(), "context");
    annotations.forEach(updateOverlayBadge); // a new context entry may now overlap an existing numbered/described highlight
    toast("Context noted: " + label);
  }

  // --- capture naming prompt ---
  // Prompted at finish time (after the capture area is confirmed), not at
  // capture-mode entry -- a full-screen prompt shown immediately on entry
  // would drop :hover on whatever was under the cursor (e.g. an open
  // dropdown you wanted to flag with Shift+D) before you got a chance to.
  function promptCaptureName(onDone) {
    showTextPanel({
      heading: "Capture name (optional)",
      titleValue: captureName,
      titlePlaceholder: 'e.g. "PO approval flow"',
      hideDescField: true,
      onSave: (title) => {
        captureName = (title || "").trim();
        if (onDone) onDone();
      },
      onCancel: () => {
        if (onDone) onDone();
      },
    });
  }

  // =========================================================================
  // Shift+T: text annotation with pointer arrow to highlighted element
  // =========================================================================

  function handleTextAnnotation() {
    const annotation = findAnnotationAtPoint();
    if (!annotation) {
      toast("Hover over a marked highlight, then press Shift+T");
      return;
    }
    // Toggle: if already has a text label, remove it
    if (annotation.textLabel) {
      pushHistory();
      if (annotation.textLabelEl) {
        annotation.textLabelEl.remove();
        annotation.textLabelEl = null;
      }
      annotation.textLabel = null;
      toast("Text annotation removed");
      return;
    }
    showTextPanel({
      heading: "Text annotation" + (annotation.number != null ? " for #" + annotation.number : ""),
      hideTitleField: true,
      descValue: "",
      onSave: (_title, desc) => {
        if (!desc.trim()) return;
        pushHistory();
        const r = annotation.el.getBoundingClientRect();
        annotation.textLabel = {
          text: desc.trim(),
          left: r.right + 30,
          top: r.top - 10,
        };
        annotation.textLabelAnchor = "e";
        createTextLabelOverlay(annotation);
        toast("Text annotation added — drag its box to aim the arrow at a different point");
      },
    });
  }

  function createTextLabelOverlay(annotation) {
    if (annotation.textLabelEl) annotation.textLabelEl.remove();
    if (!annotation.textLabel) return;
    const el = document.createElement("div");
    el.className = "hc-text-label";
    el.textContent = annotation.textLabel.text;
    el.style.left = annotation.textLabel.left + "px";
    el.style.top = annotation.textLabel.top + "px";
    document.body.appendChild(el);
    annotation.textLabelEl = el;

    el.addEventListener("mousedown", (e) => {
      if (selectingArea) return;
      e.preventDefault();
      e.stopPropagation();
      draggingTextLabel = {
        annotation,
        offsetX: e.clientX - annotation.textLabel.left,
        offsetY: e.clientY - annotation.textLabel.top,
      };
      el.style.cursor = "grabbing";
      el.classList.add("hc-dragging");
    });
  }

  // Lightweight reposition during a drag -- avoids remove()/recreate on
  // every mousemove the way createTextLabelOverlay does.
  function positionTextLabelEl(annotation) {
    if (!annotation.textLabelEl || !annotation.textLabel) return;
    annotation.textLabelEl.style.left = annotation.textLabel.left + "px";
    annotation.textLabelEl.style.top = annotation.textLabel.top + "px";
  }

  // =========================================================================
  // Manual draw mode: draw a custom rectangle to use as a highlight instead
  // of snapping to a DOM element via elementFromPoint.
  // =========================================================================

  let manualDrawBox = null; // temp preview div during draw
  let manualDrawStart = null; // { x, y }

  function beginManualDraw(type) {
    manualDrawPending = { type };
    toast("Click and drag to draw a " + (type === "key" ? "key field" : type === "callout" ? "callout" : "small") + " highlight box • Esc to cancel");
    document.addEventListener("mousedown", onManualDrawDown, true);
  }

  function cancelManualDraw() {
    manualDrawPending = null;
    manualDrawStart = null;
    if (manualDrawBox) { manualDrawBox.remove(); manualDrawBox = null; }
    document.removeEventListener("mousedown", onManualDrawDown, true);
    document.removeEventListener("mousemove", onManualDrawMove, true);
    document.removeEventListener("mouseup", onManualDrawUp, true);
    toast("Manual draw cancelled");
  }

  function onManualDrawDown(e) {
    if (!manualDrawPending) return;
    if (e.target && isOwnControlElement(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    manualDrawStart = { x: e.clientX, y: e.clientY };
    manualDrawBox = document.createElement("div");
    manualDrawBox.className = "hc-manual-draw-box";
    document.body.appendChild(manualDrawBox);
    document.addEventListener("mousemove", onManualDrawMove, true);
    document.addEventListener("mouseup", onManualDrawUp, true);
  }

  function onManualDrawMove(e) {
    if (!manualDrawStart || !manualDrawBox) return;
    const left = Math.min(manualDrawStart.x, e.clientX);
    const top = Math.min(manualDrawStart.y, e.clientY);
    const w = Math.abs(e.clientX - manualDrawStart.x);
    const h = Math.abs(e.clientY - manualDrawStart.y);
    manualDrawBox.style.left = left + "px";
    manualDrawBox.style.top = top + "px";
    manualDrawBox.style.width = w + "px";
    manualDrawBox.style.height = h + "px";
  }

  function onManualDrawUp(e) {
    document.removeEventListener("mousemove", onManualDrawMove, true);
    document.removeEventListener("mouseup", onManualDrawUp, true);
    document.removeEventListener("mousedown", onManualDrawDown, true);
    if (!manualDrawStart || !manualDrawPending) { cancelManualDraw(); return; }

    const left = Math.min(manualDrawStart.x, e.clientX);
    const top = Math.min(manualDrawStart.y, e.clientY);
    const w = Math.abs(e.clientX - manualDrawStart.x);
    const h = Math.abs(e.clientY - manualDrawStart.y);
    if (manualDrawBox) { manualDrawBox.remove(); manualDrawBox = null; }

    if (w < 10 || h < 10) {
      manualDrawPending = null;
      manualDrawStart = null;
      toast("Box too small — try again");
      return;
    }

    const rect = { left, top, width: w, height: h, right: left + w, bottom: top + h };
    const type = manualDrawPending.type;
    manualDrawPending = null;
    manualDrawStart = null;

    const el = createManualAnchor(rect);

    if (type === "callout") {
      createCalloutViaPanel(el, rect);
      return;
    }

    pushHistory();
    const annotation = {
      id: ++annotationIdCounter,
      type,
      el,
      number: null,
      title: "",
      description: "",
      numberAnchor: null,
      color: safetyStripeActive ? "safety" : currentHighlightColor,
      badgeColor: currentBadgeColor,
      textLabel: null,
      textLabelEl: null,
      overlayEl: null,
      badgeEl: null,
    };
    annotations.push(annotation);
    createPersistentOverlay(annotation);
    flashConfirm(rect, type);
    updateBadge();
    const label = type === "small" ? "Small" : "Key field";
    toast(label + " manual highlight created");
  }

  // =========================================================================
  // Badge anchor system: number/context badges live outside the highlight box
  // at one of 10 preset points, and can be dragged between them.
  // =========================================================================

  function anchorPoint(rect, anchor) {
    switch (anchor) {
      case "nw":
        return { x: rect.left, y: rect.top };
      case "n":
        return { x: rect.left + rect.width / 2, y: rect.top };
      case "ne":
        return { x: rect.left + rect.width, y: rect.top };
      case "e":
        return { x: rect.left + rect.width, y: rect.top + rect.height / 2 };
      case "se":
        return { x: rect.left + rect.width, y: rect.top + rect.height };
      case "s":
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height };
      case "sw":
        return { x: rect.left, y: rect.top + rect.height };
      case "w":
        return { x: rect.left, y: rect.top + rect.height / 2 };
      case "offset-right":
        return { x: rect.left + rect.width + 22, y: rect.top + rect.height / 2 };
      case "offset-left":
      default:
        return { x: rect.left - 22, y: rect.top + rect.height / 2 };
    }
  }

  // Rough footprint used only to guess a non-colliding default anchor before
  // any badge content (number/checkmark/context) actually exists yet.
  function approxBadgeBox(rect, anchor) {
    const w = 46;
    const h = 22;
    const p = anchorPoint(rect, anchor);
    const growRight = p.x >= rect.left + rect.width / 2;
    const left = growRight ? p.x : p.x - w;
    const top = p.y - h / 2;
    return { left, top, right: left + w, bottom: top + h };
  }

  // Default: try the left side of the field first (per request), falling
  // back to the right side, then the original top-right-external spot, if
  // the preferred position would collide with another highlight or run off
  // the edge of the viewport. Cached on the annotation once chosen so it
  // doesn't jump around on every re-render.
  function computeDefaultAnchor(annotation) {
    if (annotation.numberAnchor) return annotation.numberAnchor;
    if (!annotation.el || !annotation.el.isConnected) return "ne";
    const rect = annotation.el.getBoundingClientRect();
    const candidates = ["w", "offset-left", "sw", "nw", "offset-right", "ne"];
    for (const anchor of candidates) {
      const box = approxBadgeBox(rect, anchor);
      const offscreen = box.left < 0 || box.right > window.innerWidth;
      const collides = annotations.some((other) => {
        if (other === annotation || !other.el || !other.el.isConnected) return false;
        return rectsOverlap(box, other.el.getBoundingClientRect());
      });
      if (!offscreen && !collides) {
        annotation.numberAnchor = anchor;
        return anchor;
      }
    }
    annotation.numberAnchor = "ne";
    return "ne";
  }

  function nearestAnchor(rect, mx, my) {
    let best = "ne";
    let bestDist = Infinity;
    ANCHORS.forEach((anchor) => {
      const p = anchorPoint(rect, anchor);
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d < bestDist) {
        bestDist = d;
        best = anchor;
      }
    });
    return best;
  }

  function transformForAnchor(anchor) {
    const top = anchor === "nw" || anchor === "n" || anchor === "ne";
    const bottom = anchor === "sw" || anchor === "s" || anchor === "se";
    const right = anchor === "ne" || anchor === "e" || anchor === "se" || anchor === "offset-right";
    const left = anchor === "nw" || anchor === "w" || anchor === "sw" || anchor === "offset-left";
    const centerX = anchor === "n" || anchor === "s";
    const centerY = anchor === "e" || anchor === "w" || anchor === "offset-left" || anchor === "offset-right";

    let tx = "0";
    if (centerX) tx = "-50%";
    else if (right) tx = "6px";
    else if (left) tx = "calc(-100% - 6px)";

    let ty = "0";
    if (centerY) ty = "-50%";
    else if (top) ty = "calc(-100% - 6px)";
    else if (bottom) ty = "6px";

    return "translate(" + tx + ", " + ty + ")";
  }

  function positionBadgeEl(annotation) {
    if (!annotation.badgeEl || !annotation.el || !annotation.el.isConnected) return;
    const rect = annotation.el.getBoundingClientRect();
    const anchor = annotation.numberAnchor || computeDefaultAnchor(annotation);
    const p = anchorPoint(rect, anchor);
    annotation.badgeEl.style.left = p.x + "px";
    annotation.badgeEl.style.top = p.y + "px";
    annotation.badgeEl.style.transform = transformForAnchor(anchor);
  }

  function createBadgeEl(annotation) {
    const el = document.createElement("div");
    el.className = "hc-persist-badge";
    document.body.appendChild(el);
    annotation.badgeEl = el;
    computeDefaultAnchor(annotation);
    positionBadgeEl(annotation);

    el.addEventListener("mousedown", (e) => {
      if (selectingArea) return;
      e.preventDefault();
      e.stopPropagation();
      draggingBadge = annotation;
      el.style.cursor = "grabbing";
      el.classList.add("hc-dragging");
    });
  }

  // --- persistent muted highlight overlays ---
  function createPersistentOverlay(annotation) {
    const el = document.createElement("div");
    const cls =
      annotation.type === "small" ? "hc-persist-small" : annotation.type === "key" ? "hc-persist-key" : "hc-persist-big";
    el.className = "hc-persist-box " + cls;
    // Apply per-annotation color
    if (annotation.color === "safety") {
      el.style.borderColor = "#ffd700";
      el.style.background = "repeating-linear-gradient(45deg,rgba(255,215,0,0.15),rgba(255,215,0,0.15) 4px,rgba(17,17,17,0.1) 4px,rgba(17,17,17,0.1) 8px)";
      if (annotation.type === "key") el.style.outlineColor = "rgba(255,215,0,0.35)";
    } else if (annotation.color !== "#ff3b30") {
      el.style.borderColor = annotation.color;
      if (annotation.type === "key") el.style.outlineColor = annotation.color;
    }
    document.body.appendChild(el);
    annotation.overlayEl = el;
    positionOverlayFor(annotation.el, el);

    createBadgeEl(annotation);
    updateOverlayBadge(annotation);
  }

  function createPersistentContextOverlay(entry) {
    const el = document.createElement("div");
    el.className = "hc-persist-box hc-persist-context";
    document.body.appendChild(el);
    entry.overlayEl = el;
    positionOverlayFor(entry.el, el);
  }

  function positionOverlayFor(targetEl, overlayEl) {
    if (!targetEl || !targetEl.isConnected || !overlayEl) return;
    const r = targetEl.getBoundingClientRect();
    overlayEl.style.left = r.left + "px";
    overlayEl.style.top = r.top + "px";
    overlayEl.style.width = r.width + "px";
    overlayEl.style.height = r.height + "px";
  }

  function repositionAllOverlays() {
    annotations.forEach((a) => {
      positionOverlayFor(a.el, a.overlayEl);
      positionBadgeEl(a);
    });
    contextEntries.forEach((c) => positionOverlayFor(c.el, c.overlayEl));
  }

  function updateOverlayBadge(annotation) {
    if (!annotation.badgeEl) return;
    const badge = annotation.badgeEl;
    badge.innerHTML = "";
    let any = false;

    if (annotation.number != null) {
      const chip = document.createElement("span");
      chip.className = "hc-badge-chip hc-badge-number";
      chip.textContent = "#" + annotation.number;
      badge.appendChild(chip);
      any = true;
    }
    if (annotation.description) {
      const chip = document.createElement("span");
      chip.className = "hc-badge-chip hc-badge-check";
      chip.textContent = "\u2713";
      badge.appendChild(chip);
      any = true;
    }
    if (annotationHasContext(annotation)) {
      const chip = document.createElement("span");
      chip.className = "hc-badge-chip hc-badge-context";
      chip.textContent = "i";
      badge.appendChild(chip);
      any = true;
    }

    badge.style.display = any ? "flex" : "none";
  }

  function clearAllPersistentOverlays() {
    annotations.forEach((a) => {
      if (a.overlayEl) a.overlayEl.remove();
      if (a.badgeEl) a.badgeEl.remove();
      if (a.textLabelEl) a.textLabelEl.remove();
    });
    contextEntries.forEach((c) => {
      if (c.overlayEl) c.overlayEl.remove();
    });
  }

  // --- brief visual confirmations ---
  function lightFlash() {
    const el = document.createElement("div");
    el.id = "hc-enter-flash";
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add("hc-flash-in"));
    setTimeout(() => el.classList.add("hc-flash-out"), 180);
    setTimeout(() => el.remove(), 600);
  }

  function flashConfirm(rect, type) {
    const box = document.createElement("div");
    const cls =
      type === "small" ? "hc-small" : type === "callout" ? "hc-big" : type === "key" ? "hc-key" : type === "dropdown" ? "hc-key" : "hc-context";
    box.className = "hc-flash-box " + cls;
    box.style.left = rect.x + "px";
    box.style.top = rect.y + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";
    if (type !== "context") {
      const c = safetyStripeActive ? "#ffd700" : currentHighlightColor;
      box.style.borderColor = c;
      if (type === "key") box.style.outlineColor = c.replace(")", ",0.5)").replace("rgb", "rgba");
    }
    document.body.appendChild(box);
    setTimeout(() => box.classList.add("hc-fade"), 450);
    setTimeout(() => box.remove(), 850);
  }

  // --- persistent hotkey legend badge with color selectors ---
  function showBadge() {
    if (!badgeEl) {
      badgeEl = document.createElement("div");
      badgeEl.id = "hc-badge";
      document.body.appendChild(badgeEl);
    }
    buildBadgeStructure();
    updateBadge();
    badgeEl.style.display = "flex";
  }

  function hideBadge() {
    if (badgeEl) badgeEl.style.display = "none";
  }

  // Extended instructions shown on hover over the info icon.
  const EXTENDED_INSTRUCTIONS =
    "HIGHLIGHTS: Shift+G (small), Ctrl+Shift+G (key field / jagged), Shift+H (callout — text box + arrow, requires text)\n" +
    "Shift+D flags an open dropdown -- works even before Shift+1, with no visual change until the screenshot is safely taken, then drag a box to crop just that region into its own file (kept unmodified). A dashed marker on the main capture shows the same area.\n\n" +
    "Escape cancels capture mode entirely with no output (only outside area-select/manual-draw/dropdown-crop, which have their own Escape).\n\n" +
    "DESCRIBE: Hover a highlight then Shift+J for title+notes. Bullets: start with '- ', Tab/Shift+Tab to indent.\n\n" +
    "NUMBERS: Shift+N toggles number mode, then 0-9 over a highlight to tag it. Drag the badge to reposition.\n\n" +
    "TEXT/CALLOUT ARROWS: Drag a callout or text-annotation box to move it and aim its arrow at any of the same 10 anchor points badges use.\n\n" +
    "CONTEXT: Shift+C auto-captures a label+snippet from the hovered element.\n\n" +
    "OVERVIEW: Shift+K for a top-level note not tied to one highlight.\n\n" +
    "TOGGLE OFF: Repeat the same hotkey on the same element to remove it.\n\n" +
    "CAPTURE: Press Shift+1 again (while in capture mode) to open area selection. Drag to draw, handles to resize.\n" +
    "Edges snap to page elements (hold Ctrl to override). Y or Enter to accept.\n\n" +
    "COLORS: Use the left column to change highlight color, right column for badge/number color.\n" +
    "Click the triangle icon for a safety-stripe (yellow/black hazard) highlight mode.\n\n" +
    "OUTPUT: Cropped PNG + full-page PNG + .txt notes file, all sharing one base name.";

  function buildBadgeStructure() {
    badgeEl.innerHTML = "";

    // Main content area (left)
    const main = document.createElement("div");
    main.className = "hc-badge-main";
    badgeEl.appendChild(main);

    // Sidebar (right) — info icon + two color columns
    const sidebar = document.createElement("div");
    sidebar.className = "hc-badge-sidebar";
    badgeEl.appendChild(sidebar);

    // Top row of sidebar: illuminati icon + black square
    const topRow = document.createElement("div");
    topRow.className = "hc-sidebar-top";
    sidebar.appendChild(topRow);

    // Illuminati triangle (info hover + safety stripe toggle)
    const infoIcon = document.createElement("div");
    infoIcon.className = "hc-info-icon" + (safetyStripeActive ? " active" : "");
    infoIcon.innerHTML = safetyStripeActive
      ? '<svg viewBox="0 0 24 24" width="22" height="22"><polygon points="12,2 22,20 2,20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="14" r="2.8" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="12" cy="14" r="1" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" width="22" height="22"><polygon points="12,2 22,20 2,20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><line x1="10" y1="13" x2="14" y2="15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
    infoIcon.title = "";
    topRow.appendChild(infoIcon);

    // Tooltip (shown on hover)
    const tooltip = document.createElement("div");
    tooltip.className = "hc-badge-tooltip";
    tooltip.textContent = EXTENDED_INSTRUCTIONS;
    infoIcon.appendChild(tooltip);

    infoIcon.addEventListener("click", (e) => {
      e.stopPropagation();
      safetyStripeActive = !safetyStripeActive;
      infoIcon.classList.toggle("active", safetyStripeActive);
      infoIcon.innerHTML = safetyStripeActive
        ? '<svg viewBox="0 0 24 24" width="22" height="22"><polygon points="12,2 22,20 2,20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="14" r="2.8" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="12" cy="14" r="1" fill="currentColor"/></svg>'
        : '<svg viewBox="0 0 24 24" width="22" height="22"><polygon points="12,2 22,20 2,20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><line x1="10" y1="13" x2="14" y2="15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
      // Re-attach tooltip
      const tt = document.createElement("div");
      tt.className = "hc-badge-tooltip";
      tt.textContent = EXTENDED_INSTRUCTIONS;
      infoIcon.appendChild(tt);
      toast(safetyStripeActive ? "Safety-stripe highlight mode ON" : "Safety-stripe mode OFF");
    });

    // Manual mode toggle icon (crosshair-style icon)
    const manualIcon = document.createElement("div");
    manualIcon.className = "hc-manual-icon" + (manualDrawMode ? " active" : "");
    manualIcon.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16"><rect x="3" y="3" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="3,2"/><line x1="10" y1="1" x2="10" y2="19" stroke="currentColor" stroke-width="0.8"/><line x1="1" y1="10" x2="19" y2="10" stroke="currentColor" stroke-width="0.8"/></svg>';
    manualIcon.title = "Manual draw mode";
    topRow.appendChild(manualIcon);

    manualIcon.addEventListener("click", (e) => {
      e.stopPropagation();
      manualDrawMode = !manualDrawMode;
      manualIcon.classList.toggle("active", manualDrawMode);
      toast(manualDrawMode ? "Manual draw mode ON — draw your own highlight boxes" : "Manual draw mode OFF");
    });

    // Color columns container
    const colsWrap = document.createElement("div");
    colsWrap.className = "hc-color-cols";
    sidebar.appendChild(colsWrap);

    // Left column: highlight colors
    const hlCol = document.createElement("div");
    hlCol.className = "hc-color-col";
    HIGHLIGHT_COLORS.forEach((c) => {
      const dot = document.createElement("div");
      dot.className = "hc-color-dot" + (currentHighlightColor === c.hex && !safetyStripeActive ? " active" : "");
      dot.style.background = c.hex;
      dot.title = c.name + " highlight";
      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        currentHighlightColor = c.hex;
        safetyStripeActive = false;
        infoIcon.classList.remove("active");
        refreshColorSelectors();
        toast("Highlight color: " + c.name);
      });
      hlCol.appendChild(dot);
    });
    colsWrap.appendChild(hlCol);

    // Right column: badge colors (black at top)
    const bgCol = document.createElement("div");
    bgCol.className = "hc-color-col";
    BADGE_COLORS.forEach((c) => {
      const dot = document.createElement("div");
      dot.className = "hc-color-dot" + (currentBadgeColor === c.hex ? " active" : "");
      dot.style.background = c.hex;
      if (c.hex === "#111111") dot.style.border = "1.5px solid #555";
      dot.title = c.name + " badges";
      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        currentBadgeColor = c.hex;
        refreshColorSelectors();
        toast("Badge color: " + c.name);
      });
      bgCol.appendChild(dot);
    });
    colsWrap.appendChild(bgCol);

    // Default settings link at bottom of main
    const defaults = document.createElement("div");
    defaults.className = "hc-badge-defaults";
    defaults.textContent = "default settings";
    defaults.addEventListener("click", (e) => {
      e.stopPropagation();
      resetToDefaults();
    });
    main.appendChild(defaults); // will be repositioned after list by updateBadge
  }

  function refreshColorSelectors() {
    if (!badgeEl) return;
    const hlDots = badgeEl.querySelectorAll(".hc-color-col:first-child .hc-color-dot");
    hlDots.forEach((dot, i) => {
      dot.classList.toggle("active", HIGHLIGHT_COLORS[i] && currentHighlightColor === HIGHLIGHT_COLORS[i].hex && !safetyStripeActive);
    });
    const bgDots = badgeEl.querySelectorAll(".hc-color-col:last-child .hc-color-dot");
    bgDots.forEach((dot, i) => {
      dot.classList.toggle("active", BADGE_COLORS[i] && currentBadgeColor === BADGE_COLORS[i].hex);
    });
    const icon = badgeEl.querySelector(".hc-info-icon");
    if (icon) icon.classList.toggle("active", safetyStripeActive);
  }

  function resetToDefaults() {
    currentHighlightColor = "#ff3b30";
    currentBadgeColor = "#111111";
    safetyStripeActive = false;
    manualDrawMode = false;
    refreshColorSelectors();
    const mi = badgeEl && badgeEl.querySelector(".hc-manual-icon");
    if (mi) mi.classList.remove("active");
    toast("Colors reset to defaults");
  }

  function updateBadge() {
    if (!badgeEl) return;
    const main = badgeEl.querySelector(".hc-badge-main");
    if (!main) return;

    // Preserve the defaults link
    const defaultsEl = main.querySelector(".hc-badge-defaults");

    const count = annotations.length;
    const statusLine =
      "\u25CF Capture mode" +
      (captureName ? " — " + captureName : "") +
      " • " +
      count +
      (count === 1 ? " highlight" : " highlights") +
      " queued" +
      (numberMode ? " • Number mode ON" : "");

    const rows = numberMode
      ? [
          ["0–9", "tag the hovered highlight"],
          ["Shift+N", "exit number mode"],
        ]
      : [
          ["Shift+G", "small highlight"],
          ["Ctrl+Shift+G", "key field highlight"],
          ["Shift+H", "callout (text + arrow)"],
          ["Shift+D", "dropdown flag (separate capture)"],
          ["Shift+J", "describe highlight"],
          ["Shift+K", "overview note"],
          ["Shift+N", "number mode"],
          ["Shift+C", "context tag"],
          ["Shift+T", "text annotation"],
          ["Ctrl+Z", "undo last action"],
          ["Shift+1", "finish & capture"],
          ["Escape", "cancel — no output"],
        ];

    // Clear main but keep defaults link
    main.innerHTML = "";

    const statusEl = document.createElement("div");
    statusEl.className = "hc-badge-status";
    statusEl.textContent = statusLine;
    main.appendChild(statusEl);

    const list = document.createElement("div");
    list.className = "hc-badge-list";
    rows.forEach(([key, desc]) => {
      const row = document.createElement("div");
      row.className = "hc-badge-row";
      const keyEl = document.createElement("span");
      keyEl.className = "hc-badge-key";
      keyEl.textContent = key;
      const descEl = document.createElement("span");
      descEl.className = "hc-badge-desc";
      descEl.textContent = desc;
      row.appendChild(keyEl);
      row.appendChild(descEl);
      list.appendChild(row);
    });
    main.appendChild(list);

    if (defaultsEl) main.appendChild(defaultsEl);
    else {
      const d = document.createElement("div");
      d.className = "hc-badge-defaults";
      d.textContent = "default settings";
      d.addEventListener("click", (e) => { e.stopPropagation(); resetToDefaults(); });
      main.appendChild(d);
    }
  }

  // --- hide our own UI right before the real pixel capture, so none of it
  // (legend, muted highlight overlays, badges, toast) ends up baked into the screenshot ---
  function setOverlaysVisible(visible) {
    const v = visible ? "visible" : "hidden";
    if (badgeEl) badgeEl.style.visibility = v;
    if (!visible && toastEl) toastEl.style.visibility = "hidden";
    // toastEl visibility is reset by toast() itself the next time it's called,
    // so we only hide it, never explicitly restore it.
    annotations.forEach((a) => {
      if (a.overlayEl) a.overlayEl.style.visibility = v;
      if (a.badgeEl) a.badgeEl.style.visibility = v;
      if (a.textLabelEl) a.textLabelEl.style.visibility = v;
    });
    contextEntries.forEach((c) => {
      if (c.overlayEl) c.overlayEl.style.visibility = v;
    });
  }

  // --- freeze page during capture mode: block clicks on the underlying page ---
  function onFreezeBlock(e) {
    if (selectingArea || manualDrawPending || dropdownCapture) return;
    if (e.target && isOwnControlElement(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function freezePage() {
    if (freezeActive) return;
    freezeActive = true;
    ["click", "mousedown", "pointerdown", "dblclick", "submit"].forEach((evt) =>
      document.addEventListener(evt, onFreezeBlock, true)
    );
  }

  function unfreezePage() {
    if (!freezeActive) return;
    freezeActive = false;
    ["click", "mousedown", "pointerdown", "dblclick", "submit"].forEach((evt) =>
      document.removeEventListener(evt, onFreezeBlock, true)
    );
  }

  // Create a fixed-position anchor element for manual-mode highlights (no
  // real DOM element to reference). Returns a div that behaves like a page
  // element for getBoundingClientRect purposes.
  function createManualAnchor(rect) {
    const el = document.createElement("div");
    el.className = "hc-manual-anchor";
    el.style.cssText =
      "position:fixed;pointer-events:none;left:" + rect.left + "px;top:" + rect.top + "px;width:" + rect.width + "px;height:" + rect.height + "px;";
    document.body.appendChild(el);
    return el;
  }

  // --- transient toast ---
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "hc-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.style.visibility = "visible";
    toastEl.textContent = msg;
    toastEl.classList.add("hc-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("hc-show"), 1600);
  }

  // --- text entry panel (Shift+J, Shift+K, capture naming) ---
  function showTextPanel({ heading, titleValue, descValue, hideTitleField, hideDescField, titlePlaceholder, onSave, onCancel }) {
    const existing = document.getElementById("hc-panel-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "hc-panel-overlay";

    const panel = document.createElement("div");
    panel.id = "hc-panel";

    const headingEl = document.createElement("div");
    headingEl.className = "hc-panel-heading";
    headingEl.textContent = heading;
    panel.appendChild(headingEl);

    let titleInput = null;
    if (!hideTitleField) {
      titleInput = document.createElement("input");
      titleInput.type = "text";
      titleInput.className = "hc-panel-title";
      titleInput.placeholder = titlePlaceholder || "Title";
      titleInput.value = titleValue || "";
      panel.appendChild(titleInput);
    }

    let descInput = null;
    if (!hideDescField) {
      descInput = document.createElement("textarea");
      descInput.className = "hc-panel-desc";
      descInput.placeholder = 'Description / notes — start a line with "- " for a bullet, Tab to indent';
      descInput.rows = 5;
      descInput.value = descValue || "";
      panel.appendChild(descInput);
    }

    const actions = document.createElement("div");
    actions.className = "hc-panel-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "hc-panel-cancel";
    cancelBtn.textContent = "Cancel";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "hc-panel-save";
    saveBtn.textContent = "Save";
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    panel.appendChild(actions);

    const hint = document.createElement("div");
    hint.className = "hc-panel-hint";
    hint.textContent = descInput
      ? "Ctrl+Enter to save • Esc to cancel • Tab/Shift+Tab indents bullets"
      : "Enter/Ctrl+Enter to save • Esc to cancel";
    panel.appendChild(hint);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    let saved = false;
    const closePanel = () => {
      overlay.remove();
      if (!saved && onCancel) onCancel();
    };
    const doSave = () => {
      saved = true;
      onSave(titleInput ? titleInput.value : "", descInput ? descInput.value : "");
      closePanel();
    };

    saveBtn.addEventListener("click", doSave);
    cancelBtn.addEventListener("click", closePanel);
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) closePanel();
    });

    panel.addEventListener(
      "keydown",
      (e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          closePanel();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          doSave();
        } else if (e.key === "Enter" && titleInput && e.target === titleInput) {
          e.preventDefault();
          doSave();
        } else if (e.key === "Tab" && descInput && e.target === descInput) {
          e.preventDefault();
          if (e.shiftKey) outdentCurrentLine(descInput);
          else indentCurrentLine(descInput);
        }
      },
      true
    );

    (titleInput || descInput).focus();
  }

  // Tab/Shift+Tab within the notes textarea indents/outdents the current
  // line by 2 spaces, so simple "- " bullets can be nested into a hierarchy
  // without Tab jumping focus out of the field.
  function indentCurrentLine(textarea) {
    const val = textarea.value;
    const pos = textarea.selectionStart;
    const lineStart = val.lastIndexOf("\n", pos - 1) + 1;
    textarea.value = val.slice(0, lineStart) + "  " + val.slice(lineStart);
    const newPos = pos + 2;
    textarea.selectionStart = textarea.selectionEnd = newPos;
  }

  function outdentCurrentLine(textarea) {
    const val = textarea.value;
    const pos = textarea.selectionStart;
    const lineStart = val.lastIndexOf("\n", pos - 1) + 1;
    let removeCount = 0;
    if (val.slice(lineStart, lineStart + 2) === "  ") removeCount = 2;
    else if (val[lineStart] === " ") removeCount = 1;
    if (removeCount) {
      textarea.value = val.slice(0, lineStart) + val.slice(lineStart + removeCount);
      textarea.selectionStart = textarea.selectionEnd = Math.max(lineStart, pos - removeCount);
    }
  }

  // --- lightweight page context (no OCR, just structural DOM facts) ---
  function getPageContext() {
    const ctx = { title: "", url: "", heading: "", breadcrumb: "", description: "" };
    ctx.title = (document.title || "").trim().slice(0, 200);
    ctx.url = window.location.href;

    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) ctx.description = (metaDesc.getAttribute("content") || "").trim().slice(0, 300);

    const h1 = document.querySelector("h1");
    if (h1 && h1.textContent.trim()) {
      ctx.heading = h1.textContent.trim().replace(/\s+/g, " ").slice(0, 150);
    } else {
      const h2 = document.querySelector("h2");
      if (h2 && h2.textContent.trim()) ctx.heading = h2.textContent.trim().replace(/\s+/g, " ").slice(0, 150);
    }

    const bcEl = document.querySelector(
      '[aria-label*="breadcrumb" i], nav.breadcrumb, .breadcrumb, [class*="breadcrumb" i]'
    );
    if (bcEl && bcEl.textContent.trim()) {
      ctx.breadcrumb = bcEl.textContent.trim().replace(/\s+/g, " ").slice(0, 200);
    }

    return ctx;
  }

  // =========================================================================
  // Capture-area selection: draw your own rectangle, then resize handles for
  // fine adjustment. Edges snap to nearby UI elements (preferring the snap
  // that makes the box larger); hold Ctrl/Cmd while dragging to disable
  // snapping. (No pre-identified landmark regions -- removed for simplicity.)
  // =========================================================================

  // Is this element part of our own selection/overlay UI? Used to avoid
  // snapping to (or being blocked by) our own controls.
  function isOwnControlElement(el) {
    return !!(
      el.closest &&
      el.closest(
        "#hc-select-box, .hc-handle, #hc-select-toolbar, #hc-badge, .hc-toast, #hc-panel-overlay, #hc-enter-flash, .hc-flash-box, .hc-persist-box, .hc-persist-badge, .hc-text-label, .hc-manual-draw-box, .hc-manual-anchor, #hc-session-panel"
      )
    );
  }

  function getSnapRectUnderPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || isOwnControlElement(el)) return null;
    return el.getBoundingClientRect();
  }

  // Snaps `moving` to whichever of lo/hi is within threshold AND farther
  // from `anchor` (i.e. prefers the snap that makes the box larger).
  function snapAxis(anchor, moving, lo, hi, threshold) {
    const candidates = [];
    if (Math.abs(moving - lo) <= threshold) candidates.push(lo);
    if (Math.abs(moving - hi) <= threshold) candidates.push(hi);
    if (!candidates.length) return moving;
    candidates.sort((a, b) => Math.abs(b - anchor) - Math.abs(a - anchor));
    return candidates[0];
  }

  function beginAreaSelection() {
    selectingArea = true;
    awaitingFreshDraw = true; // always start ready to draw
    selectRect = null;

    createToolbar();
    updateToolbarState();

    document.addEventListener("mousedown", onAreaMouseDown, true);
    document.addEventListener("mousemove", onAreaMouseMove, true);
    document.addEventListener("mouseup", onAreaMouseUp, true);
  }

  function ensureSelectBoxExists() {
    if (selectBoxEl) return;
    selectBoxEl = document.createElement("div");
    selectBoxEl.id = "hc-select-box";
    document.body.appendChild(selectBoxEl);

    const handleDefs = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
    handleEls = handleDefs.map((key) => {
      const h = document.createElement("div");
      h.className = "hc-handle";
      h.dataset.handle = key;
      h.style.cursor =
        key === "nw" || key === "se" ? "nwse-resize" : key === "ne" || key === "sw" ? "nesw-resize" : key === "n" || key === "s" ? "ns-resize" : "ew-resize";
      document.body.appendChild(h);
      return h;
    });
  }

  function createToolbar() {
    toolbarEl = document.createElement("div");
    toolbarEl.id = "hc-select-toolbar";
    toolbarEl.innerHTML =
      '<button type="button" class="hc-accept-btn">Accept area</button>' +
      '<button type="button" class="hc-startover-btn">Start over</button>' +
      '<span class="hc-select-hint"></span>';
    document.body.appendChild(toolbarEl);
    toolbarEl.querySelector(".hc-accept-btn").addEventListener("click", acceptSelection);
    toolbarEl.querySelector(".hc-startover-btn").addEventListener("click", handleStartOver);
  }

  function updateToolbarState() {
    if (!toolbarEl) return;
    const hasRect = !!selectRect;
    toolbarEl.querySelector(".hc-accept-btn").style.display = hasRect ? "inline-block" : "none";
    toolbarEl.querySelector(".hc-startover-btn").style.display = hasRect ? "inline-block" : "none";
    toolbarEl.querySelector(".hc-select-hint").textContent = hasRect
      ? "Drag handles to resize • Y/Enter to accept • Esc to cancel"
      : "Drag to draw the capture area • Esc to cancel";
    // Position toolbar near the bottom of the selection rect instead of bottom of viewport
    if (hasRect) {
      const below = selectRect.top + selectRect.height + 16;
      const above = selectRect.top - 52;
      const y = below + 50 < window.innerHeight ? below : above > 0 ? above : window.innerHeight - 52;
      toolbarEl.style.bottom = "auto";
      toolbarEl.style.top = y + "px";
    } else {
      toolbarEl.style.top = "auto";
      toolbarEl.style.bottom = "20px";
    }
  }

  function handlePoint(key, r) {
    switch (key) {
      case "nw":
        return { left: r.left, top: r.top };
      case "n":
        return { left: r.left + r.width / 2, top: r.top };
      case "ne":
        return { left: r.left + r.width, top: r.top };
      case "e":
        return { left: r.left + r.width, top: r.top + r.height / 2 };
      case "se":
        return { left: r.left + r.width, top: r.top + r.height };
      case "s":
        return { left: r.left + r.width / 2, top: r.top + r.height };
      case "sw":
        return { left: r.left, top: r.top + r.height };
      case "w":
      default:
        return { left: r.left, top: r.top + r.height / 2 };
    }
  }

  function updateSelectBoxDom() {
    if (!selectRect) return;
    ensureSelectBoxExists();
    selectBoxEl.style.left = selectRect.left + "px";
    selectBoxEl.style.top = selectRect.top + "px";
    selectBoxEl.style.width = selectRect.width + "px";
    selectBoxEl.style.height = selectRect.height + "px";
    handleEls.forEach((h) => {
      const p = handlePoint(h.dataset.handle, selectRect);
      h.style.left = p.left + "px";
      h.style.top = p.top + "px";
    });
  }

  function onAreaMouseDown(e) {
    if (!selectingArea) return;
    const target = e.target;

    if (target.closest && target.closest("#hc-select-toolbar")) return; // let toolbar buttons work

    if (target.classList && target.classList.contains("hc-handle")) {
      e.preventDefault();
      e.stopPropagation();
      activeDrag = { type: "resize", handle: target.dataset.handle, startMouse: { x: e.clientX, y: e.clientY }, startRect: { ...selectRect } };
      return;
    }

    if (target.id === "hc-select-box") {
      e.preventDefault();
      e.stopPropagation();
      activeDrag = { type: "move", startMouse: { x: e.clientX, y: e.clientY }, startRect: { ...selectRect } };
      return;
    }

    if (awaitingFreshDraw) {
      e.preventDefault();
      e.stopPropagation();
      activeDrag = { type: "draw", startMouse: { x: e.clientX, y: e.clientY }, fallbackRect: selectRect ? { ...selectRect } : null };
      return;
    }

    // Block accidental interaction with the underlying page while selecting.
    e.preventDefault();
    e.stopPropagation();
  }

  function onAreaMouseMove(e) {
    if (!activeDrag) return;
    const ctrlHeld = e.ctrlKey || e.metaKey;
    const snapRect = ctrlHeld ? null : getSnapRectUnderPoint(e.clientX, e.clientY);
    const dx = e.clientX - activeDrag.startMouse.x;
    const dy = e.clientY - activeDrag.startMouse.y;
    const minSize = 20;

    if (activeDrag.type === "move") {
      const r = activeDrag.startRect;
      selectRect.left = Math.max(0, Math.min(window.innerWidth - r.width, r.left + dx));
      selectRect.top = Math.max(0, Math.min(window.innerHeight - r.height, r.top + dy));
    } else if (activeDrag.type === "resize") {
      const r = activeDrag.startRect;
      let left = r.left,
        top = r.top,
        right = r.left + r.width,
        bottom = r.top + r.height;
      const h = activeDrag.handle;
      if (h.includes("n")) top = Math.min(bottom - minSize, r.top + dy);
      if (h.includes("s")) bottom = Math.max(top + minSize, r.top + r.height + dy);
      if (h.includes("w")) left = Math.min(right - minSize, r.left + dx);
      if (h.includes("e")) right = Math.max(left + minSize, r.left + r.width + dx);

      if (snapRect) {
        if (h.includes("n")) top = snapAxis(bottom, top, snapRect.top, snapRect.bottom, SNAP_PX);
        if (h.includes("s")) bottom = snapAxis(top, bottom, snapRect.top, snapRect.bottom, SNAP_PX);
        if (h.includes("w")) left = snapAxis(right, left, snapRect.left, snapRect.right, SNAP_PX);
        if (h.includes("e")) right = snapAxis(left, right, snapRect.left, snapRect.right, SNAP_PX);
      }

      left = Math.max(0, left);
      top = Math.max(0, top);
      right = Math.min(window.innerWidth, right);
      bottom = Math.min(window.innerHeight, bottom);
      selectRect = { left, top, width: right - left, height: bottom - top };
    } else if (activeDrag.type === "draw") {
      const x1 = activeDrag.startMouse.x,
        y1 = activeDrag.startMouse.y;
      let x2 = e.clientX,
        y2 = e.clientY;
      if (snapRect) {
        x2 = snapAxis(x1, x2, snapRect.left, snapRect.right, SNAP_PX);
        y2 = snapAxis(y1, y2, snapRect.top, snapRect.bottom, SNAP_PX);
      }
      selectRect = {
        left: Math.max(0, Math.min(x1, x2)),
        top: Math.max(0, Math.min(y1, y2)),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      };
    }
    updateSelectBoxDom();
  }

  function onAreaMouseUp() {
    if (!activeDrag) return;
    if (activeDrag.type === "draw") {
      if (!selectRect || selectRect.width < 20 || selectRect.height < 20) {
        if (activeDrag.fallbackRect) {
          selectRect = activeDrag.fallbackRect;
          toast("Area too small — kept previous selection");
        } else {
          selectRect = null;
          if (selectBoxEl) {
            selectBoxEl.remove();
            selectBoxEl = null;
          }
          handleEls.forEach((h) => h.remove());
          handleEls = [];
          toast("Area too small — try dragging a bigger box");
        }
      }
      awaitingFreshDraw = !selectRect;
      updateSelectBoxDom();
      updateToolbarState();
    }
    activeDrag = null;
  }

  function handleStartOver() {
    if (selectBoxEl) {
      selectBoxEl.remove();
      selectBoxEl = null;
    }
    handleEls.forEach((h) => h.remove());
    handleEls = [];
    selectRect = null;
    awaitingFreshDraw = true;
    updateToolbarState();
    toast("Drag anywhere on the page to draw a new area");
  }

  function endAreaSelection() {
    selectingArea = false;
    awaitingFreshDraw = false;
    activeDrag = null;
    document.removeEventListener("mousedown", onAreaMouseDown, true);
    document.removeEventListener("mousemove", onAreaMouseMove, true);
    document.removeEventListener("mouseup", onAreaMouseUp, true);
    if (selectBoxEl) {
      selectBoxEl.remove();
      selectBoxEl = null;
    }
    handleEls.forEach((h) => h.remove());
    handleEls = [];
    if (toolbarEl) {
      toolbarEl.remove();
      toolbarEl = null;
    }
  }

  function cancelSelection() {
    endAreaSelection();
    toast("Area selection cancelled — press Shift+1 to try again");
  }

  function acceptSelection() {
    if (!selectRect) {
      toast("Draw an area first");
      return;
    }
    const finalRect = { ...selectRect };
    endAreaSelection();
    promptCaptureName(() => proceedToCapture(finalRect));
  }

  function proceedToCapture(finalRect) {
    toast("Capturing…");
    setOverlaysVisible(false);

    // Give the browser two frames to actually repaint without our overlays
    // before grabbing pixels, so nothing of ours ends up baked into the shot.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          chrome.runtime.sendMessage({ type: "CAPTURE_TAB" }, (resp) => {
            setOverlaysVisible(true);
            if (chrome.runtime.lastError) {
              toast("Capture failed: " + chrome.runtime.lastError.message + " — try refreshing this page");
              return;
            }
            if (!resp || resp.error) {
              toast("Capture failed: " + (resp && resp.error ? resp.error : "unknown error"));
              return;
            }
            try {
              composeAndDownload(resp.dataUrl, finalRect);
            } catch (err) {
              console.error("Slideshot: composeAndDownload failed", err);
              toast("Something went wrong composing the screenshot — see console (F12) for details");
            }
          });
        } catch (err) {
          setOverlaysVisible(true);
          console.error("Slideshot: sendMessage failed", err);
          toast("Extension connection lost — refresh this page (F5) and try again");
        }
      });
    });
  }

  // --- screenshot + compose ---
  function composeAndDownload(dataUrl, cropRectViewport) {
    const pageContext = getPageContext(); // captured at the same moment as the screenshot

    const img = new Image();
    img.onload = () => {
      try {
        composeAndDownloadInner(img, cropRectViewport, pageContext);
      } catch (err) {
        console.error("Slideshot: failed while composing the screenshot", err);
        toast("Something went wrong composing the screenshot — see console (F12) for details");
      }
    };
    img.onerror = () => toast("Could not load captured image");
    img.src = dataUrl;
  }

  // Renders one fully-annotated canvas from the raw screenshot. Shapes are
  // drawn in a first pass; badges in a second pass. Zoom-callout magnified
  // crops are taken directly from `img` (the original screenshot), not from
  // the canvas being drawn on, so neither other highlights' outlines nor
  // badges can leak into the magnified copy.
  function renderAnnotatedCanvas(img, scale, striped) {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    const geometry = [];
    annotations.forEach((a) => {
      if (!a.el || !a.el.isConnected) return;
      const r = a.el.getBoundingClientRect();
      const sx = r.left * scale;
      const sy = r.top * scale;
      const sw = Math.max(2, r.width * scale);
      const sh = Math.max(2, r.height * scale);
      const hlColor = a.color || "#ff3b30";

      if (hlColor === "safety") {
        drawSafetyStripeHighlight(ctx, sx, sy, sw, sh, scale);
      } else if (a.type === "small") {
        drawSmallHighlight(ctx, sx, sy, sw, sh, scale, hlColor);
      } else if (a.type === "key") {
        drawKeyFieldHighlight(ctx, sx, sy, sw, sh, scale, hlColor);
      } else if (a.type === "dropdown") {
        drawDropdownFlagHighlight(ctx, sx, sy, sw, sh, scale, hlColor);
      } else if (striped) {
        drawStripedRect(ctx, sx, sy, sw, sh, scale, hlColor);
      } else {
        drawDashedRect(ctx, sx, sy, sw, sh, scale, hlColor);
      }
      geometry.push({ a, r });
    });

    geometry.forEach(({ a, r }) => {
      const items = [];
      const bc = a.badgeColor || "#111111";
      if (a.number != null) items.push({ type: "number", text: String(a.number) });
      if (annotationHasContext(a)) items.push({ type: "context", text: "i" });
      if (items.length) {
        const anchor = a.numberAnchor || computeDefaultAnchor(a);
        drawBadgesAtAnchor(ctx, r, anchor, scale, items, bc);
      }
      // Text annotation with pointer arrow
      if (a.textLabel) {
        drawTextLabel(ctx, r, a.textLabel, scale, a.color === "safety" ? "#ffd700" : (a.color || "#ff3b30"), a.textLabelAnchor);
      }
    });

    return canvas;
  }

  function composeAndDownloadInner(img, cropRectViewport, pageContext) {
    const scale = img.naturalWidth / window.innerWidth;

    // Primary, cropped output -- normal (dashed) zoom-highlight styling.
    const croppedSource = renderAnnotatedCanvas(img, scale, false);
    let cropX = Math.max(0, cropRectViewport.left * scale);
    let cropY = Math.max(0, cropRectViewport.top * scale);
    let cropW = Math.min(croppedSource.width - cropX, cropRectViewport.width * scale);
    let cropH = Math.min(croppedSource.height - cropY, cropRectViewport.height * scale);

    if (!(cropW > 0) || !(cropH > 0) || !isFinite(cropW) || !isFinite(cropH)) {
      cropX = 0;
      cropY = 0;
      cropW = croppedSource.width;
      cropH = croppedSource.height;
    }

    const outCanvas = document.createElement("canvas");
    outCanvas.width = Math.max(1, Math.round(cropW));
    outCanvas.height = Math.max(1, Math.round(cropH));
    outCanvas.getContext("2d").drawImage(croppedSource, cropX, cropY, cropW, cropH, 0, 0, outCanvas.width, outCanvas.height);

    // Companion full-page output -- striped zoom-highlight styling for
    // stark visual contrast, uncropped so the whole viewport is visible.
    const fullPageCanvas = renderAnnotatedCanvas(img, scale, true);

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = slugify(captureName);
    const baseName = "capture-" + (slug ? slug + "-" : "") + ts;

    // While a session is recording, this capture becomes a step in the
    // eventual zip export instead -- downloading the same three files
    // individually here too would just be confusing duplicate clutter, so
    // they're skipped in that case (session or no session, the capture
    // itself and its highlights work exactly the same either way).
    const sessionRecording = !!(currentSessionState && currentSessionState.status === "recording");

    const dropdownFiles = {}; // annotation.id -> filename, for notes cross-referencing
    annotations.forEach((a) => {
      if (!a.dropdownImage) return;
      dropdownFiles[a.id] = baseName + "-dropdown-H" + a.id + ".png";
    });

    const notesText = buildNotesText(ts, pageContext, baseName, dropdownFiles);

    if (!sessionRecording) {
      downloadDataUrl(outCanvas.toDataURL("image/png"), baseName + ".png");
      downloadDataUrl(fullPageCanvas.toDataURL("image/png"), baseName + "-full.png");
      annotations.forEach((a) => {
        if (a.dropdownImage) downloadDataUrl(a.dropdownImage, dropdownFiles[a.id]);
      });
      downloadDataUrl("data:text/plain;charset=utf-8," + encodeURIComponent(notesText), baseName + ".txt");
    }

    addCaptureToSessionIfRecording({
      timestamp: Date.now(),
      baseName,
      pageUrl: pageContext.url,
      pageTitle: pageContext.title,
      croppedImage: outCanvas.toDataURL("image/png"),
      fullImage: fullPageCanvas.toDataURL("image/png"),
      notesText,
      dropdownImages: annotations
        .filter((a) => a.dropdownImage)
        .map((a) => ({ ref: "H-" + a.id, dataUrl: a.dropdownImage, filename: dropdownFiles[a.id] })),
    });

    cleanUpAfterFinish();
    toast(sessionRecording ? "Step added to session — export from the toolbar popup when done" : "Screenshot + full-page + notes saved");
  }

  // Feeds a finished capture into the active session as a new step, if one
  // is recording. Fire-and-forget: background.js no-ops when there's no
  // active session, so this is safe to call unconditionally after every
  // capture, session or no session.
  let sessionStepIdCounter = 0;
  function addCaptureToSessionIfRecording(capture) {
    try {
      chrome.runtime.sendMessage(
        {
          type: "SESSION_ADD_STEP",
          step: { id: "st_" + Date.now() + "_" + ++sessionStepIdCounter, ...capture },
        },
        () => {
          void chrome.runtime.lastError; // no active session / no listener -- expected, not an error
        }
      );
    } catch (err) {
      // Extension context can be gone (e.g. page navigated mid-capture) --
      // the capture's own files already downloaded above, so this is fine.
    }
  }

  function slugify(text) {
    if (!text) return "";
    return text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-+|-+$)/g, "")
      .slice(0, 40);
  }

  function cleanUpAfterFinish() {
    clearAllPersistentOverlays();
    annotations = [];
    contextEntries = [];
    topLevelNotes = [];
    historyStack = [];
    captureMode = false;
    numberMode = false;
    captureName = "";
    hideBadge();
    unfreezePage();
  }

  // Escape while in capture mode (but not mid area-selection/manual-draw/
  // dropdown-crop, which have their own Escape handling) -- discards
  // everything marked so far and produces no output.
  function cancelCaptureMode() {
    cleanUpAfterFinish();
    toast("Capture mode cancelled — nothing saved");
  }

  function drawSmallHighlight(ctx, x, y, w, h, scale, color) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(3, 3 * scale);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  // A visually distinct "key field" marker: a jagged zigzag outline that
  // stands out sharply from the smooth solid border of small highlights and
  // the dashed border of callout highlights.
  function drawKeyFieldHighlight(ctx, x, y, w, h, scale, color) {
    const lw = Math.max(2.5, 2.5 * scale);
    const tooth = Math.max(5, 5 * scale);
    const step = Math.max(7, 7 * scale);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.lineJoin = "miter";
    ctx.beginPath();

    ctx.moveTo(x, y);
    let out = true;
    for (let cx = x; cx < x + w; cx += step) {
      const nx = Math.min(cx + step, x + w);
      ctx.lineTo(nx, out ? y - tooth : y);
      out = !out;
    }
    ctx.lineTo(x + w, y);
    out = true;
    for (let cy = y; cy < y + h; cy += step) {
      const ny = Math.min(cy + step, y + h);
      ctx.lineTo(out ? x + w + tooth : x + w, ny);
      out = !out;
    }
    ctx.lineTo(x + w, y + h);
    out = true;
    for (let cx = x + w; cx > x; cx -= step) {
      const nx = Math.max(cx - step, x);
      ctx.lineTo(nx, out ? y + h + tooth : y + h);
      out = !out;
    }
    ctx.lineTo(x, y + h);
    out = true;
    for (let cy = y + h; cy > y; cy -= step) {
      const ny = Math.max(cy - step, y);
      ctx.lineTo(out ? x - tooth : x, ny);
      out = !out;
    }

    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  // Dropdown-flag marker: a dashed box (distinct from small/solid, key/
  // jagged, and callout/dashed-but-different-pitch) drawn only on the main
  // capture -- the crop image itself is left unmodified.
  function drawDropdownFlagHighlight(ctx, x, y, w, h, scale, color) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(3.5, 3.5 * scale);
    ctx.setLineDash([Math.max(10, 10 * scale), Math.max(6, 6 * scale)]);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  // Safety/hazard stripe: thick yellow-and-black diagonal stripe border.
  function drawSafetyStripeHighlight(ctx, x, y, w, h, scale) {
    const lw = Math.max(7, 7 * scale);
    const stripeW = Math.max(8, 8 * scale);
    const patSize = Math.round(stripeW * 2);
    const patCanvas = document.createElement("canvas");
    patCanvas.width = patSize;
    patCanvas.height = patSize;
    const pc = patCanvas.getContext("2d");
    pc.fillStyle = "#ffd700";
    pc.fillRect(0, 0, patSize, patSize);
    pc.fillStyle = "#111111";
    pc.beginPath();
    pc.moveTo(0, 0);
    pc.lineTo(stripeW, 0);
    pc.lineTo(patSize, patSize - stripeW);
    pc.lineTo(patSize, patSize);
    pc.lineTo(patSize - stripeW, patSize);
    pc.lineTo(0, stripeW);
    pc.closePath();
    pc.fill();

    ctx.save();
    ctx.strokeStyle = ctx.createPattern(patCanvas, "repeat");
    ctx.lineWidth = lw;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  function drawDashedRect(ctx, x, y, w, h, scale, color) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, 2 * scale);
    ctx.setLineDash([6 * scale, 4 * scale]);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  // Alternating color/white "candy stripe" border for full-page export.
  function drawStripedRect(ctx, x, y, w, h, scale, color) {
    const lw = Math.max(3, 3 * scale);
    const dashLen = Math.max(6, 6 * scale);
    ctx.save();
    ctx.lineWidth = lw;
    ctx.setLineDash([dashLen, dashLen]);
    ctx.strokeStyle = "#ffffff";
    ctx.lineDashOffset = 0;
    ctx.strokeRect(x, y, w, h);
    ctx.strokeStyle = color;
    ctx.lineDashOffset = dashLen;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  function drawBadgesAtAnchor(ctx, rectViewport, anchor, scale, items, badgeColor) {
    const p = anchorPoint(rectViewport, anchor);
    const px = p.x * scale;
    const py = p.y * scale;
    const r = Math.max(9, 9 * scale);
    const gap = Math.max(4, 4 * scale);
    const growRight = p.x >= rectViewport.left + rectViewport.width / 2;

    let cx = growRight ? px + r + 2 : px - r - 2;
    items.forEach((item) => {
      drawBadgeCircle(ctx, cx, py, r, scale, item, badgeColor);
      cx += growRight ? 2 * r + gap : -(2 * r + gap);
    });
  }

  function drawBadgeCircle(ctx, cx, cy, r, scale, item, badgeColor) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (item.type === "context") {
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, 1.5 * scale);
      ctx.strokeStyle = badgeColor;
      ctx.stroke();
      ctx.fillStyle = badgeColor;
      ctx.font = "italic 700 " + Math.max(11, 11 * scale) + "px -apple-system, Segoe UI, Roboto, sans-serif";
    } else {
      ctx.fillStyle = badgeColor;
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, 1.5 * scale);
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = Math.max(11, 11 * scale) + "px -apple-system, Segoe UI, Roboto, sans-serif";
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(item.text, cx, cy + 1);
    ctx.restore();
  }

  // Draw a text label with an arrow pointing to the annotation element.
  function drawTextLabel(ctx, rectViewport, label, scale, color, anchor) {
    const bx = label.left * scale;
    const by = label.top * scale;
    const fontSize = Math.max(12, 12 * scale);
    const pad = Math.max(6, 6 * scale);
    ctx.save();
    ctx.font = fontSize + "px -apple-system, Segoe UI, Roboto, sans-serif";
    const lines = label.text.split("\n");
    const lineH = fontSize * 1.3;
    const maxW = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const boxW = maxW + pad * 2;
    const boxH = lines.length * lineH + pad * 2;

    // Arrow from the chosen anchor point on the target element (same 10
    // preset points used for number/context badges) to the text box.
    const anchorPt = anchorPoint(rectViewport, anchor || "e");
    const ex = anchorPt.x * scale;
    const ey = anchorPt.y * scale;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, 1.5 * scale);
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(bx, by + boxH / 2);
    ctx.stroke();

    // White background rounded rect
    const r = Math.max(4, 4 * scale);
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + boxW - r, by);
    ctx.quadraticCurveTo(bx + boxW, by, bx + boxW, by + r);
    ctx.lineTo(bx + boxW, by + boxH - r);
    ctx.quadraticCurveTo(bx + boxW, by + boxH, bx + boxW - r, by + boxH);
    ctx.lineTo(bx + r, by + boxH);
    ctx.quadraticCurveTo(bx, by + boxH, bx, by + boxH - r);
    ctx.lineTo(bx, by + r);
    ctx.quadraticCurveTo(bx, by, bx + r, by);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, 1.5 * scale);
    ctx.stroke();

    // Text
    ctx.fillStyle = "#111";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    lines.forEach((line, i) => {
      ctx.fillText(line, bx + pad, by + pad + i * lineH);
    });
    ctx.restore();
  }

  // Preserves whatever bullet/indent structure the person typed (plain
  // multi-line text with "- " bullets and 2-space indents from Tab) rather
  // than flattening it onto one line.
  function formatMultilineField(label, text) {
    if (!text) return [label + " (none)"];
    const rawLines = text.split("\n");
    if (rawLines.length === 1) return [label + " " + rawLines[0]];
    const out = [label];
    rawLines.forEach((line) => out.push("  " + line));
    return out;
  }

  function pushOverviewNote(lines, note) {
    const rawLines = note.split("\n");
    lines.push("- " + rawLines[0]);
    for (let i = 1; i < rawLines.length; i++) {
      lines.push("  " + rawLines[i]);
    }
  }

  function buildNotesText(tsLabel, pageContext, baseName, dropdownFiles) {
    const lines = [];

    lines.push("# Capture: " + (captureName || "(untitled)"));
    lines.push("Timestamp: " + tsLabel);
    lines.push("Full-page screenshot: " + baseName + "-full.png");
    lines.push("");

    lines.push("## Page Context");
    lines.push("Title: " + (pageContext.title || "(none)"));
    lines.push("URL: " + pageContext.url);
    if (pageContext.breadcrumb) lines.push("Breadcrumb: " + pageContext.breadcrumb);
    if (pageContext.heading) lines.push("Heading: " + pageContext.heading);
    if (pageContext.description) lines.push("Meta description: " + pageContext.description);
    lines.push("");

    lines.push("## Overview");
    if (topLevelNotes.length) {
      topLevelNotes.forEach((n) => pushOverviewNote(lines, n));
    } else {
      lines.push("(none)");
    }
    lines.push("");

    lines.push("## Highlights");
    const usedContextIds = new Set();

    function contextLinesFor(annotation) {
      if (!annotation.el || !annotation.el.isConnected) return [];
      const r = annotation.el.getBoundingClientRect();
      const matches = contextEntries.filter(
        (c) => c.el && c.el.isConnected && rectsOverlap(r, c.el.getBoundingClientRect())
      );
      matches.forEach((m) => usedContextIds.add(m.id));
      return matches.map((m) => "  - Context: " + m.label + (m.snippet ? " — " + m.snippet : ""));
    }

    if (!annotations.length) {
      lines.push("(none)");
    } else {
      const numbered = annotations.filter((a) => a.number != null).sort((a, b) => a.number - b.number);
      const unnumbered = annotations.filter((a) => a.number == null);
      [...numbered, ...unnumbered].forEach((a, idx) => {
        const label = a.number != null ? "Highlight #" + a.number : "Highlight (unlabeled " + (idx + 1) + ")";
        const kind =
          a.type === "small" ? "small highlight" : a.type === "key" ? "key field highlight" : a.type === "dropdown" ? "dropdown flag" : "callout";
        lines.push("### " + label + " — " + kind);
        lines.push("Ref: H-" + a.id);
        lines.push("Title: " + (a.title || "(untitled — no label detected)"));
        lines.push(...formatMultilineField("Description:", a.description));
        if (dropdownFiles && dropdownFiles[a.id]) {
          lines.push("Dropdown capture: " + dropdownFiles[a.id]);
        }
        if (a.number != null || a.description) {
          const ctxLines = contextLinesFor(a);
          if (ctxLines.length) lines.push(...ctxLines);
        }
        lines.push("");
      });
    }

    const leftoverContext = contextEntries.filter((c) => !usedContextIds.has(c.id));
    if (leftoverContext.length) {
      lines.push("## Additional Context (not tied to a specific highlight)");
      leftoverContext.forEach((c) => {
        lines.push("- " + c.label + (c.snippet ? " — " + c.snippet : ""));
      });
      lines.push("");
    }

    return lines.join("\n");
  }

  function downloadDataUrl(url, filename) {
    try {
      chrome.runtime.sendMessage({ type: "DOWNLOAD_FILE", url, filename }, (resp) => {
        if (chrome.runtime.lastError || !resp || resp.error) {
          console.error("Slideshot: download failed", chrome.runtime.lastError || (resp && resp.error));
          toast("Download failed for " + filename + " — see console (F12) for details");
        }
      });
    } catch (err) {
      console.error("Slideshot: download message failed", err);
      toast("Download failed for " + filename + " — see console (F12) for details");
    }
  }
})();
