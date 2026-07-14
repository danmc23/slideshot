# Slideshot

A Chrome extension (Manifest V3) for hotkey-driven webpage annotation. Mark
up elements on any page with highlights, numbers, descriptions, and context
tags, then export a burned-in screenshot (plus an uncropped full-page
companion) and a matching notes `.txt` file — meant to be fed into an AI
tool afterward (e.g. a Claude Project) to generate slides or documentation.

## Install (unpacked)

1. `chrome://extensions` -> enable **Developer mode**.
2. **Load unpacked** -> select this folder.
3. Reload any tab you want to use it on (content scripts only attach on
   fresh page loads after the extension is installed/reloaded).

## Hotkeys

| Key | Effect |
|---|---|
| `Shift+1` | Enter capture mode (prompts for an optional name). Press again while already in capture mode to open the capture-area selector, then screenshot + compose + download |
| `Shift+G` | Small highlight on the hovered element |
| `Ctrl+Shift+G` | Key-field highlight (bold dual-ring — the "don't miss this" marker) |
| `Shift+H` | Zoom highlight (gets a magnified callout bubble) |
| `Shift+J` | Describe the highlight under the cursor (title + notes) |
| `Shift+K` | Add a top-level overview note (not tied to one highlight) |
| `Shift+N` | Toggle number mode, then press `0`–`9` over a highlight to tag it |
| `Shift+C` | Tag the hovered element as additional context (auto-captured, no typing) |
| `Ctrl+Z` | Undo the last marking action |

Hotkeys are ignored whenever focus is inside any input, textarea, or
contenteditable — including the extension's own text panels — so normal
typing is never hijacked.

## Capture-area selection

Press `Shift+1` again (while already in capture mode) to open the area selector:

- **Drag to draw** a rectangle. Edges snap to nearby page elements (prefers
  whichever snap makes the box larger); hold `Ctrl`/`Cmd` while dragging to
  disable snapping.
- Once drawn, **8 resize handles** let you fine-tune the box (same snapping
  behavior applies).
- **Accept area** (button or `Enter`) proceeds to capture. **Start over**
  clears the box to draw a new one. `Esc` cancels and returns to capture
  mode without capturing.

There is no pre-identified "landmark region" step — you always draw your
own box. (An earlier version tried auto-detecting header/nav/sidebar regions
you could Ctrl+click to add; it was removed for being more complexity than
it was worth.)

### Zoom-callout collision check

If a zoom highlight's (`Shift+H`) magnified bubble would spill outside the
capture area, overlap another highlight, or overlap another zoom bubble,
accepting the area shows a prompt describing the issue with two choices:
**Let me fix it** (returns to capture mode so you can resize the area,
reposition/remove a highlight, etc., then press `Shift+1` again) or
**Capture anyway** (proceeds despite the overlap).

This check only knows about *other highlights and zoom bubbles* — it has no
generic way to find "the label text near this field" on an arbitrary page,
so a bubble that happens to land on ordinary page text (not another
highlight) won't be flagged.

## Number/context badges and drag-to-reposition

Any highlight that has a number, a description, or an overlapping context
tag gets a small badge cluster (a `#N` chip, a checkmark, and/or an italic
"i") positioned outside its box at one of **10 preset anchor points**: the
four corners, the four side-centers, and an offset-left/offset-right pair
that sits further out to the side.

- **Default anchor**: tries the left side of the field first, falling back
  to the right side, then the original top-right-external spot, if the
  preferred position would collide with *another highlight's box* or run
  off the edge of the screen. It does **not** know where a field's own text
  label sits (no generic way to find that on an arbitrary page), so the
  default is a reasonable guess, not a guarantee.
- **Drag to reposition**: click and drag any badge cluster; it snaps to
  whichever of the 10 anchor points is closest to your cursor, live, and
  keeps that position on mouse-up. The chosen anchor is remembered per
  highlight and used for both the live on-page badge and the exported
  canvas badge, so what you see while marking matches what ends up in the
  screenshot.
- Dragging a badge is **not** covered by `Ctrl+Z` — undo only covers
  adding/removing highlights, context tags, numbers, and descriptions.

## Undo (`Ctrl+Z`)

Every mutating action (queuing a highlight, tagging a number, adding
context, saving a description or overview note) pushes a snapshot onto an
undo stack (capped at 25 steps) before it happens. `Ctrl+Z` pops the most
recent snapshot and rebuilds the live overlays from it. The stack resets
whenever you enter capture mode or finish a capture.

## What gets exported

Finishing a capture produces **three files**, all sharing one base name
(`capture-<name>-<timestamp>`, or `capture-<timestamp>` if you skipped
naming it):

- **`<base>.png`** — cropped to your selected area. Zoom highlights use a
  normal dashed-red outline.
- **`<base>-full.png`** — the *entire* viewport, uncropped. Zoom highlights
  here use a bold **red/white striped** outline instead, for stark contrast
  against the rest of the page — a deliberately different look so it's easy
  to tell the two exports apart at a glance. This file is always generated
  alongside the cropped one; there's currently no toggle to skip it.
- **`<base>.txt`** — the notes file (see below).

Highlight shapes and zoom-callout magnified crops are always drawn in a
first pass; every badge is drawn in a second pass strictly afterward. This
guarantees a badge can never end up duplicated inside another highlight's
magnified zoom bubble, regardless of where highlights happen to sit
relative to each other.

### Notes file format

Plain text, loosely Markdown-shaped:

```
# Capture: <name or "(untitled)">
Timestamp: <ISO timestamp>
Full-page screenshot: <base>-full.png

## Page Context
Title: <document title>
URL: <page URL>
Breadcrumb: <if detectable>
Heading: <if detectable>
Meta description: <if present>

## Overview
- <top-level notes, bullets/indents preserved as typed>

## Highlights
### Highlight #<N> — <small|zoom|key field> highlight
Title: <title>
Description: <description, multi-line/bulleted if typed that way>
  - Context: <label> — <snippet>      (only if a context tag overlaps this highlight)

## Additional Context (not tied to a specific highlight)
- <label> — <snippet>      (context tags that didn't overlap any highlight)
```

Only cheap structural DOM facts are captured (page title, URL, a heading) —
no OCR, no summarization. That interpretation work is meant to happen
downstream, e.g. in whatever AI project ingests these files.

## Known limitations / open questions

- **`SNAP_PX = 10`** (the area-selector's edge-snap threshold) hasn't been
  tuned against real usage yet — flag if it feels too twitchy or too loose.
- **The page URL is included verbatim** in the notes file. If you're
  capturing anything with sensitive URLs, there's currently no way to
  redact or omit it — worth revisiting if that comes up.
- Numbers are single digits (`0`–`9`) only.
- Zoom-collision detection and default badge-anchor placement both only
  check against *other highlights this extension knows about* — neither
  has a generic way to detect arbitrary page content (e.g. a field's own
  label text) to avoid overlapping it.
- The full-page export is always generated; there's no per-capture toggle
  to skip it if you only want the cropped image.
- No in-browser testing has been done on this round of changes beyond a
  static syntax check — please report back anything that misbehaves.

## File layout

- `manifest.json` — permissions + wiring.
- `background.js` — the only place allowed to call
  `chrome.tabs.captureVisibleTab` (browser restriction); listens for one
  `CAPTURE_TAB` message and replies with the image data or an error.
- `content.js` — everything else: hotkeys, live overlays, area selection,
  collision checks, canvas compositing, notes-file generation, undo.
- `overlay.css` — all visual styling for the extension's own UI.
