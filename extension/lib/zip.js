// lib/zip.js
// Minimal STORE-only (uncompressed) ZIP writer -- no external dependencies.
// Sufficient for bundling already-compressed PNGs/PDFs and small text files.
//
// Loaded as a plain (non-module) script by popup.html, so it just defines
// `createZip` as a global.

const HC_ZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function hcZipCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = HC_ZIP_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hcZipDosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, dosDate };
}

function hcZipWriteUint16LE(arr, offset, value) {
  arr[offset] = value & 0xff;
  arr[offset + 1] = (value >>> 8) & 0xff;
}

function hcZipWriteUint32LE(arr, offset, value) {
  arr[offset] = value & 0xff;
  arr[offset + 1] = (value >>> 8) & 0xff;
  arr[offset + 2] = (value >>> 16) & 0xff;
  arr[offset + 3] = (value >>> 24) & 0xff;
}

// files: Array<{ name: string, data: Uint8Array }>
function createZip(files) {
  const encoder = new TextEncoder();
  const now = new Date();
  const { time, dosDate } = hcZipDosDateTime(now);

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = file.data;
    const crc = hcZipCrc32(data);

    const localHeader = new Uint8Array(30);
    hcZipWriteUint32LE(localHeader, 0, 0x04034b50);
    hcZipWriteUint16LE(localHeader, 4, 20); // version needed
    hcZipWriteUint16LE(localHeader, 6, 0); // flags
    hcZipWriteUint16LE(localHeader, 8, 0); // method = store
    hcZipWriteUint16LE(localHeader, 10, time);
    hcZipWriteUint16LE(localHeader, 12, dosDate);
    hcZipWriteUint32LE(localHeader, 14, crc);
    hcZipWriteUint32LE(localHeader, 18, data.length); // compressed size
    hcZipWriteUint32LE(localHeader, 22, data.length); // uncompressed size
    hcZipWriteUint16LE(localHeader, 26, nameBytes.length);
    hcZipWriteUint16LE(localHeader, 28, 0); // extra length

    localParts.push(localHeader, nameBytes, data);

    const localHeaderOffset = offset;
    offset += localHeader.length + nameBytes.length + data.length;

    const centralHeader = new Uint8Array(46);
    hcZipWriteUint32LE(centralHeader, 0, 0x02014b50);
    hcZipWriteUint16LE(centralHeader, 4, 20); // version made by
    hcZipWriteUint16LE(centralHeader, 6, 20); // version needed
    hcZipWriteUint16LE(centralHeader, 8, 0); // flags
    hcZipWriteUint16LE(centralHeader, 10, 0); // method = store
    hcZipWriteUint16LE(centralHeader, 12, time);
    hcZipWriteUint16LE(centralHeader, 14, dosDate);
    hcZipWriteUint32LE(centralHeader, 16, crc);
    hcZipWriteUint32LE(centralHeader, 20, data.length);
    hcZipWriteUint32LE(centralHeader, 24, data.length);
    hcZipWriteUint16LE(centralHeader, 28, nameBytes.length);
    hcZipWriteUint16LE(centralHeader, 30, 0); // extra length
    hcZipWriteUint16LE(centralHeader, 32, 0); // comment length
    hcZipWriteUint16LE(centralHeader, 34, 0); // disk number start
    hcZipWriteUint16LE(centralHeader, 36, 0); // internal attrs
    hcZipWriteUint32LE(centralHeader, 38, 0); // external attrs
    hcZipWriteUint32LE(centralHeader, 42, localHeaderOffset);

    centralParts.push(centralHeader, nameBytes);
  }

  const centralStart = offset;
  let centralSize = 0;
  for (let i = 0; i < centralParts.length; i += 2) {
    centralSize += centralParts[i].length + centralParts[i + 1].length;
  }

  const end = new Uint8Array(22);
  hcZipWriteUint32LE(end, 0, 0x06054b50);
  hcZipWriteUint16LE(end, 4, 0); // disk number
  hcZipWriteUint16LE(end, 6, 0); // disk with central dir
  hcZipWriteUint16LE(end, 8, files.length); // entries on this disk
  hcZipWriteUint16LE(end, 10, files.length); // total entries
  hcZipWriteUint32LE(end, 12, centralSize);
  hcZipWriteUint32LE(end, 16, centralStart);
  hcZipWriteUint16LE(end, 20, 0); // comment length

  const totalSize = centralStart + centralSize + end.length;
  const result = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of [...localParts, ...centralParts, end]) {
    result.set(part, pos);
    pos += part.length;
  }
  return result;
}
