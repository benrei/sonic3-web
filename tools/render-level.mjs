// Usage: node tools/render-level.mjs <rom> <zoneIndex> <x> <y> <w> <h> <out.png>
import fs from 'fs';
import { Rom, ZONES } from '../src/rom.js';
import { Level } from '../src/level.js';
import { encodePNG } from './png.mjs';
const [romPath, zi = '0', sx = '0', sy = '0', w = '1024', h = '512', out = '/tmp/level.png'] = process.argv.slice(2);
const rom = new Rom(fs.readFileSync(romPath));
const t0 = Date.now();
const lvl = new Level(rom, ZONES[+zi]);
console.log('loaded in', Date.now() - t0, 'ms', lvl.name, lvl.act, 'size', lvl.fgWidth, 'x', lvl.fgHeight, 'bg', lvl.bgWidth, 'x', lvl.bgHeight, 'chunks', lvl.chunkCount, 'blocks', lvl.blocks.length / 4);
console.log('bounds', lvl.bounds, 'start', lvl.start, 'rings', lvl.rings.length, 'objects', lvl.objects.length);
const pal = lvl.rgbaPalette();
const W = +w, H = +h, X0 = +sx, Y0 = +sy;
const img = new Uint32Array(W * H);
const bgc = pal[0x10 + 0] || 0xff000000; // backdrop colour = palette line... (line 2 index 0 in game)
function drawPlane(bg, prio, scale = 1) {
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const x = Math.floor((X0 + px) * scale), y = Math.floor((Y0 + py) * scale);
    const bw = lvl.blockWord(x, y, bg);
    const block = bw & 0x3ff;
    let bx = x & 15, by = y & 15;
    if (bw & 0x400) bx = 15 - bx;
    if (bw & 0x800) by = 15 - by;
    let pn = lvl.blocks[block * 4 + (by >> 3) * 2 + (bx >> 3)];
    if (((pn >> 15) & 1) !== prio) continue;
    let tx = bx & 7, ty = by & 7;
    if (pn & 0x800) tx = 7 - tx;
    if (pn & 0x1000) ty = 7 - ty;
    const tile = pn & 0x7ff;
    const byte = lvl.vram[tile * 32 + ty * 4 + (tx >> 1)];
    const ci = tx & 1 ? byte & 15 : byte >> 4;
    if (ci) img[py * W + px] = pal[((pn >> 13) & 3) * 16 + ci];
  }
}
img.fill(pal[0x20] | 0xff000000);
const mode = process.env.MODE || "all"; if (mode !== "fg") { drawPlane(true, 0, +(process.env.BGS||0.5)); drawPlane(true, 1, +(process.env.BGS||0.5)); } if (mode !== "bg") { drawPlane(false, 0); drawPlane(false, 1); }
fs.writeFileSync(out, encodePNG(W, H, new Uint8Array(img.buffer)));
console.log('wrote', out);
