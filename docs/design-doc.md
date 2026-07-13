# Highlight Capture — Design Document

**What it is:** a Chrome extension for documenting a workflow on any webpage.
While in "capture mode," you mark up specific elements with hotkeys (boxes,
zoom callouts, numbers, notes), then take a screenshot that has all of it
burned in, plus a matching text file describing everything you marked — meant
to be fed into an AI tool afterward to generate a slide deck or document.

This doc describes the *shape* of the system, not exact code, so it can be
rebuilt in any language/framework or handed to a person as a spec.

---

## 1. High-level architecture

Three pieces, standard for a Chrome extension:

- **manifest.json** — declares permissions and wires the other two files together.
- **background script** — the only place allowed to take a screenshot of the
  visible tab (browser security restriction). Just listens for one message
  type ("capture the tab") and replies with the image data.
- **content script** — injected into every page. Owns all the logic: hotkeys,
  drawing overlays, tracking what's been marked, compositing the final image,
  writing the notes file, triggering downloads.

```
[Page] <--- content script (all logic, runs per-tab) ---> [Background script]
                                                                    |
                                                          chrome.tabs.captureVisibleTab
```

Permissions needed: ability to capture the current tab's pixels, and to run
on any page. (Note: the "only capture when the user clicks the extension
icon" permission model doesn't work here, because capture is triggered by an
in-page hotkey, not a toolbar click — so this needs a broader, always-on
capture permission instead.)

---

## 2. Core data model

State lives entirely in memory in the content script, reset each time a
capture session starts:

```
captureMode: boolean
captureName: string              // optional label, becomes part of filename
numberMode: boolean               // sub-mode for tagging highlights with numbers

annotations: list of {
  type: "small" | "big" | "key"   // visual style of the highlight
  element: <reference to the DOM element marked>
  number: integer or null
  title: string
  description: string             // may be multi-line / bulleted
}

contextEntries: list of {
  element: <reference to DOM element>
  label: string                   // auto-guessed
  snippet: string                 // short auto-captured text
}

topLevelNotes: list of strings    // overview notes, not tied to one highlight
```

Two things are intentionally NOT stored as pixel coordinates: annotations
keep a *live reference* to the actual DOM element, and re-read its position
(`getBoundingClientRect`) every time it's needed. This means overlays stay
correctly positioned even if the page scrolls or reflows between when you
marked something and when you finish the capture.

---

## 3. Hotkey map

All hotkeys are inert unless `captureMode` is true (except the one that
turns capture mode on), and all are disabled while focus is inside any text
input — you never want to hijack normal typing.

| Key | Effect |
|---|---|
| Enter capture mode | reset all state, prompt for an optional name |
| Small highlight | mark hovered element, style A |
| Key-field highlight | mark hovered element, bold/distinct style |
| Zoom highlight | mark hovered element, style B (gets a magnified callout) |
| Describe highlight | open a small text panel for title+notes on the hovered *marked* element |
| Overview note | open a text panel for a note not tied to any one element |
| Toggle number mode | while on, pressing a digit tags the hovered marked element with that number |
| Context tag | auto-capture a label+snippet from the hovered element, no typing |
| Finish & capture | open the area-selector, then screenshot + compose + download |

"Hovering a marked element" is resolved spatially (cursor inside that
element's current bounding box) rather than by exact identity — more
forgiving of small cursor drift, and if two marks are nested, the smallest
one wins.

---

## 4. Area selection (draw-your-own rectangle)

```
on "finish & capture" hotkey:
    enter area-selection mode
    show floating toolbar with Accept / Start Over

    on drag start (mouse down + move):
        begin drawing a rectangle from the drag's start point
        as the drag continues:
            if Ctrl/Cmd is NOT held:
                look at whatever element is under the current cursor position
                if the dragged edge is within a few px of that element's edge,
                    snap to it (prefer whichever snap makes the box bigger)
            update the visible rectangle + resize handles

    on drag end:
        if the rectangle is too small, discard it (or keep the previous one)
        otherwise show 8 resize handles on the rectangle for fine adjustment
            (same snap-on-drag behavior applies to handle dragging)

    on Accept:
        record the final rectangle (in on-screen coordinates)
        tear down all selection UI
        proceed to capture
    on Escape:
        tear down UI, stay in capture mode, no capture happens
```

Any mouse click during area-selection that isn't one of the selector's own
controls is swallowed (prevented), so you don't accidentally click a real
button on the page underneath while drawing.

---

## 5. Taking the actual screenshot

```
on Accept (from area selection):
    hide every bit of this extension's own visible UI:
        - the hotkey legend
        - the muted outline for every marked highlight
        - the toast/status message
    wait for the browser to actually repaint without them
        (two animation-frame ticks is enough)
    ask the background script to capture the visible tab -> raw image
    restore the hidden UI (doesn't affect the already-captured image)

    if capture failed: show an error, stop

    load the raw image into an off-screen canvas
    for each annotation:
        re-read its element's current on-screen position
        draw its highlight style onto the canvas at that position
        draw its number/context badge, positioned to avoid the highlight
            itself and typical label placement (not directly on top of it)
    crop the canvas down to the confirmed selection rectangle
    export as PNG -> trigger a download

    build the notes text file from current state (see section 6)
    trigger a second download with the same base filename, .txt extension

    reset all state back to "not in capture mode"
```

Why hide-then-capture matters: `captureVisibleTab` captures literal on-screen
pixels, including any of the extension's own DOM overlays if they're still
visible. Skipping this step means your own UI chrome ends up baked into the
"clean" screenshot.

---

## 6. Notes file format

Plain text, loosely markdown-shaped so it's easy for both a human and an AI
model to read without needing to look at the image at all for basic facts:

```
# Capture: <name or "untitled">
Timestamp: <ISO timestamp>

## Page Context
Title: <document title>
URL: <page URL>
Breadcrumb / Heading: <if detectable — cheap DOM lookups only, no OCR>

## Overview
- <top-level notes, bullets preserved as typed>

## Highlights
### Highlight #<N> — <small|zoom|key field> highlight
Title: <title>
Description: <description, multi-line/bulleted if typed that way>
  - Context: <label> — <snippet>      (only if a context tag overlaps this highlight)

## Additional Context (not tied to a specific highlight)
- <label> — <snippet>      (context tags that didn't overlap any highlight)
```

Design principle: capture cheap structural *facts* (page title, URL, a
heading) rather than anything resembling OCR or a summary of the page — the
interpretation/summarization work belongs downstream (e.g. in an AI
project's instructions), not baked into the extension.

---

## 7. Visual conventions (what ends up in the exported image)

- **Small highlight** — solid box outline.
- **Zoom highlight** — a fainter/dashed outline on the real element, a line
  connecting it to a **magnified crop of itself** placed in open space
  nearby, with a light border around the magnified copy.
- **Key-field highlight** — a bolder, two-color ring, visually louder than
  the other two on purpose (this is the "don't miss this one" marker).
- **Number badge** — small circle with the number, positioned outside the
  highlight's box (not on top of the field or its label).
- **Context badge** — small circle with an "i", shown next to the number
  badge only when a context tag overlaps that specific highlight.

---

## 8. Design principles worth preserving if rebuilt

1. **Never hijack normal typing.** Every hotkey checks that focus isn't in
   a text field first.
2. **Fail loudly, not silently.** Any error in the capture/compose pipeline
   should show the person a message, never just hang.
3. **Positions are computed live, not cached as pixels**, so overlays and
   the final composite stay accurate even if the page shifts.
4. **The extension captures facts; it doesn't interpret them.** Anything
   resembling "understanding" the page's meaning belongs in whatever
   consumes the output (e.g. an AI summarization/slide-generation step),
   not in the capture tool itself.
5. **Hide the tool's own UI before the real screenshot is taken.** Anything
   visible on the live page at that instant ends up in the picture.
