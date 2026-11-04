// Draws the plugin's PNG icons (no dependencies): node tools/make-icons.js <plugin folder>
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib");

function png(w, h, rgba) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// shapes in a 0..1 unit square: {x,y,w,h,r,color:[r,g,b,a], stroke?}
const hex = (h, a = 1) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), a];
function inRRect(px, py, s) {
  const dx = Math.max(s.x + s.r - px, 0, px - (s.x + s.w - s.r)), dy = Math.max(s.y + s.r - py, 0, py - (s.y + s.h - s.r));
  return dx * dx + dy * dy <= s.r * s.r;
}
function draw(size, shapes) {
  const SS = 4, out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = (x + (sx + 0.5) / SS) / size, py = (y + (sy + 0.5) / SS) / size;
      let c = [0, 0, 0, 0];
      for (const s of shapes) {
        let hit = inRRect(px, py, s);
        if (hit && s.stroke) { const t = s.stroke; hit = !inRRect(px, py, { x: s.x + t, y: s.y + t, w: s.w - 2 * t, h: s.h - 2 * t, r: Math.max(0, s.r - t) }); }
        if (hit) { const a = s.color[3]; c = [s.color[0] * a + c[0] * (1 - a), s.color[1] * a + c[1] * (1 - a), s.color[2] * a + c[2] * (1 - a), a + c[3] * (1 - a)]; }
      }
      // c is premultiplied-ish: colour channels already weighted by alpha
      acc = acc.map((v, i) => v + c[i]);
    }
    const n = SS * SS, a = acc[3] / n;
    const i = (y * size + x) * 4;
    out[i] = a ? Math.round(acc[0] / n / a) : 0; out[i + 1] = a ? Math.round(acc[1] / n / a) : 0;
    out[i + 2] = a ? Math.round(acc[2] / n / a) : 0; out[i + 3] = Math.round(a * 255);
  }
  return png(size, size, out);
}

// a 2x2 grid of keys: one asking (red), one wanting permission (orange), one done (green), one idle
function grid(colors, pad, gap, r, stroke) {
  const k = (1 - 2 * pad - gap) / 2, out = [];
  colors.forEach((c, i) => out.push({ x: pad + (i % 2) * (k + gap), y: pad + Math.floor(i / 2) * (k + gap), w: k, h: k, r, color: c, stroke }));
  return out;
}

const dir = path.join(process.argv[2], "imgs");
fs.mkdirSync(dir, { recursive: true });
const write = (name, size, shapes) => fs.writeFileSync(path.join(dir, name), draw(size, shapes));

const plugin = [{ x: 0, y: 0, w: 1, h: 1, r: 0.2, color: hex("#16171A") },
  ...grid([hex("#D93025"), hex("#E8710A"), hex("#1E7A3A"), hex("#3A3C42")], 0.18, 0.08, 0.06)];
write("plugin.png", 256, plugin); write("plugin@2x.png", 512, plugin);

const mono = grid([hex("#FFFFFF"), hex("#FFFFFF"), hex("#FFFFFF"), hex("#FFFFFF", 0.45)], 0.1, 0.12, 0.08);
write("category.png", 28, mono); write("category@2x.png", 56, mono);
write("action.png", 20, mono); write("action@2x.png", 40, mono);

const key = [{ x: 0, y: 0, w: 1, h: 1, r: 0, color: hex("#000000") },
  ...grid([hex("#3A3C42"), hex("#3A3C42"), hex("#3A3C42"), hex("#3A3C42")], 0.3, 0.06, 0.04)];
write("key.png", 72, key); write("key@2x.png", 144, key);
console.log("icons written to", dir);
