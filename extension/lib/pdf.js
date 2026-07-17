// lib/pdf.js
// Minimal, dependency-free PDF writer: one page per capture, each with its
// (already-JPEG-compressed) screenshot followed by a wrapped text block
// (highlight refs/titles/descriptions + narration). No embedded fonts --
// uses the standard Helvetica core font, which every PDF reader ships with
// built in -- and images are stored as raw JPEG bytes (/DCTDecode), so no
// image compression needs implementing here; canvas.toDataURL('image/jpeg')
// already produces a valid JPEG byte stream we can drop straight in.
//
// Loaded as a plain (non-module) script by popup.html, so it just defines
// `createPdfBuilder` as a global.

function createPdfBuilder() {
  const PAGE_W = 612; // US Letter, PDF points (72/in)
  const PAGE_H = 792;
  const MARGIN = 36;

  const objects = []; // objects[i] holds the parts (strings/Uint8Array) for object number i+1
  const pageObjNums = [];
  let bytesSoFar = 0;

  function reserveObject() {
    objects.push(null);
    return objects.length;
  }

  function setObject(num, parts) {
    objects[num - 1] = parts;
    parts.forEach((p) => {
      bytesSoFar += p.length != null ? p.length : String(p).length;
    });
  }

  function escapeText(str) {
    return String(str == null ? "" : str)
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .replace(/[^\x20-\x7e]/g, "?"); // keep printable ASCII only -- no font-encoding surprises
  }

  // Word-wraps to an approximate max character width per line. Helvetica
  // isn't monospace so this overshoots/undershoots slightly, which is fine
  // for notes text -- this isn't meant to be pixel-perfect typesetting.
  function wrapLines(text, maxChars) {
    const out = [];
    String(text || "")
      .split("\n")
      .forEach((paragraph) => {
        if (!paragraph) {
          out.push("");
          return;
        }
        let line = "";
        paragraph.split(" ").forEach((word) => {
          const candidate = line ? line + " " + word : word;
          if (candidate.length > maxChars && line) {
            out.push(line);
            line = word;
          } else {
            line = candidate;
          }
        });
        if (line) out.push(line);
      });
    return out;
  }

  // Adds one page: a JPEG image scaled to fit the top ~60% of the page,
  // with wrapped text lines below it. jpegBytes must be a Uint8Array of a
  // raw JPEG file (e.g. from a data: URL after stripping the base64 header).
  function buildTextBlock(lines, fontSize, leading, top) {
    let s = "BT\n/F1 " + fontSize + " Tf\n" + leading + " TL\n" + MARGIN + " " + top.toFixed(2) + " Td\n";
    lines.forEach((line, i) => {
      if (i > 0) s += "T*\n";
      s += "(" + escapeText(line) + ") Tj\n";
    });
    s += "ET\n";
    return s;
  }

  // A plain text-only page (no image), used for narration/notes overflow
  // that didn't fit below the image on the page it belongs with -- nearly
  // the full page height is available for text here instead of just the
  // space left below an image.
  function addTextOnlyPage(lines, fontSize, leading) {
    const top = PAGE_H - MARGIN;
    const streamBytes = new TextEncoder().encode(buildTextBlock(lines, fontSize, leading, top));

    const contentObjNum = reserveObject();
    setObject(contentObjNum, [contentObjNum + " 0 obj\n<< /Length " + streamBytes.length + " >>\nstream\n", streamBytes, "\nendstream\nendobj\n"]);

    const pageObjNum = reserveObject();
    setObject(pageObjNum, [
      pageObjNum +
        " 0 obj\n<< /Type /Page /Parent PAGES_REF /MediaBox [0 0 " +
        PAGE_W +
        " " +
        PAGE_H +
        "] /Resources << /Font << /F1 FONT_REF >> >> /Contents " +
        contentObjNum +
        " 0 R >>\nendobj\n",
    ]);
    pageObjNums.push(pageObjNum);
  }

  // Adds one or more images (e.g. the main screenshot plus any dropdown
  // crops for that step) to a single page, laid out top-to-bottom, followed
  // by wrapped text lines below the last image. If the text doesn't fit in
  // the remaining space, it continues onto additional (always-portrait)
  // text-only pages instead of being cut off.
  //
  // A wide primary image (e.g. a full-page screenshot) gets a landscape
  // page instead of being shrunk to fit portrait width -- rotating the
  // page, not the image, keeps more of its native resolution readable.
  // Secondary images (dropdown crops) are scaled by the SAME factor as the
  // primary one, so they're drawn at their true size relative to it
  // instead of each being stretched up to fill the page width too.
  function addCapturePages(images, textLines) {
    const primary = images[0];
    const isWide = !!primary && primary.width > 0 && primary.height > 0 && primary.width / primary.height > 1.3;
    const pageW = isWide ? PAGE_H : PAGE_W;
    const pageH = isWide ? PAGE_W : PAGE_H;
    const usableW = pageW - MARGIN * 2;
    const maxTotalImgH = pageH * 0.68;

    let pxToPt = primary && primary.width > 0 ? usableW / primary.width : 1;
    const naturalTotalH = images.reduce((sum, im) => sum + im.height * pxToPt, 0);
    if (naturalTotalH > maxTotalImgH) pxToPt *= maxTotalImgH / naturalTotalH;

    const placements = [];
    let cursorY = pageH - MARGIN;
    images.forEach((im) => {
      const drawW = im.width * pxToPt;
      const drawH = im.height * pxToPt;
      const imgObjNum = reserveObject();
      setObject(imgObjNum, [
        imgObjNum +
          " 0 obj\n<< /Type /XObject /Subtype /Image /Width " +
          im.width +
          " /Height " +
          im.height +
          " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " +
          im.jpegBytes.length +
          " >>\nstream\n",
        im.jpegBytes,
        "\nendstream\nendobj\n",
      ]);
      const imgX = MARGIN + (usableW - drawW) / 2; // centered, so a smaller dropdown crop doesn't stretch edge to edge
      const imgY = cursorY - drawH;
      placements.push({ imgObjNum, imgX, imgY, drawW, drawH });
      cursorY = imgY - 10;
    });

    // Landscape pages are wider, so a bit more text fits per line -- scale
    // the wrap width to match instead of wrapping as if still portrait.
    const maxChars = Math.max(40, Math.round(92 * (usableW / (PAGE_W - MARGIN * 2))));
    const wrapped = [];
    (textLines || []).forEach((block) => {
      wrapLines(block, maxChars).forEach((l) => wrapped.push(l));
      wrapped.push("");
    });

    const fontSize = 9;
    const leading = 12;
    const textTop = cursorY - 10;

    const firstPageMaxLines = Math.max(1, Math.floor((textTop - MARGIN) / leading));
    const contPageMaxLines = Math.max(1, Math.floor((PAGE_H - MARGIN * 2) / leading));
    const firstPageLines = wrapped.slice(0, firstPageMaxLines);
    let remaining = wrapped.slice(firstPageMaxLines);

    let stream = "";
    const xobjectEntries = [];
    placements.forEach((p) => {
      stream += "q\n" + p.drawW.toFixed(2) + " 0 0 " + p.drawH.toFixed(2) + " " + p.imgX.toFixed(2) + " " + p.imgY.toFixed(2) + " cm /Im" + p.imgObjNum + " Do\nQ\n";
      xobjectEntries.push("/Im" + p.imgObjNum + " " + p.imgObjNum + " 0 R");
    });
    stream += buildTextBlock(firstPageLines, fontSize, leading, textTop);
    const streamBytes = new TextEncoder().encode(stream);

    const contentObjNum = reserveObject();
    setObject(contentObjNum, [contentObjNum + " 0 obj\n<< /Length " + streamBytes.length + " >>\nstream\n", streamBytes, "\nendstream\nendobj\n"]);

    const pageObjNum = reserveObject();
    setObject(pageObjNum, [
      pageObjNum +
        " 0 obj\n<< /Type /Page /Parent PAGES_REF /MediaBox [0 0 " +
        pageW +
        " " +
        pageH +
        "] /Resources << /XObject << " +
        xobjectEntries.join(" ") +
        " >> /Font << /F1 FONT_REF >> >> /Contents " +
        contentObjNum +
        " 0 R >>\nendobj\n",
    ]);
    pageObjNums.push(pageObjNum);

    while (remaining.length > 0) {
      const pageLines = remaining.slice(0, contPageMaxLines);
      remaining = remaining.slice(contPageMaxLines);
      addTextOnlyPage(pageLines, fontSize, leading);
    }
  }

  // Kept for compatibility with a single main image and no dropdown crops.
  function addImagePage(jpegBytes, imgWidthPx, imgHeightPx, textLines) {
    addCapturePages([{ jpegBytes, width: imgWidthPx, height: imgHeightPx }], textLines);
  }

  // Approximate running output size in bytes so far -- used to decide when
  // to close out this PDF and start a new part, well before the actual
  // upload-size limit. Doesn't account for the (tiny, KB-scale) xref/trailer
  // overhead added at finish(), which is negligible next to image bytes.
  function currentSize() {
    return bytesSoFar;
  }

  function pageCount() {
    return pageObjNums.length;
  }

  function finish() {
    const fontObjNum = reserveObject();
    setObject(fontObjNum, [fontObjNum + " 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"]);

    const pagesObjNum = reserveObject();
    const kids = pageObjNums.map((n) => n + " 0 R").join(" ");
    setObject(pagesObjNum, [pagesObjNum + " 0 obj\n<< /Type /Pages /Kids [" + kids + "] /Count " + pageObjNums.length + " >>\nendobj\n"]);

    const catalogObjNum = reserveObject();
    setObject(catalogObjNum, [catalogObjNum + " 0 obj\n<< /Type /Catalog /Pages " + pagesObjNum + " 0 R >>\nendobj\n"]);

    // Patch each page's forward references now that we know the real
    // Pages/Font object numbers.
    pageObjNums.forEach((n) => {
      objects[n - 1] = objects[n - 1].map((p) =>
        typeof p === "string" ? p.replace("PAGES_REF", pagesObjNum + " 0 R").replace("FONT_REF", fontObjNum + " 0 R") : p
      );
    });

    const encoder = new TextEncoder();
    const header = encoder.encode("%PDF-1.4\n");
    const byteChunks = [header];
    const offsets = [0]; // object 0 is the free-list head, unused
    let pos = header.length;

    objects.forEach((parts, i) => {
      offsets[i + 1] = pos;
      parts.forEach((p) => {
        const bytes = typeof p === "string" ? encoder.encode(p) : p;
        byteChunks.push(bytes);
        pos += bytes.length;
      });
    });

    // Each xref entry must be EXACTLY 20 bytes: 10-digit offset, space,
    // 5-digit generation, space, keyword, then a 2-byte EOL (CRLF here).
    const xrefStart = pos;
    let xref = "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f\r\n";
    for (let i = 1; i <= objects.length; i++) {
      xref += String(offsets[i]).padStart(10, "0") + " 00000 n\r\n";
    }
    xref += "trailer\n<< /Size " + (objects.length + 1) + " /Root " + catalogObjNum + " 0 R >>\nstartxref\n" + xrefStart + "\n%%EOF";
    byteChunks.push(encoder.encode(xref));

    const total = byteChunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    byteChunks.forEach((c) => {
      out.set(c, offset);
      offset += c.length;
    });
    return out;
  }

  return { addImagePage, addCapturePages, currentSize, pageCount, finish };
}
