// dur.io: placeholder icons until a brand asset exists (stage 7, D1). The upstream
// `assets` submodule holds the Stoat brand (a trademark), so the fork keeps its own
// generated files in `assets/desktop/` instead. No dependencies; re-run to regenerate:
//
//   node scripts/placeholder-icons.mjs
//
// Writes icon.png / icon.ico (app, tray, installer), iconTemplate.png (macOS tray),
// hicolor/<n>x<n>.png (Flatpak) and badges/<count>.ico (taskbar overlay, -1 = unread dot).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

const OUT = path.join(import.meta.dirname, "..", "assets", "desktop");
const BG = [0x1b, 0x1f, 0x2a];
const FG = [0xff, 0xff, 0xff];
const BADGE = [0xe5, 0x39, 0x35];

/** A lowercase "d" in the unit square, scaled by `s` around the centre */
function inGlyph(x, y, s) {
  x = (x - 0.5) / s + 0.5;
  y = (y - 0.5) / s + 0.5;
  const d = Math.hypot(x - 0.44, y - 0.6);
  const ring = d <= 0.2 && d >= 0.115;
  const stem = x >= 0.555 && x <= 0.64 && y >= 0.2 && y <= 0.8;
  const foot = Math.hypot(x - 0.5975, y - 0.8) <= 0.0425 && y > 0.8;
  return ring || stem || foot;
}

/** Inside a rounded square with corner radius `r` */
function inRound(x, y, r) {
  const qx = Math.max(r - x, 0, x - (1 - r));
  const qy = Math.max(r - y, 0, y - (1 - r));
  return Math.hypot(qx, qy) <= r;
}

// 3x5 digits for the badges
const FONT = {
  0: ["111", "101", "101", "101", "111"],
  1: ["010", "110", "010", "010", "111"],
  2: ["111", "001", "111", "100", "111"],
  3: ["111", "001", "111", "001", "111"],
  4: ["101", "101", "111", "001", "001"],
  5: ["111", "100", "111", "001", "111"],
  6: ["111", "100", "111", "101", "111"],
  7: ["111", "001", "010", "010", "010"],
  8: ["111", "101", "111", "101", "111"],
  9: ["111", "101", "111", "001", "111"],
  "+": ["000", "010", "111", "010", "000"],
};

/** Inside the text `label` drawn centred in the unit square */
function inLabel(x, y, label) {
  const cell = 0.11; // one font pixel
  const width = (label.length * 4 - 1) * cell;
  const left = 0.5 - width / 2;
  const top = 0.5 - 2.5 * cell;
  const col = Math.floor((x - left) / cell);
  const row = Math.floor((y - top) / cell);
  if (row < 0 || row > 4 || col < 0) return false;
  const char = label[Math.floor(col / 4)];
  if (!char || col % 4 === 3) return false;
  return FONT[char][row][col % 4] === "1";
}

/**
 * Render an n×n RGBA image with 4×4 supersampling
 * @param shape (x, y) => [r, g, b] | null (transparent)
 */
function render(n, shape) {
  const SS = 4;
  const px = Buffer.alloc(n * n * 4);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const sum = [0, 0, 0];
      let hits = 0;
      for (let a = 0; a < SS; a++)
        for (let b = 0; b < SS; b++) {
          const colour = shape(
            (i + (a + 0.5) / SS) / n,
            (j + (b + 0.5) / SS) / n,
          );
          if (!colour) continue;
          hits++;
          for (let c = 0; c < 3; c++) sum[c] += colour[c];
        }
      const o = (j * n + i) * 4;
      for (let c = 0; c < 3; c++)
        px[o + c] = hits ? Math.round(sum[c] / hits) : 0;
      px[o + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  return png(n, px);
}

const appIcon = (x, y) =>
  inRound(x, y, 0.22) ? (inGlyph(x, y, 1) ? FG : BG) : null;
const templateIcon = (x, y) => (inGlyph(x, y, 1.25) ? [0, 0, 0] : null);
const badge = (label) => (x, y) =>
  Math.hypot(x - 0.5, y - 0.5) <= 0.5
    ? label && inLabel(x, y, label)
      ? FG
      : BADGE
    : null;

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(n, px) {
  const raw = Buffer.alloc(n * (n * 4 + 1));
  for (let j = 0; j < n; j++)
    px.copy(raw, j * (n * 4 + 1) + 1, j * n * 4, (j + 1) * n * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** An .ico of PNG images, one per size */
function ico(shape, sizes) {
  const images = sizes.map((n) => render(n, shape));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((n, idx) => {
    const entry = 6 + idx * 16;
    header[entry] = n >= 256 ? 0 : n;
    header[entry + 1] = n >= 256 ? 0 : n;
    header.writeUInt16LE(1, entry + 4); // planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(images[idx].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[idx].length;
  });
  return Buffer.concat([header, ...images]);
}

mkdirSync(path.join(OUT, "hicolor"), { recursive: true });
mkdirSync(path.join(OUT, "badges"), { recursive: true });

writeFileSync(path.join(OUT, "icon.png"), render(512, appIcon));
writeFileSync(
  path.join(OUT, "icon.ico"),
  ico(appIcon, [16, 24, 32, 48, 64, 128, 256]),
);
writeFileSync(path.join(OUT, "iconTemplate.png"), render(32, templateIcon));
for (const n of [16, 32, 64, 128, 256, 512])
  writeFileSync(path.join(OUT, "hicolor", `${n}x${n}.png`), render(n, appIcon));

writeFileSync(path.join(OUT, "badges", "-1.ico"), ico(badge(""), [16, 32]));
for (let count = 1; count <= 10; count++)
  writeFileSync(
    path.join(OUT, "badges", `${count}.ico`),
    ico(badge(count < 10 ? String(count) : "9+"), [16, 32]),
  );
