// Draw the toolbar/store icons (rounded square + bookmark ribbon) and write PNGs to static/icons/.
// Run once with `npm run gen:icons`; the PNGs are committed.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'icons');
const BG = [37, 99, 235];
const FG = [255, 255, 255];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shapes in unit coordinates (0..1).
function inRoundedSquare(x, y) {
  const r = 0.22;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function inRibbon(x, y) {
  const left = 0.3, right = 0.7, top = 0.18, bottom = 0.84, notch = 0.66;
  if (x < left || x > right || y < top || y > bottom) return false;
  const mid = (left + right) / 2;
  const half = (right - left) / 2;
  // V-shaped cut at the bottom: from (left,bottom) up to (mid,notch) down to (right,bottom).
  const cutY = notch + ((bottom - notch) * Math.abs(x - mid)) / half;
  return y <= cutY;
}

function draw(size) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0, fg = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          if (!inRoundedSquare(x, y)) continue;
          if (inRibbon(x, y)) fg++;
          else bg++;
        }
      }
      const total = ss * ss;
      const alpha = (bg + fg) / total;
      const i = (py * size + px) * 4;
      if (alpha === 0) continue;
      for (let c = 0; c < 3; c++) buf[i + c] = Math.round((BG[c] * bg + FG[c] * fg) / (bg + fg));
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return png(size, buf);
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(outDir, `icon-${size}.png`), draw(size));
  console.log(`icon-${size}.png`);
}
