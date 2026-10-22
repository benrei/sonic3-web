// Render all frames of a mapping table: node tools/sheet.mjs rom map artTile [dplcArt dplcTable dplcKind] out.png
import fs from 'fs';
import { Rom, ZONES } from '../src/rom.js';
import { Level } from '../src/level.js';
import { VDP } from '../src/vdp.js';
import { encodePNG } from './png.mjs';
const [romPath, mapA, artA, dArt, dTab, dKind, out = '/tmp/sheet.png', zone = '0'] = process.argv.slice(2);
const rom = new Rom(fs.readFileSync(romPath));
const lvl = new Level(rom, ZONES[+zone]);
const vdp = new VDP(lvl);
const frames = rom.mappings(parseInt(mapA, 16)).slice(+(process.env.F0||0), +(process.env.F1||9999));
const art = parseInt(artA, 16);
const cell = 64, cols = 8, rows = Math.ceil(frames.length / cols);
const W = cols * cell, H = rows * cell;
const img = new Uint32Array(W * H).fill(0xff404040);
frames.forEach((pieces, f) => {
  if (dArt && dArt !== '-') {
    const a = parseInt(dArt, 16), t = parseInt(dTab, 16);
    const o = t + rom.u16(t + (f + +(process.env.F0||0)) * 2);
    let vaddr = (art & 0x7ff) * 32;
    if (dKind === 'player') {
      const n = rom.u16(o);
      for (let i = 0; i < n; i++) { const w = rom.u16(o + 2 + i * 2); const cnt = (w >> 12) + 1; vdp.writeVram(vaddr, rom.u8.subarray(a + (w & 0xfff) * 32, a + ((w & 0xfff) + cnt) * 32)); vaddr += cnt * 32; }
    } else {
      const n = rom.u16(o) + 1;
      for (let i = 0; i < n; i++) { const w = rom.u16(o + 2 + i * 2); const cnt = (w & 15) + 1; vdp.writeVram(vaddr, rom.u8.subarray(a + (w >> 4) * 32, a + ((w >> 4) + cnt) * 32)); vaddr += cnt * 32; }
    }
  }
  vdp.frame.fill(0xff404040);
  vdp.addSprite(pieces, 160, 112, art);
  vdp.drawSprites(0); vdp.drawSprites(1); vdp.sprites.length = 0;
  const cx = (f % cols) * cell, cy = Math.floor(f / cols) * cell;
  for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) img[(cy + y) * W + cx + x] = vdp.frame[(112 - 32 + y) * 320 + 160 - 32 + x];
  for (let x = 0; x < cell; x++) img[cy * W + cx + x] = 0xff000000;
});
fs.writeFileSync(out, encodePNG(W, H, new Uint8Array(img.buffer)));
console.log(frames.length, 'frames ->', out);
