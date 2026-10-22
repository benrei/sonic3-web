// Level loader: mirrors LoadLevelLoadBlock / LoadLevelLoadBlock2 / Load_Level /
// LoadSolids from the original game, but decompresses straight into JS arrays.
import { ADDR, ART_TILE, mdColor } from './rom.js';

export const SPRITES_LOC_PTRS = 0x5e0d8;
const ENEMY_ART_TABLE = 0x2df60; // Offs_LoadEnemyArt

function actIndex(zoneAct) {
  return ((zoneAct >> 8) << 1) | (zoneAct & 1);
}

export class Level {
  constructor(rom, zoneDef) {
    this.rom = rom;
    this.zoneAct = zoneDef.id;
    this.name = zoneDef.name;
    this.act = zoneDef.act;
    const idx = actIndex(zoneDef.id);
    const llbIndex = zoneDef.llb ?? idx;
    const e = ADDR.LevelLoadBlock + llbIndex * 24;
    const p = (o) => rom.u32(e + o) & 0xffffff;
    this.plc1 = rom.u8at(e);
    this.plc2 = rom.u8at(e + 4);
    this.palId = rom.u8at(e + 8);

    // --- VRAM (64KB) with level art at tile 0 ---
    this.vram = new Uint8Array(0x10000);
    const art1 = rom.kosm(p(0));
    this.vram.set(art1, 0);
    if (p(4) !== p(0)) {
      const art2 = rom.kosm(p(4));
      this.vram.set(art2.subarray(0, Math.min(art2.length, 0x10000 - art1.length)), art1.length);
    }
    // Pattern load cues: universal (PLC_01 = rings/monitors/HUD), then level cues.
    // 0x02 = explosion + animals, 0x26 = spikes, springs and diagonal springs.
    for (const id of [0x01, 0x02, 0x26, this.plc1, this.plc2]) this.loadPLC(id);
    // Badnik art (LoadEnemyArt at $2DF3C: KosM pattern load cues per act).
    if (idx < 14) {
      const t = ENEMY_ART_TABLE + rom.u16(ENEMY_ART_TABLE + idx * 2);
      const n = rom.s16(t);
      for (let i = 0; i <= n; i++) {
        const art = rom.kosm(rom.u32(t + 2 + i * 6));
        const v = rom.u16(t + 6 + i * 6);
        this.vram.set(art.subarray(0, Math.max(0, Math.min(art.length, 0x10000 - v))), v);
      }
    }

    // --- 16x16 blocks (4 pattern names each) ---
    let b = rom.kos(p(8));
    if (p(12) !== p(8)) b = concat(b, rom.kos(p(12)));
    this.blocks = toU16(b);
    // --- 128x128 chunks (8x8 block words each) ---
    let c = rom.kos(p(16));
    if (p(20) !== p(16)) c = concat(c, rom.kos(p(20)));
    this.chunks = toU16(c);
    this.chunkCount = (this.chunks.length / 64) | 0;

    // --- layout: $1000 bytes copied to RAM $FFFF8000 ---
    const lp = rom.u32(ADDR.LevelPtrs + idx * 4);
    this.layout = rom.u8.slice(lp, lp + 0x1000);
    const L = this.layout;
    this.fgWidth = (L[0] << 8) | L[1];
    this.bgWidth = (L[2] << 8) | L[3];
    this.fgHeight = (L[4] << 8) | L[5];
    this.bgHeight = (L[6] << 8) | L[7];
    this.widthPx = this.fgWidth * 128;
    this.heightPx = this.fgHeight * 128;
    // Layout_row_index_mask: rows wrap at the next power of two.
    let rows = 1;
    while (rows < this.fgHeight) rows <<= 1;
    this.rowMask = (rows - 1) * 4;
    let bgRows = 1;
    while (bgRows < this.bgHeight) bgRows <<= 1;
    this.bgRowMask = (bgRows - 1) * 4;

    // --- collision ---
    const solid = rom.u32(ADDR.SolidIndexes + idx * 4);
    this.collision = [new Uint16Array(0x300), new Uint16Array(0x300)];
    for (let i = 0; i < 0x300; i++) {
      this.collision[0][i] = rom.u16(solid + i * 2);
      this.collision[1][i] = rom.u16(solid + 0x600 + i * 2);
    }
    this.angles = rom.u8.slice(ADDR.AngleArray, ADDR.AngleArray + 0x200);
    this.heights = new Int8Array(rom.u8.slice(ADDR.HeightMaps, ADDR.HeightMaps + 0x2000).buffer);
    this.heightsRot = new Int8Array(rom.u8.slice(ADDR.HeightMapsRot, ADDR.HeightMapsRot + 0x2000).buffer);

    // --- palette: line 0 = Sonic, lines 1-3 = level ---
    this.palette = new Uint16Array(64);
    this.loadPalette(3);
    this.loadPalette(this.palId);
    this.waterPalette = null;

    // --- camera bounds & start ---
    const ls = ADDR.LevelSizes + idx * 8;
    this.bounds = { minX: rom.s16(ls), maxX: rom.s16(ls + 2), minY: rom.s16(ls + 4), maxY: rom.s16(ls + 6) };
    this.start = { x: rom.u16(ADDR.StartLocations + idx * 4), y: rom.u16(ADDR.StartLocations + idx * 4 + 2) };

    // --- rings & objects ---
    this.rings = [];
    let rp = rom.u32(ADDR.RingLocPtrs + idx * 4);
    for (let i = 0; i < 2000; i++, rp += 4) {
      const x = rom.u16(rp);
      if (x === 0xffff) break;
      const y = rom.u16(rp + 2);
      if (x === 0 && y === 0) continue;
      this.rings.push({ x, y: y & 0xfff, collected: false });
    }
    this.objects = [];
    let op = rom.u32(SPRITES_LOC_PTRS + idx * 4);
    for (let i = 0; i < 2000; i++, op += 6) {
      const x = rom.u16(op);
      if (x === 0xffff) break;
      const yw = rom.u16(op + 2);
      this.objects.push({
        x, y: yw & 0xfff, xflip: (yw >> 13) & 1, yflip: (yw >> 14) & 1,
        id: rom.u8at(op + 4), subtype: rom.u8at(op + 5),
      });
    }
  }

  loadPLC(id) {
    if (!id) return;
    for (const { src, vram } of this.rom.plc(id)) {
      const art = this.rom.nem(src);
      this.vram.set(art.subarray(0, Math.max(0, Math.min(art.length, 0x10000 - vram))), vram);
    }
  }

  loadPalette(id) {
    const { src, dest, count } = this.rom.palette(id);
    for (let i = 0; i < count && dest + i < 64; i++) this.palette[dest + i] = this.rom.u16(src + i * 2);
  }

  rgbaPalette() {
    const out = new Uint32Array(64);
    for (let i = 0; i < 64; i++) {
      const [r, g, b] = mdColor(this.palette[i]);
      out[i] = (i & 15) === 0 ? 0 : ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    }
    return out;
  }

  // Layout lookups (Find_Tile_FG / Find_Tile_BG).
  chunkAt(x, y, bg = false) {
    if (x < 0 || y < 0) return 0;
    const L = this.layout;
    const row = ((y >> 5) & (bg ? this.bgRowMask : this.rowMask)) & ~3;
    const ptrOfs = 8 + row + (bg ? 2 : 0);
    const ptr = ((L[ptrOfs] << 8) | L[ptrOfs + 1]) - 0x8000;
    const width = bg ? this.bgWidth : this.fgWidth;
    let cx = x >> 7;
    if (bg) cx %= width;
    else if (cx >= width) return 0;
    const a = ptr + cx;
    return a >= 0 && a < 0x1000 ? L[a] : 0;
  }

  // 16-bit chunk entry for the 16x16 block containing (x,y): id | flips | solidity.
  blockWord(x, y, bg = false) {
    const c = this.chunkAt(x, y, bg);
    return this.chunks[c * 64 + ((y & 0x70) >> 1) + ((x & 0x70) >> 4)] ?? 0;
  }

  // Simple per-pixel solidity test (used for scattered rings and badniks).
  // path 0 = primary collision ($C top-solid bit), 1 = secondary ($E).
  solidAt(x, y, path = 0, topOnly = true) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.widthPx) return false;
    const bw = this.blockWord(x, y);
    const id = bw & 0x3ff;
    if (!id) return false;
    const bit = path ? 14 : 12;
    if (!((bw >> bit) & 1) && (topOnly || !((bw >> (bit + 1)) & 1))) return false;
    const ci = this.collision[path][id];
    if (!ci) return false;
    let bx = x & 15, by = y & 15;
    if (bw & 0x400) bx = 15 - bx;
    if (bw & 0x800) by = 15 - by;
    const h = this.heights[ci * 16 + bx];
    if (h === 0) return false;
    if (h > 0) return by >= 16 - h;
    return by < -h;
  }
}

function concat(a, b) {
  const o = new Uint8Array(a.length + b.length);
  o.set(a, 0);
  o.set(b, a.length);
  return o;
}
function toU16(u8) {
  const o = new Uint16Array(u8.length >> 1);
  for (let i = 0; i < o.length; i++) o[i] = (u8[i * 2] << 8) | u8[i * 2 + 1];
  return o;
}

export { ART_TILE };
