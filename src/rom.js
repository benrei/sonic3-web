// ROM map for "Sonic the Hedgehog 3" (W) [MK-1079-00], checksum $3AE0.
// Every address below was located by matching instructions from the public
// disassembly (sonicretro/skdisasm, s3.asm) against the machine code in this ROM,
// e.g. LoadLevelLoadBlock2 does `lea (LevelLoadBlock).l,a2` at $1A788.
import { kosinski, kosinskiModuled, nemesis } from './decomp.js';

export const ADDR = {
  LevelLoadBlock: 0x5ab0c, // 24 bytes per act: PLC/pal ids + 6 art pointers
  Offs_PLC: 0x5af8c, // word offsets to Nemesis pattern load cues
  LevelPtrs: 0x81360, // layout pointer per act
  SolidIndexes: 0x746a0, // collision index pointer per act (primary, +$600 secondary)
  AngleArray: 0x704a0,
  HeightMaps: 0x706a0,
  HeightMapsRot: 0x726a0,
  LevelSizes: 0x1a1f4, // camera bounds, 8 bytes per act
  StartLocations: 0x5e018, // Sonic start x/y per act
  RingLocPtrs: 0x5e198,
  Sprite_Listing: 0x5cc96, // object id -> code pointer
  PalPoint: 0x8bf54, // palette pointer table, 8 bytes per entry
  ArtUnc_Sonic: 0x100000,
  Map_Sonic: 0x140fe0,
  PLC_Sonic: 0x1428ac, // dynamic pattern load cues for Sonic
  AniSonic: 0x13814,
  Map_Ring: 0x190de,
};

export const ART_TILE = {
  SpikesSprings: 0x494,
  Monitors: 0x4c4,
  Explosion: 0x5a0,
  StarPost: 0x5e4,
  Player_1: 0x680,
  Ring: 0x6bc,
  PlayerLifeIcon: 0x7d4,
};

export const ZONES = [
  { id: 0x000, name: 'Angel Island Zone', act: 1, llb: 26 /* post-intro "main level" art set */ },
  { id: 0x001, name: 'Angel Island Zone', act: 2 },
  { id: 0x100, name: 'Hydrocity Zone', act: 1 },
  { id: 0x101, name: 'Hydrocity Zone', act: 2 },
  { id: 0x200, name: 'Marble Garden Zone', act: 1 },
  { id: 0x201, name: 'Marble Garden Zone', act: 2 },
  { id: 0x300, name: 'Carnival Night Zone', act: 1 },
  { id: 0x301, name: 'Carnival Night Zone', act: 2 },
  { id: 0x500, name: 'IceCap Zone', act: 1 },
  { id: 0x501, name: 'IceCap Zone', act: 2 },
  { id: 0x600, name: 'Launch Base Zone', act: 1 },
  { id: 0x601, name: 'Launch Base Zone', act: 2 },
];

export class Rom {
  // Accepts either Sonic 3 (2 MB) or Sonic 3 & Knuckles (4 MB lock-on: S&K at $000000,
  // Sonic 3 at $200000). The Sonic 3 engine always works on the Sonic 3 image (`u8`);
  // for S3&K the whole 4 MB image is kept in `full` (S&K labels from sonic3k.asm address it
  // directly) and `sk` is true.
  constructor(buf) {
    // Always a plain Uint8Array (a Node Buffer's slice() would return a view, not a copy).
    const all = buf instanceof Uint8Array ? new Uint8Array(buf.buffer, buf.byteOffset, buf.length) : new Uint8Array(buf);
    const name = (u8, a) => String.fromCharCode(...u8.subarray(a + 0x150, a + 0x160));
    this.sk = false;
    if (all.length >= 0x400000 && name(all, 0).startsWith('SONIC & KNUCKLES') && name(all, 0x200000).startsWith('SONIC THE')) {
      this.sk = true;
      this.full = all;
      this.u8 = all.subarray(0x200000, 0x400000);
    } else if (all.length >= 0x200000 && name(all, 0).startsWith('SONIC THE')) {
      this.full = null;
      this.u8 = all.subarray(0, 0x200000);
    } else {
      throw new Error('Dette ser ikke ut som Sonic 3 eller Sonic 3 & Knuckles');
    }
    this.checksum = this.u16(0x18e);
  }
  // Readers for the full S3&K image (S&K half + locked-on Sonic 3 half).
  sku8(a) { return this.full[a]; }
  sku16(a) { return (this.full[a] << 8) | this.full[a + 1]; }
  sks16(a) { return (this.sku16(a) << 16) >> 16; }
  sku32(a) { return ((this.full[a] << 24) | (this.full[a + 1] << 16) | (this.full[a + 2] << 8) | this.full[a + 3]) >>> 0; }
  u8at(a) { return this.u8[a]; }
  s8(a) { return (this.u8[a] << 24) >> 24; }
  u16(a) { return (this.u8[a] << 8) | this.u8[a + 1]; }
  s16(a) { return (this.u16(a) << 16) >> 16; }
  u32(a) { return ((this.u8[a] << 24) | (this.u8[a + 1] << 16) | (this.u8[a + 2] << 8) | this.u8[a + 3]) >>> 0; }
  kos(a) { return kosinski(this.u8, a).data; }
  kosm(a) { return kosinskiModuled(this.u8, a); }
  nem(a) { return nemesis(this.u8, a); }

  // Palette entry: 8 bytes -> { src, dest (word index in palette RAM), size in bytes }.
  palette(id) {
    const e = ADDR.PalPoint + id * 8;
    return { src: this.u32(e) & 0xffffff, dest: (this.u16(e + 4) - 0xfc00) / 2, count: (this.u16(e + 6) + 1) * 2 };
  }

  // Pattern load cue: list of { src (Nemesis), vram (byte address) }.
  plc(id) {
    const base = ADDR.Offs_PLC + this.u16(ADDR.Offs_PLC + id * 2);
    const n = this.s16(base) + 1;
    const out = [];
    for (let i = 0; i < n; i++) out.push({ src: this.u32(base + 2 + i * 6), vram: this.u16(base + 6 + i * 6) });
    return out;
  }

  // Sprite mappings (S3K format): per frame, count word then 6-byte pieces.
  mappings(base) {
    const frames = [];
    const n = this.u16(base) / 2;
    for (let f = 0; f < n; f++) {
      const o = base + this.u16(base + f * 2);
      const cnt = this.u16(o);
      const pieces = [];
      for (let i = 0; i < cnt; i++) {
        const p = o + 2 + i * 6;
        const size = this.u8[p + 1];
        pieces.push({ y: this.s8(p), w: ((size >> 2) & 3) + 1, h: (size & 3) + 1, tile: this.u16(p + 2), x: this.s16(p + 4) });
      }
      frames.push(pieces);
    }
    return frames;
  }

  // Dynamic PLCs: per frame list of { tile, count } into an uncompressed art block.
  dplc(base) {
    const frames = [];
    const n = this.u16(base) / 2;
    for (let f = 0; f < n; f++) {
      const o = base + this.u16(base + f * 2);
      const cnt = this.u16(o);
      const req = [];
      for (let i = 0; i < cnt; i++) {
        const w = this.u16(o + 2 + i * 2);
        req.push({ tile: w & 0xfff, count: (w >> 12) + 1 });
      }
      frames.push(req);
    }
    return frames;
  }

  // Animation script table (byte scripts indexed by word offsets).
  animations(base, count) {
    const anims = [];
    for (let i = 0; i < count; i++) {
      const o = base + this.u16(base + i * 2);
      const bytes = [];
      for (let j = 0; j < 128; j++) {
        const b = this.u8[o + j];
        bytes.push(b);
        if (j > 0 && b >= 0xfc) { if (b !== 0xff && b !== 0xfc) bytes.push(this.u8[o + j + 1]); break; }
      }
      anims.push(bytes);
    }
    return anims;
  }
}

// Mega Drive colour (0000BBB0GGG0RRR0) -> [r,g,b] using the VDP's non-linear DAC levels.
const LEVELS = [0, 52, 87, 116, 144, 172, 206, 255];
export function mdColor(w) {
  return [LEVELS[(w >> 1) & 7], LEVELS[(w >> 5) & 7], LEVELS[(w >> 9) & 7]];
}
