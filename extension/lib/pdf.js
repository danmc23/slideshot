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
  function addImagePage(jpegBytes, imgWidthPx, imgHeightPx, textLines) {
    const imgObjNum = reserveObject();
    const usableW = PAGE_W - MARGIN * 2;
    const maxImgH = PAGE_H * 0.6;
    let drawW = usableW;
    let drawH = imgWidthPx > 0 ? drawW * (imgHeightPx / imgWidthPx) : 0;
    if (drawH > maxImgH) {
      drawH = maxImgH;
      drawW = imgHeightPx > 0 ? drawH * (imgWidthPx / imgHeightPx) : usableW;
    }
    const imgX = MARGIN + (usableW - drawW) / 2;
    const imgY = PAGE_H - MARGIN - drawH;

    setObject(imgObjNum, [
      imgObjNum +
        " 0 obj\n<< /Type /XObject /Subtype /Image /Width " +
        imgWidthPx +
        " /Height " +
        imgHeightPx +
        " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " +
        jpegBytes.length +
        " >>\nstream\n",
      jpegBytes,
      "\nendstream\nendobj\n",
    ]);

    const wrapped = [];
    (textLines || []).forEach((block) => {
      wrapLines(block, 92).forEach((l) => wrapped.push(l));
      wrapped.push("");
    });

    const fontSize = 9;
    const leading = 12;
    const textTop = imgY - 20;

    let stream = "q\n";
    stream +=
      drawW.toFixed(2) + " 0 0 " + drawH.toFixed(2) + " " + imgX.toFixed(2) + " " + imgY.toFixed(2) + " cm /Im" + imgObjNum + " Do\n";
    stream += "Q\nBT\n/F1 " + fontSize + " Tf\n" + leading + " TL\n" + MARGIN + " " + textTop.toFixed(2) + " Td\n";
    wrapped.forEach((line, i) => {
      if (i > 0) stream += "T*\n";
      stream += "(" + escapeText(line) + ") Tj\n";
    });
    stream += "ET\n";
    const streamBytes = new TextEncoder().encode(stream);

    const contentObjNum = reserveObject();
    setObject(contentObjNum, [contentObjNum + " 0 obj\n<< /Length " + streamBytes.length + " >>\nstream\n", streamBytes, "\nendstream\nendobj\n"]);

    const pageObjNum = reserveObject();
    setObject(pageObjNum, [
      pageObjNum +
        " 0 obj\n<< /Type /Page /Parent PAGES_REF /MediaBox [0 0 " +
        PAGE_W +
        " " +
        PAGE_H +
        "] /Resources << /XObject << /Im" +
        imgObjNum +
        " " +
        imgObjNum +
        " 0 R >> /Font << /F1 FONT_REF >> >> /Contents " +
        contentObjNum +
        " 0 R >>\nendobj\n",
    ]);
    pageObjNums.push(pageObjNum);
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

  return { addImagePage, currentSize, pageCount, finish };
}
