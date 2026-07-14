# Slideshot — TODO / Roadmap

## High priority

- **Titles aren't reliably making it into the notes file.** `guessTitle()` is
  called at annotation creation and stores a best-effort title, but it often
  comes back empty (no `aria-label`, no `title` attribute, no matching
  `<label>`, not a table cell, no placeholder, or text too long) — so unless
  the user also opens the describe panel (`Shift+J`) and the title gets
  re-saved there, a highlight can end up with no title at all in the output.
  This applies to every marked item — small/key/zoom highlights and context
  tags — not just described ones. Fix: make sure whatever was auto-detected
  (or manually entered) is always emitted in the `.txt` file for anything the
  user flagged, regardless of whether they added a description, since the
  downstream Claude Project relies on titles to interpret meaning for slide
  text generation.
- **Browser testing pass.** No in-browser testing has been done on anything
  from v0.8.0 through the current build — all changes were syntax-checked
  only. Load unpacked, test every hotkey and interaction end to end.
- **Wire text annotation (`Shift+T`) dragging** into the bubble adjustment
  phase so text boxes can be repositioned before capture (currently only
  zoom-callout bubbles are draggable there).

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
