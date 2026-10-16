'use strict';

// يولّد أيقونات PNG للـ PWA بلا مكتبات خارجية: خلفية زرقاء ودائرة بيضاء في المنتصف.
// التشغيل: npm run icons

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typeAndData) >>> 0);
  return Buffer.concat([len, typeAndData, crc]);
}

function makePng(size, [r, g, b]) {
  const rowLen = size * 3 + 1;
  const raw = Buffer.alloc(rowLen * size);
  const center = size / 2;
  const innerRadius = size * 0.22;
  const ringOuter = size * 0.36;
  const ringInner = size * 0.3;

  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0; // بلا فلتر
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - center, y + 0.5 - center);
      const white = d <= innerRadius || (d >= ringInner && d <= ringOuter);
      const off = y * rowLen + 1 + x * 3;
      raw[off] = white ? 255 : r;
      raw[off + 1] = white ? 255 : g;
      raw[off + 2] = white ? 255 : b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // عمق البت
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
const brand = [0x0b, 0x6b, 0xcb];
for (const size of [192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, makePng(size, brand));
  console.log(`كتب ${file}`);
}
