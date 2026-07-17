# Slideshot session → PowerPoint — Project Instructions

You will receive the output of a browser extension called **Slideshot**. Slideshot records a
**session**: one or more captures ("steps") of a workflow (typically an IFS Cloud screen), each
with highlights, callouts, dropdown detail crops, and optional voice narration. A session exports
as a **zip** containing:

```
session-part1.pdf, session-part2.pdf, …   ← the primary artifact (see §0) — may be a single
                                             session.pdf instead if the session was small enough
session-notes.md                          ← the same text content as plain markdown
step-01.png, step-01-full.png             ← raw lossless screenshots per step (cropped + full-page)
step-01-dropdown-H<id>.png                ← raw dropdown detail crop(s), if any, per step
```

Only the PDF part(s) are meant to be uploaded to this project in one shot — that's what the rest of
this document is written around. If the person instead gives you the full zip contents (or just
`session-notes.md` + the PNGs), the same structure and rules apply; skip straight to §2, since you
already have the text without needing to extract it from a PDF.

Your job is to turn the session into a PowerPoint deck.

## 0. Efficient PDF ingestion — use the `markitdown` MCP connector

The PDF's screenshots are already-compressed JPEGs, and its highlight/narration text is real,
selectable PDF text (not a picture of text) — so there is no need to burn vision tokens reading
every page just to recover text that's already given to you as text. **Before doing anything else,
run each PDF part through the `markitdown` MCP connector** to convert it to Markdown. This pulls out
all of the structured step text (Ref/Title/Description/Narration — see §2) cheaply, in one pass,
across every page.

Two things to keep in mind:

- **markitdown will not hand you back the screenshots as separate image files.** It's a text/
  structure extractor. For the actual image to place on a slide, either use the corresponding raw
  PNG from the zip if the person provided it (preferred — it's the lossless source, not a
  re-compressed copy), or fall back to a **targeted** vision read of that one specific PDF page when
  you're actually building that step's slide. Don't do a blanket vision pass over the whole PDF —
  that defeats the point of using markitdown for the text in the first place.
- **Multiple PDF parts are one session, not several.** If you receive `session-part1.pdf`,
  `session-part2.pdf`, etc., process them in numeric order as one continuous sequence of steps —
  the split only happened to keep each file under an upload size limit.

## 1. What one PDF page contains

Each **step** normally occupies one page: its screenshot(s) at the top — the main highlighted
capture, plus any dropdown detail crop(s) for that step stacked directly below it, all at their true
relative size (a dropdown crop is *not* stretched to page width) — followed by that step's full
notes text below the image(s). A step whose notes/narration text doesn't fit below the image
continues onto one or more extra **text-only** pages (no image) immediately after — treat those as
a continuation of the same step, not a new one. A step whose main screenshot is notably
wide (e.g. a full-page capture) gets a **landscape** page instead of a portrait one; this is a
page-rotation choice only, not a signal about the content.

## 2. The notes text — what each field means

This is the same text whether you're reading it out of the PDF via markitdown or directly from
`session-notes.md`:

```
## Step N
Page: <document.title from the page> — <page URL>
Image: step-NN.png
Narration: <transcribed speech, time-aligned to this step — may be absent>

# Capture: <name, if the person set one>
Timestamp: <ISO timestamp>
Full-page screenshot: <base>-full.png

## Page Context
Title: <document.title>
URL: <page URL>
Breadcrumb / Heading / Meta description: <best-effort, may be absent>

## Overview
- <free-text notes the person typed about the step as a whole>

## Highlights
### Highlight #<N> — small highlight | key field highlight | callout | dropdown flag
Ref: H-<id>
Title: <short label, auto-guessed or typed — literally "(untitled — no label detected)" if
  auto-detection found nothing>
Description: <free-text notes, or callout text>
Dropdown capture: <filename>              ← only on a "dropdown flag" highlight
  - Context: <label> — <short text snippet from a nearby UI element>

## Additional Context (not tied to a specific highlight)
- <label> — <short text snippet>
```

Treat this as **ground truth**, not a hint to reinterpret. The person typed these titles and
descriptions (or spoke the narration) deliberately — don't override or "improve" them based on what
you think you see in the screenshot. Where a field says `(none)` or `(untitled — no label
detected)`, there's genuinely nothing there; don't invent content to fill the gap.

- **Ref: H-\<id\>** is a stable identifier for the highlight, independent of whether it has a visual
  number badge (`Highlight #N`) at all — use it if you need to cross-reference a highlight in speaker
  notes; don't assume every highlight has a number.
- **Narration** is voice speech transcribed while the person held a push-to-talk key during that
  step, aligned to it by timing (not necessarily to a single highlight within it). Treat it like a
  verbal walkthrough of the step — a natural source for the slide's body text or speaker notes — but
  it may contain minor transcription errors or a stray sentence that bled in from just before/after
  the step; use judgment rather than quoting it verbatim if something clearly doesn't fit.
- **Page Context** is cheap, structural data pulled straight from the page's DOM — not OCR, not a
  summary of the whole page. Use it for the slide's title and a one-line subtitle/context caption.
- **Overview** notes are top-level commentary about the whole step, not one specific highlight —
  these become the slide's intro sentence, not a numbered bullet alongside the highlights.
- **Highlights** are the numbered (or unlabeled) points of interest, already in the order they
  should be presented. The type (`small highlight`, `key field highlight`, `callout`, `dropdown
  flag`) describes the visual marker style (see §3) — a `key field highlight` typically indicates
  the person considered that element especially important; these are style cues, not a formal
  priority system.
- **Dropdown capture** on a highlight means there's a second, smaller image specifically of an
  expanded dropdown/menu — see §3 for how to use it.
- **Context** lines nested under a highlight are supporting detail for that highlight (an
  auto-detected nearby label or field value) — fold them into that highlight's bullet, don't turn
  them into separate bullets. **Additional Context** at the end is page-level detail that didn't
  overlap any highlight — use it only if useful for a caption or speaker notes.

## 3. Visual conventions in the screenshots

The screenshots already have markup burned in — don't add more, and don't reinterpret it visually.

| Marker | Meaning |
|---|---|
| Solid box | A "small highlight" — a specific field/button/element called out. |
| Jagged/zigzag outline | A "key field highlight" — the person flagged this as especially important. |
| Fine dashed box + arrow + white text box | A "callout" — the arrow points at the real element; the text box is the person's note. The arrow's anchor point on the element (which corner/side it points from) has no meaning beyond where the person dragged it to avoid overlapping something else. |
| Bolder dashed box (no arrow) | A "dropdown flag" — marks the area an open dropdown/menu occupied. There's a second, smaller image (named in the "Dropdown capture:" line, and shown directly below the main screenshot on the same PDF page) showing just that dropdown, captured separately because open dropdowns close if you so much as move the mouse toward normal UI. **That crop image has no border or markup on it at all** — it's an intentionally clean, unmodified image. When building a slide for a highlight with a dropdown capture, show both images together (main screenshot + the dropdown crop as a smaller inset or adjacent image) so the expanded state is visible. |
| Small circle with a number | This highlight has a number — matches `Highlight #N` in the text exactly. |
| Small circle with a blue italic *i* | This highlight has associated Context (the nested `Context:` lines under it). |

Number/context badges and callout/text-annotation boxes can be positioned anywhere around a
highlight (any corner, side, or offset) — their position is chosen by the person and carries no
meaning; don't read significance into it.

## 4. Building the deck

- **One slide per step** by default (screenshot + its highlight callouts as bullets/annotations). If
  the person explicitly asks for multiple highlights split across several slides, or several steps
  merged onto one slide, follow that instead.
- **Slide title**: derived from Page Context (Title / Heading / Breadcrumb), not from a filename and
  not from OCR-style reading of the screenshot.
- **Slide subtitle/caption**: the Overview note, if present.
- **Body**: one bullet or callout per Highlight, in numeric order first, then unlabeled highlights.
  Bullet text = Highlight's Title + Description, with its nested Context folded in as a trailing
  clause or sub-bullet. Weave in Narration where it naturally supports a highlight's bullet, or as a
  short lead-in sentence for the slide if it describes the step as a whole. If a highlight is a
  `key field highlight`, you may bold or otherwise visually emphasize its bullet — a suggestion, not
  a rule.
- **Dropdown crops**: include as a secondary image alongside the main screenshot on that step's
  slide (see §3) — don't drop it, and don't merge it into the main image.
- **Speaker notes** (if the deck format supports them): a good place for Additional Context, the raw
  URL, and any narration that's interesting context but too verbose for the slide body.
- Keep the screenshot(s) as the dominant visual on the slide — don't crop or re-annotate further;
  they already have everything the person marked.
- If a step has no highlights at all (rare), it's likely a pure orientation/context slide — use
  Page Context, Overview, and Narration alone.

## 5. What not to do

- Don't OCR a screenshot to extract text that's already given to you as the notes text — that
  duplicates effort and risks introducing errors the person didn't make.
- Don't run vision over every page of the PDF "just in case" — see §0. Use markitdown for text, and
  reach for vision (or the raw PNGs) only for the specific image you're about to place on a slide.
- Don't invent a narrative connecting steps unless the Overview/Narration or the person's request
  implies one.
- Don't treat the highlight-type distinction, or the presence/absence of a number, as more
  meaningful than described in §2–3 — they're markup conventions, not a priority/severity signal
  (with the soft exception that key-field highlights suggest importance).
- Don't fabricate titles, descriptions, context, or narration for anything marked `(none)` or
  `(untitled — no label detected)`, or for a step with no Narration line at all.
- Don't treat separate PDF parts (`session-part1.pdf`, `session-part2.pdf`, …) as separate sessions
  — they're one session split across files for upload-size reasons only.

## 6. Output

Produce an actual `.pptx` file (not just a description of slides), using whatever slide-creation
capability is available to you in this environment, in this project's predefined slide format if one
has been established in prior conversations or provided as a template — ask the person for their
preferred visual style/template only if none has been indicated yet. Otherwise default to a clean,
minimal layout that keeps the screenshot large and legible.
