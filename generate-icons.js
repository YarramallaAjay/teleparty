#!/usr/bin/env node
/**
 * generate-icons.js
 * Creates PNG icon files for the MovieParty extension.
 * Pure Node.js — no npm packages required.
 *
 * Usage:  node generate-icons.js
 * Output: extension/icons/icon16.png
 *         extension/icons/icon48.png
 *         extension/icons/icon128.png
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ─── CRC-32 ────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ─── Minimal PNG encoder ───────────────────────────────────────────────────

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([len, typeBytes, data, crc]);
}

function encodePNG(width, height, pixelFn) {
  // Build raw RGBA rows  (filter byte 0 = None before each row)
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0; // filter
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      raw[row + 1 + x * 4]     = r;
      raw[row + 1 + x * 4 + 1] = g;
      raw[row + 1 + x * 4 + 2] = b;
      raw[row + 1 + x * 4 + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  // compression=0, filter=0, interlace=0

  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ─── Icon design: dark bg + red rounded square + white clapperboard ────────

function moviePartyPixel(x, y, w, h) {
  const cx = w / 2, cy = h / 2;
  const dx = x - cx + 0.5, dy = y - cy + 0.5; // center offset

  // Rounded square — outer background
  const squareR = w * 0.42;
  const cornerR = w * 0.18;

  function inRoundRect(px, py, hw, hh, cr) {
    const ax = Math.abs(px) - hw + cr;
    const ay = Math.abs(py) - hh + cr;
    return Math.sqrt(Math.max(ax, 0) ** 2 + Math.max(ay, 0) ** 2) + Math.min(Math.max(ax, ay), 0) <= cr;
  }

  const inBg = inRoundRect(dx, dy, squareR, squareR, cornerR);
  if (!inBg) return [0, 0, 0, 0]; // transparent outside

  // Background gradient: deep dark
  const t = (y / h);
  const bgR = Math.round(15 + t * 12);
  const bgG = Math.round(15 + t * 8);
  const bgB = Math.round(26 + t * 16);

  // Red accent rectangle (video screen shape)
  const screenL = -squareR * 0.5;
  const screenR =  squareR * 0.35;
  const screenT = -squareR * 0.28;
  const screenB =  squareR * 0.32;
  const inScreen = dx >= screenL && dx <= screenR && dy >= screenT && dy <= screenB;

  if (inScreen) {
    // Red gradient screen
    const st = (dy - screenT) / (screenB - screenT);
    const r  = Math.round(229 - st * 30);
    const g  = Math.round(9);
    const b  = Math.round(20 + st * 10);
    return [r, g, b, 255];
  }

  // Play triangle (white) inside the screen area
  const triCx = (screenL + screenR) / 2 - squareR * 0.04;
  const triH  = (screenB - screenT) * 0.55;
  const triRelX = dx - triCx;
  const triRelY = dy - (screenT + screenB) / 2;
  // Point right triangle
  const inTri = triRelX >= -triH * 0.5 && triRelX <= triH * 0.55
    && Math.abs(triRelY) <= (triH * 0.5 - triRelX * 0.5);
  if (inTri) return [255, 255, 255, 240];

  // Camera lens (right side)
  const lensCx = squareR * 0.55;
  const lensR  = squareR * 0.18;
  const distLens = Math.sqrt((dx - lensCx) ** 2 + dy ** 2);
  if (distLens < lensR) {
    const lt = distLens / lensR;
    return [Math.round(200 - lt * 60), Math.round(200 - lt * 60), Math.round(220 - lt * 80), 255];
  }
  // Lens ring
  if (distLens < lensR + w * 0.02) return [80, 80, 100, 255];

  return [bgR, bgG, bgB, 255];
}

// ─── Generate & write ──────────────────────────────────────────────────────

const outDir = path.join(__dirname, 'extension', 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const png = encodePNG(size, size, moviePartyPixel);
  const out = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(out, png);
  process.stdout.write(`✓  icon${size}.png  (${png.length} bytes)\n`);
}

console.log('\nIcons written to extension/icons/\n');
