// Small software "VDP": composes the two scroll planes and sprites into a
// 320x224 RGBA framebuffer with the Mega Drive's priority rules
// (backdrop < low planes < low sprites < high planes < high sprites).
import { mdColor } from './rom.js';

export const SCREEN_W = 320;
export const SCREEN_H = 224;

export class VDP {
  constructor(level) {
    this.level = level;
    this.vram = level.vram;
    this.pixels = new Uint8Array(0x800 * 64); // decoded 4bpp tiles
    this.decodeAll();
    this.frame = new Uint32Array(SCREEN_W * SCREEN_H);
    this.palRGBA = new Uint32Array(64);
    this.updatePalette();
    this.sprites = [];
    this.backdrop = 0x20; // palette line 2 colour 0 (VDP register 7 in levels)
  }

  decodeAll() { for (let t = 0; t < 0x800; t++) this.decodeTile(t); }
  decodeTile(t) {
    const v = this.vram, p = this.pixels;
    const s = t * 32, d = t * 64;
    for (let i = 0; i < 32; i++) {
      const b = v[s + i];
      p[d + i * 2] = b >> 4;
      p[d + i * 2 + 1] = b & 15;
    }
  }
  // Write bytes into VRAM (like a DMA) and refresh decoded tiles.
  writeVram(addr, data) {
    if (addr < 0 || addr >= 0x10000) return;
    this.vram.set(data.subarray(0, Math.min(data.length, 0x10000 - addr)), addr);
    const t0 = addr >> 5, t1 = (addr + data.length - 1) >> 5;
    for (let t = t0; t <= t1 && t < 0x800; t++) this.decodeTile(t);
  }

  updatePalette() {
    const pal = this.level.palette;
    for (let i = 0; i < 64; i++) {
      const [r, g, b] = mdColor(pal[i]);
      this.palRGBA[i] = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
  }

  // Draw one plane. hscroll(line) -> plane x of the screen's left edge,
  // vscroll -> plane y of the top line. Only pixels whose pattern priority == prio.
  drawPlane(bg, prio, hscroll, vscroll) {
    const L = this.level, frame = this.frame, pix = this.pixels, pal = this.palRGBA;
    const blocks = L.blocks;
    const wrapW = bg ? L.bgWidth * 128 : 0;
    for (let sy = 0; sy < SCREEN_H; sy++) {
      const py = vscroll(sy);
      if (py < 0) continue;
      let px = hscroll(sy) | 0;
      const rowBase = sy * SCREEN_W;
      let sx = 0;
      while (sx < SCREEN_W) {
        let x = px + sx;
        if (bg && wrapW) x = ((x % wrapW) + wrapW) % wrapW;
        const span = 8 - (x & 7);
        if (x < 0 || (!bg && x >= L.widthPx)) { sx += span; continue; }
        const bw = L.blockWord(x, py, bg);
        let bx = x & 15, by = py & 15;
        if (bw & 0x400) bx = 15 - bx;
        if (bw & 0x800) by = 15 - by;
        const pn = blocks[((bw & 0x3ff) << 2) + ((by >> 3) << 1) + (bx >> 3)];
        if (((pn >> 15) & 1) === prio && pn !== undefined) {
          const flipH = ((pn >> 11) & 1) ^ ((bw >> 10) & 1);
          let ty = by & 7;
          if (pn & 0x1000) ty = 7 - ty;
          const tbase = (pn & 0x7ff) * 64 + ty * 8;
          const pbase = ((pn >> 13) & 3) << 4;
          // pixels within this 8px cell, walking in screen order
          let cx = x & 7;
          for (let i = 0; i < span && sx + i < SCREEN_W; i++, cx++) {
            // position inside the block's 8px half, accounting for block flip
            let lx = (bw & 0x400) ? 7 - (cx & 7) : (cx & 7);
            if (pn & 0x800) lx = 7 - lx;
            const c = pix[tbase + lx];
            if (c) frame[rowBase + sx + i] = pal[pbase + c];
          }
          void flipH;
        }
        sx += span;
      }
    }
  }

  // Queue a mapped sprite. pieces from Rom.mappings(); artTile = object's art_tile word.
  addSprite(pieces, sx, sy, artTile, flipX = false, flipY = false, order = 0x200) {
    this.sprites.push({ pieces, sx, sy, artTile, flipX, flipY, order });
  }

  drawSprites(prio) {
    // lower "order" value is drawn in front, like the priority field of objects
    const list = this.sprites;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      const pieces = s.pieces;
      for (let j = pieces.length - 1; j >= 0; j--) {
        const p = pieces[j];
        const word = (p.tile + s.artTile) & 0xffff;
        if (((word >> 15) & 1) !== prio) continue;
        this.drawPiece(p, word, s);
      }
    }
  }

  drawPiece(p, word, s) {
    const frame = this.frame, pix = this.pixels, pal = this.palRGBA;
    const hf = ((word >> 11) & 1) ^ (s.flipX ? 1 : 0);
    const vf = ((word >> 12) & 1) ^ (s.flipY ? 1 : 0);
    const w = p.w * 8, h = p.h * 8;
    const ox = s.flipX ? -p.x - w : p.x;
    const oy = s.flipY ? -p.y - h : p.y;
    const x0 = s.sx + ox, y0 = s.sy + oy;
    if (x0 >= SCREEN_W || y0 >= SCREEN_H || x0 + w <= 0 || y0 + h <= 0) return;
    const tile0 = word & 0x7ff;
    const pbase = ((word >> 13) & 3) << 4;
    for (let yy = 0; yy < h; yy++) {
      const sy = y0 + yy;
      if (sy < 0 || sy >= SCREEN_H) continue;
      const ly = vf ? h - 1 - yy : yy;
      for (let xx = 0; xx < w; xx++) {
        const sx = x0 + xx;
        if (sx < 0 || sx >= SCREEN_W) continue;
        const lx = hf ? w - 1 - xx : xx;
        const t = (tile0 + (lx >> 3) * p.h + (ly >> 3)) & 0x7ff;
        const c = pix[t * 64 + (ly & 7) * 8 + (lx & 7)];
        if (c) frame[sy * SCREEN_W + sx] = pal[pbase + c];
      }
    }
  }

  render(fgX, fgY, bgH, bgV) {
    this.frame.fill(this.palRGBA[this.backdrop]);
    const fgH = () => fgX, fgV = (y) => fgY + y;
    this.sprites.sort((a, b) => a.order - b.order);
    this.drawPlane(true, 0, bgH, bgV);
    this.drawPlane(false, 0, fgH, fgV);
    this.drawSprites(0);
    this.drawPlane(true, 1, bgH, bgV);
    this.drawPlane(false, 1, fgH, fgV);
    this.drawSprites(1);
    this.sprites.length = 0;
  }
}
