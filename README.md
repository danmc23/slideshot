# Slideshot

A Chrome extension (Manifest V3) for hotkey-driven webpage annotation. Mark up
elements on any page with highlights, numbers, descriptions, and context tags,
then export a burned-in screenshot (plus an uncropped full-page companion) and
a matching notes `.txt` file — meant to be fed into an AI tool afterward (e.g.
a Claude Project) to generate slides or documentation.

## Layout

- `extension/` — the Chrome extension itself (`manifest.json`, `background.js`,
  `content.js`, `overlay.css`), plus its own usage README.
- `docs/` — reference docs for the downstream Claude Project that turns
  Slideshot's PNG+TXT output into PowerPoint slides (`project-instructions.md`,
  `design-doc.md`).
- `TODO.md` — known issues, open items, and roadmap.

## Install (unpacked)

1. `chrome://extensions` -> enable **Developer mode**.
2. **Load unpacked** -> select the `extension/` folder.
3. Reload any tab you want to use it on.

See `extension/README.md` for the full hotkey reference and usage details.
