# Slideshot — TODO / Roadmap

## High priority

- **`guessTitle()` heuristic is still weak.** Every highlight now always
  emits a `Title:` line in the notes output (falls back to "(untitled — no
  label detected)" instead of being silently omitted — see Recently done),
  but the underlying auto-detection itself still often comes back empty (no
  `aria-label`, no `title` attribute, no matching `<label>`, not a table
  cell, no placeholder, or text too long). Worth revisiting the heuristic
  itself at some point, separate from the output-formatting fix.
- **Browser testing pass.** No in-browser testing has been done on anything
  from v0.8.0 through the current build (including this round's callout
  tool, dropdown-flag tool, session/voice recording, popup, and PDF/zip
  export) — all changes were syntax/structure-checked only (including a
  byte-level structural validation of the PDF/ZIP writers), never loaded in
  an actual browser. Load unpacked, test every hotkey and interaction end to
  end before relying on this for real work.
- **Callouts/text labels have no drag-to-reposition step before capture.**
  The old "bubble adjustment" phase (drag zoom-callout bubbles before the
  final capture) was removed entirely when zoom highlights were replaced
  with the arrow+textbox callout tool, since callouts don't need
  collision-avoidance the way magnified bubbles did. That also means the
  previous plan to wire `Shift+T` text-label dragging into that phase is now
  moot — there's currently no drag-to-reposition step for callouts or text
  labels at all; they're placed at a fixed default offset from the target
  element. Worth adding a lightweight reposition step if the default
  placement proves awkward in practice.

## Medium priority

- Update `extension/README.md` further as features change (color system,
  manual draw mode, text annotations, page freeze are documented, but keep in
  sync going forward).
- Update `docs/project-instructions.md` for text annotations, manual-draw
  highlights, and the color system (currently reflects v0.8.1 behavior).
- `SNAP_PX = 10` (area-selector edge-snap threshold) hasn't been tuned
  against real usage.
- Page URL is included verbatim in the notes file — no redaction option.
- Full-page export has no toggle — always generated alongside the cropped
  export.
- Consider splitting `content.js` (2500+ lines, all logic in one file) into
  modules if a build step becomes acceptable.

## Roadmap / future features

- **"Grab table from area" tool.** Select an area on the page and extract the
  underlying text/table data (not a screenshot) into a table the user can
  copy straight into Excel.
- **In-app capture history / hierarchy.** Some way to group multiple captures
  within a session — by process, by a simple hierarchy, or by target slide —
  to make it easier to manage a multi-step workflow toward the ultimate
  PowerPoint export instead of handling each capture as a fully independent
  one-off.

## Recently done

- **Fixed dropdown-flag timing for good, plus a proper cancel/exit and
  suppressed duplicate downloads during a session.** `Shift+D` now works
  standalone (even before `Shift+1`) and defers every visual side effect
  (badge/freeze/toast/flash) until *after* the screenshot is already safely
  captured, so nothing can disturb the dropdown's hover state first — this
  replaces the earlier fix (moving the capture-name prompt to finish-time),
  which turned out to only be part of the problem. `Escape` while in capture
  mode (outside area-select/manual-draw/dropdown-crop) now cancels it
  entirely with no output. And while a session is recording, the normal
  per-capture PNG/PNG/`.txt` downloads are now skipped (the capture still
  becomes a session step as before) — they were confusing duplicate clutter
  once the zip export exists as the real deliverable for that mode.
- **On-page collapsible session panel + matching popup controls.** A
  floating panel (independent of capture mode) shows session status/step
  list with Start/Stop, Discard, and per-step Delete/Edit-narration — wiring
  the `DELETE_STEP`/`UPDATE_STEP_NARRATION` handlers that existed with no UI
  before. The toolbar popup's step list got matching per-step controls too.
  Saved for later: re-recording a previous step in place, and per-highlight
  title/description editing (would need storing structured highlight data
  per step instead of just the pre-rendered notes text).
- **Session recording + voice narration + combined export.** `Ctrl+Shift+E`
  starts/stops a session (stored in `chrome.storage.local`); every finished
  capture made while a session is recording is added as a step
  automatically. While recording, an offscreen document runs
  continuous Web Speech API speech-to-text (no raw audio is ever stored,
  only transcript text with timestamps) — first use opens a one-time tab to
  grant microphone access, since offscreen documents can't show permission
  prompts themselves. A new popup (toolbar icon) shows session status/step
  list and Start/Stop/Discard/Export controls. Export builds one PDF page
  per step (screenshot + highlight refs/titles/descriptions + narration,
  time-window-aligned to each step), auto-splitting into multiple PDF parts
  if a part would near Claude's 30MB per-file upload limit, and bundles the
  PDF part(s) + a combined `session-notes.md` + the raw per-step PNGs into
  one zip download. The PDF writer and ZIP writer are both hand-rolled
  (no dependencies) and were structurally validated (byte-level xref/zip
  parsing) outside the browser, but not yet opened in a real PDF viewer or
  browser — see the browser-testing-pass item above.
- **Dropdown-flag tool (`Shift+D`).** Hovering an open dropdown and pressing
  it immediately screenshots the viewport (before any mouse movement can
  close the dropdown), then lets you drag a crop box over that now-frozen
  image to pull out just the dropdown as its own small PNG, correlated to a
  marker on the main capture via a `Ref: H-<id>` in the notes. Only works
  for dropdowns that are real page DOM elements (custom/ARIA menus) — native
  `<select>` popups render outside the page's pixels and can't be
  screenshotted by any Chrome extension.
- **Replaced the zoom/magnify highlight with an arrow+textbox callout tool**
  (still on `Shift+H`). Requires entering text before the highlight is
  created (cancelling discards it). Removed all the old
  magnification/bubble-collision/bubble-adjustment code along with it.
- **Every highlight now gets a stable `Ref: H-<id>`** in the notes output,
  independent of its optional visual number bubble, plus a guaranteed
  `Title:` line (see the `guessTitle()` item above for the remaining gap).
- Fixed downloads: only the `.png` was ever saving because the extension
  triggered all three files via content-script `<a download>` clicks in a
  row, which Chrome silently blocks after the first ("multiple automatic
  downloads"). Downloads now go through `chrome.downloads.download()` in
  the background worker (new `downloads` permission), which isn't subject
  to that block.
- Unified the enter-capture-mode and finish-capture hotkeys onto `Shift+1`
  (press once to enter, press again while in capture mode to open the area
  selector and finish).
- Renamed the extension from "Highlight Capture" to "Slideshot".
- A full-screen "flash" already exists on entering capture mode
  (`lightFlash()` / `#hc-enter-flash` in `overlay.css`) — verify it reads
  clearly as an "entered capture mode" signal during the browser testing
  pass; adjust duration/opacity if it's too subtle or too jarring.
