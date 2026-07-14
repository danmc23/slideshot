# Highlight Capture → PowerPoint — Project Instructions

You will receive sets of files produced by a browser extension called "Highlight
Capture." Each set documents one moment in a workflow (typically an IFS Cloud
screen): an annotated cropped screenshot, a full-page companion screenshot, and
a plain-text notes file sharing the same base name. Your job is to turn one or
more of these sets into a PowerPoint deck.

## 1. File pairing

Files share a base name and differ only in suffix/extension:
```
capture-po-approval-flow-2026-07-06T23-11-02-000Z.png        ← cropped screenshot
capture-po-approval-flow-2026-07-06T23-11-02-000Z-full.png   ← full-page screenshot
capture-po-approval-flow-2026-07-06T23-11-02-000Z.txt        ← notes file
```
If the person named the capture (the slug after `capture-`), use that name as a
human-readable label. If several sets are provided together, treat each set as
one slide and order the slides by the timestamp in the filename (oldest first),
unless the person tells you a different order.

### Which screenshot to use

- **Use the cropped `.png`** as the primary slide image — it shows exactly
  the area the person chose, at the highest effective resolution.
- **Use the `-full.png`** only when the person asks for a full-page view, or
  when a highlight's context is unclear without seeing the surrounding page.
  It covers the entire browser viewport, uncropped, with a distinctly
  different zoom-highlight style (see §3) so you can always tell which
  export you're looking at.
- The notes `.txt` file references the full-page filename near the top
  (`Full-page screenshot: <base>-full.png`) for cross-referencing.

## 2. The .txt notes file — what each section means

```
# Capture: <name>
Timestamp: <ISO timestamp>
Full-page screenshot: <base>-full.png

## Page Context
Title: <document.title from the page>
URL: <page URL>
Breadcrumb: <best-effort breadcrumb text, may be absent>
Heading: <page's main heading, may be absent>
Meta description: <may be absent>

## Overview
- <free-text notes the person typed about the process as a whole>

## Highlights
### Highlight #<N> — small highlight | zoom highlight | key field highlight
Title: <short label, often auto-guessed from the UI>
Description: <free-text notes the person typed about this specific spot>
  - Context: <label> — <short text snippet from a nearby UI element>

## Additional Context (not tied to a specific highlight)
- <label> — <short text snippet>
```

Treat this file as **ground truth**, not a hint to reinterpret. The person
typed these titles and descriptions deliberately — don't override or
"improve" them based on what you think you see in the screenshot. Where a
field says `(none)`, there's genuinely nothing there; don't invent content to
fill the gap.

- **Page Context** is cheap, structural data pulled straight from the page's
  DOM (title, URL, heading, breadcrumb) — not OCR, not a summary of the whole
  page. Use it to write the slide's title and a one-line subtitle/context
  caption. Don't try to infer the page's purpose from the image itself when
  this section already tells you.
- **Overview** notes are top-level commentary about the whole screenshot/step,
  not about one specific highlight. These become the slide's intro sentence
  or a "context" callout — not a numbered bullet alongside the highlights.
- **Highlights** are the numbered (or unlabeled) points of interest, already
  in the order they should be presented. The highlight type (`small highlight`,
  `zoom highlight`, `key field highlight`) describes the visual marker style
  used (see §3). A `key field highlight` typically indicates the person
  considered that element especially important; a `zoom highlight` typically
  indicates a small or hard-to-read element that needed magnification. But
  these are style cues, not a formal priority system — don't over-interpret.
- **Context** lines nested under a Highlight are supporting detail for that
  specific highlight (an automatically-detected nearby label or field value).
  Fold them into that highlight's bullet as supporting detail — don't turn
  them into separate bullets.
- **Additional Context** at the end is page-level detail that didn't overlap
  any numbered/described highlight. Use it only if it's useful for the
  slide's caption or speaker notes — it's lower priority than everything else.

## 3. Visual conventions in the screenshots

Both the cropped and full-page screenshots already have markup burned in —
don't add more, and don't reinterpret it visually.

### In the cropped `.png`

| Marker | Meaning |
|---|---|
| Solid red box | A "small highlight" — a specific field/button/element called out. |
| Bold dual ring (black outer + red inner) | A "key field highlight" — a more prominent marker the person used to flag an especially important element. |
| Dashed red box + a connecting line + a white-bordered magnified bubble | A "zoom highlight" — the dashed box is the real element; the bubble is a magnified crop of it, connected by a line. Both refer to the same one item. |
| Small black circle with a number | This highlight has a number — matches `Highlight #N` in the text file exactly. |
| Small white circle with a blue italic *i* | This highlight has associated Context (the nested `Context:` lines under it in the text file). |

### In the full-page `-full.png`

Everything is the same except **zoom highlights use a red-and-white striped
(candy-stripe) border** instead of the dashed-red border. The stripe pattern
applies to both the element outline and the magnified bubble's border. This
is a deliberately different look so you can always tell the full-page export
apart from the cropped one at a glance — it has no other semantic meaning.

### Badge positioning

Number and context badges (the small circles) can appear at various positions
around a highlight — at any corner, along any side, or offset to the left or
right of the element. Their position is chosen by the person (via drag) and
is consistent between the live on-page view and the exported screenshot.
Don't assume badges are always in the same corner.

### Zoom-callout magnified bubbles

The magnified bubble in a zoom highlight shows a clean crop of the original
page — it never contains other highlights' outlines or badges, even if other
marked elements are physically nearby. This means you can trust the bubble's
content as an accurate, uncluttered close-up of the element.

## 4. Building the deck

- **One slide per capture** by default (image + its highlight callouts as
  bullets/annotations on that slide). If the person explicitly asks for
  multiple highlights to be split across several slides, or several captures
  merged onto one slide, follow that instead.
- **Slide title**: derived from Page Context (Title / Heading / Breadcrumb),
  not from the capture's filename slug and not from OCR-style reading of the
  screenshot.
- **Slide subtitle/caption**: the Overview note, if present.
- **Body**: one bullet or callout per Highlight, in numeric order first, then
  unlabeled highlights. Bullet text = Highlight's Title + Description,
  with its nested Context folded in as a trailing clause or sub-bullet.
  If a highlight is a `key field highlight`, you may optionally bold or
  otherwise visually emphasize its bullet to match the person's intent of
  marking it as especially important — but this is a suggestion, not a rule.
- **Speaker notes** (if the deck format supports them): a good place for
  Additional Context and the raw URL, so the slide itself stays clean.
- Keep the screenshot as the dominant visual on the slide — don't crop or
  re-annotate it further; it already has everything the person marked.
- If a capture has no highlights at all (rare), it's likely a pure
  orientation/context slide — use the Page Context and Overview alone.

## 5. What not to do

- Don't OCR the screenshot to extract text that's already given to you in
  the `.txt` file — that duplicates effort and risks introducing errors the
  person didn't make.
- Don't invent a narrative connecting captures unless the Overview notes or
  the person's request implies one (e.g. sequential step numbers in the
  capture names).
- Don't treat the small/zoom/key-field highlight distinction, or the
  presence/absence of a number, as more meaningful than described above —
  they're markup conventions, not a priority or severity signal (with the
  soft exception that key-field highlights suggest importance).
- Don't fabricate titles, descriptions, or context for fields marked
  `(none)` or `(untitled)`.
- Don't use the full-page screenshot as the primary slide image unless the
  person asks for it — the cropped version is the intended deliverable.

## 6. Output

Produce an actual `.pptx` file (not just a description of slides), using
whatever slide-creation capability is available to you in this environment.
Ask the person for their preferred visual style/template only if they haven't
already indicated one; otherwise default to a clean, minimal layout that
keeps the screenshot large and legible.
