// Animated level art and palette cycling for the Sonic 3 acts, ported from the original:
//   Animate_Init ($278B6), Animate_Tiles ($26A94) with the per-act AnimateTiles_* routines
//   (incl. the BG-scroll driven parallax strip art of HCZ2 / CNZ / ICZ / LBZ and the HCZ1 /
//   LBZ2 waterline art built in RAM), AnimateTiles_DoAniPLC ($275EC) for the AniPLC scripts,
//   and Animate_Palette / AnPal_Load ($23F4) with the per-act AnPal_* cycles.
// All counters live in the emulated RAM at their original addresses (Anim_Counters,
// Palette_cycle_counter0/1, Palette_cycle_counters), so code elsewhere that pokes them
// (Obj_LBZAlarm -> Anim_Counters+4, the LBZ2 Death Egg launch -> Anim_Counters+$F, the
// HCZ fans -> Palette_cycle_counters+0, ...) drives the same branches as in the original.
// Add_To_DMA_Queue is done immediately (the transfer happens in the next V-int, i.e. before
// this frame is displayed, which is when render() runs here).
import { R, s16, u16 } from './ram.js';

const OFFS_ANIFUNC = 0x26ab2; // Offs_AniFunc: [AnimateTiles_* offset, AniPLC_* offset] per act

// RAM variables (sonic3k.constants.asm) not in ram.js's table
const RAM = {
  Palette_cycle_counter0: 0xfff632,
  Palette_cycle_counter1: 0xfff634,
  Palette_cycle_counters: 0xfff650, // $C bytes
  AIZ1_palette_cycle_flag: 0xfff72e,
  Boss_flag: 0xfff7aa,
};
const AC = R.Anim_Counters;
const PCC = RAM.Palette_cycle_counters;

// ROM addresses (from the operands of the referencing instructions)
const A = {
  ArtUnc_AniAIZ2_FirstTree: 0xa5880,
  HCZ_WaterlineScroll_Data: 0x6d000,
  ArtUnc_AniHCZ1_WaterlineBelow: 0xa6a60,
  ArtUnc_AniHCZ1_WaterlineBelow2: 0xa7060,
  ArtUnc_AniHCZ1_WaterlineAbove: 0xa6d60,
  ArtUnc_AniHCZ1_WaterlineAbove2: 0xa7360,
  ArtUnc_FixHCZ1_UpperBG1: 0xa6be0,
  ArtUnc_FixHCZ1_UpperBG2: 0xa71e0,
  ArtUnc_FixHCZ1_LowerBG1: 0xa6ee0,
  ArtUnc_FixHCZ1_LowerBG2: 0xa74e0,
  AniPLC_HCZ1: 0x276f8,
  ArtUnc_AniHCZ2_SmallBGLine: 0xa87a0,
  ArtUnc_AniHCZ2_2: 0xa8ba0,
  ArtUnc_AniHCZ2_3: 0xa93a0,
  ArtUnc_AniHCZ2_4: 0xaa3a0,
  ArtUnc_AniCNZ__6: 0xb5b80,
  ArtUnc_AniICZ__1: 0xb8580,
  ArtUnc_AniICZ__2: 0xb9580,
  ArtUnc_AniICZ__3: 0xb9780,
  ArtUnc_AniICZ__4: 0xb9880,
  ArtUnc_AniICZ__5: 0xb9900,
  ArtUnc_AniLBZ__0: 0xbc340,
  ArtUnc_AniLBZ1_1: 0xba240,
  ArtUnc_AniLBZ1_2: 0xbb640,
  AniPLC_LBZSpec: 0x2782a,
  ArtUnc_AniLBZ2_2: 0xbb740,
  LBZ_WaterlineScroll_Data: 0x6f460,
  ArtUnc_AniLBZ2_WaterlineBelow: 0xbbb40,
  ArtUnc_AniLBZ2_WaterlineAbove: 0xbbf40,
  ArtUnc_AniLBZ2_LowerBG: 0xbbd40,
  ArtUnc_AniLBZ2_UpperBG: 0xbc140,
  // palette cycle tables
  AnPal_PalAIZ1_1: 0x291a, AnPal_PalAIZ1_3: 0x293a, AnPal_PalAIZ1_4: 0x29ba, AnPal_PalAIZ1_2: 0x2a1a,
  AnPal_PalAIZ2_1: 0x2a4a, AnPal_PalAIZ2_2: 0x2a6a, AnPal_PalAIZ2_3: 0x2a9a,
  AnPal_PalAIZ2_4: 0x2aca, AnPal_PalAIZ2_5: 0x2afe,
  AnPal_PalHCZ1: 0x2b32,
  AnPal_PalCNZ_1: 0x2b52, AnPal_PalCNZ_3: 0x2bb2, AnPal_PalCNZ_5: 0x2c66,
  AnPal_PalCNZ_2: 0x2ca6, AnPal_PalCNZ_4: 0x2d06,
  AnPal_PalICZ_1: 0x2dfa, AnPal_PalICZ_2: 0x2e3a, AnPal_PalICZ_3: 0x2e82, AnPal_PalICZ_4: 0x2e9a,
  AnPal_PalLBZ1: 0x2eda, AnPal_PalLBZ2: 0x2eec,
};

// parallax strip DMA split tables (word_26DF2 / word_26E5E / word_26ECA / word_26F46 /
// word_26FD6 / word_26FF6 / word_2721A): [first transfer, second transfer] lengths in words
const W26DF2 = [0x40, 0, 0x30, 0x10, 0x20, 0x20, 0x10, 0x30];
const W26E5E = [0x80, 0, 0x60, 0x20, 0x40, 0x40, 0x20, 0x60];
const W26ECA = [0x100, 0, 0xc0, 0x40, 0x80, 0x80, 0x40, 0xc0];
const W26F46 = [0x300, 0, 0x2a0, 0x60, 0x240, 0xc0, 0x1e0, 0x120, 0x180, 0x180, 0x120, 0x1e0, 0xc0, 0x240, 0x60, 0x2a0];
const W26FD6 = [0x200, 0, 0x1c0, 0x40, 0x180, 0x80, 0x140, 0xc0, 0x100, 0x100, 0xc0, 0x140, 0x80, 0x180, 0x40, 0x1c0];
const W26FF6 = [0x100, 0, 0xc0, 0x40, 0x80, 0x80, 0x40, 0xc0];
const W2721A = [0x140, 0, 0xf0, 0x50, 0xa0, 0xa0, 0x50, 0xf0];

const tiles = (t) => t * 32; // tiles_to_bytes

export class TileAnimator {
  constructor(rom, level, vdp, actIdx, game = null) {
    this.rom = rom;
    this.vdp = vdp;
    this.level = level;
    this.game = game;
    this.actIdx = actIdx;
    this.zoneAct = ((actIdx >> 1) << 8) | (actIdx & 1);
    this.func = null;
    this.aniPLC = 0;
    if (actIdx < 14) {
      this.func = rom.u16(OFFS_ANIFUNC + actIdx * 4);
      this.aniPLC = OFFS_ANIFUNC + rom.s16(OFFS_ANIFUNC + actIdx * 4 + 2);
    }
    this.buf = new Uint8Array(0x400); // Chunk_table+$7C00 / +$7E00 scratch for the waterline art
    this.initRam = null;
    this.ownRam = null;
    this.fadeTimer = 0x16; // Palette_fade_timer: no palette cycling while the level fades in
    this.palDirty = false;
  }

  get m() {
    const r = this.game?.ram;
    if (r) return r;
    if (!this.ownRam) {
      // standalone use without a Game (tools): private RAM
      this.ownRam = { u8: new Uint8Array(0x10000) };
      const u8 = this.ownRam.u8;
      Object.assign(this.ownRam, {
        ub: (a) => u8[a & 0xffff], b: (a) => (u8[a & 0xffff] << 24) >> 24,
        uw: (a) => (u8[a & 0xffff] << 8) | u8[(a + 1) & 0xffff], w: (a) => s16((u8[a & 0xffff] << 8) | u8[(a + 1) & 0xffff]),
        setB: (a, v) => { u8[a & 0xffff] = v; }, setW: (a, v) => { u8[a & 0xffff] = v >> 8; u8[(a + 1) & 0xffff] = v; },
        addW: (a, v) => { this.ownRam.setW(a, this.ownRam.w(a) + v); return this.ownRam.w(a); },
      });
    }
    return this.ownRam;
  }

  // Per-frame entry kept for compatibility: palette cycling (Animate_Palette runs at the start
  // of LevelLoop). Animate_Tiles runs later in the frame, after ScreenEvents (animateTiles()).
  update() {
    this.animatePalette();
    if (!this.game) this.animateTiles();
  }

  // ---------------------------------------------------------------- DMA helpers
  dma(src, dst, words) {
    const n = words * 2;
    if (src instanceof Uint8Array) this.vdp.writeVram(dst, src.subarray(0, n));
    else this.vdp.writeVram(dst, this.rom.u8.subarray(src, src + n));
  }

  // ---------------------------------------------------------------- Animate_Init
  animateInit() {
    const m = this.m, za = this.zoneAct;
    if (za === 0x100) this.sub_26D0E();
    if (za === 0x101) { m.setB(AC + 1, 0x20); m.setB(AC + 3, 0x40); }
    if (za >> 8 === 3) {
      m.setB(AC + 1, 0x40); m.setB(AC + 2, 0); m.setB(AC + 4, 0); m.setB(AC + 6, 0);
      m.setB(AC + 8, 2); m.setB(AC + 0xa, 2); m.setB(AC + 0xc, 2); m.setB(AC + 0xe, 1);
    }
    if (za === 0x600) m.setB(AC + 3, 0x20);
    if (za === 0x601) { this.sub_273B4(); m.setB(AC + 1, 0x10); }
  }

  // ---------------------------------------------------------------- Animate_Tiles
  // Level init (after LevelSetup, i.e. with the BG init's Events_bg values): Animate_Init,
  // then the Animate_Tiles call at the end of level init.
  levelInit() {
    this.fadeTimer = 0x16;
    if (this.func === null) return;
    const m = this.m;
    this.initRam = m;
    for (let i = 0; i < 0x10; i++) m.setB(AC + i, 0);
    this.animateInit();
    this.runAnimateTiles();
  }

  animateTiles() {
    if (this.func === null) return;
    if (this.initRam !== this.m) this.levelInit(); // RAM replaced without levelInit()
    this.runAnimateTiles();
  }

  runAnimateTiles() {
    switch (this.actIdx) {
      case 0: return this.aiz1();
      case 1: return this.aiz2();
      case 2: return this.hcz1();
      case 3: return this.hcz2();
      case 4: case 5: return this.mgz();
      case 6: case 7: return this.cnz();
      case 10: case 11: return this.icz();
      case 12: return this.lbz1();
      case 13: return this.lbz2();
      default: return undefined; // AnimateTiles_NULL (FBZ)
    }
  }

  // AnimateTiles_DoAniPLC: a3 = Anim_Counters
  doAniPLC(a2 = this.aniPLC, a3 = AC) {
    return this.loc_275F0(a2, a3);
  }
  // loc_275F0: d6 = script count - 1 from (a2)+
  loc_275F0(a2, a3) {
    const d6 = this.rom.s16(a2);
    return this.part2(a2 + 2, a3, d6);
  }
  // AnimateTiles_DoAniPLC_Part2
  part2(a2, a3, d6) {
    const m = this.m, rom = this.rom;
    for (; d6 >= 0; d6--) {
      const t = m.ub(a3);
      m.setB(a3, t - 1);
      if (t === 0) { // subq.b borrowed: frame over
        let d0 = m.ub(a3 + 1);
        if (d0 >= rom.u8at(a2 + 6)) { d0 = 0; m.setB(a3 + 1, 0); }
        m.setB(a3 + 1, m.ub(a3 + 1) + 1);
        const dur = rom.u8at(a2);
        m.setB(a3, dur);
        if (dur & 0x80) { d0 += d0; m.setB(a3, rom.u8at(a2 + 9 + d0)); }
        const tile = rom.u8at(a2 + 8 + d0);
        const src = (rom.u32(a2) & 0xffffff) + (tile << 5);
        this.dma(src, rom.u16(a2 + 4), rom.u8at(a2 + 7) << 4);
      }
      let d0 = rom.u8at(a2 + 6);
      if (rom.u8at(a2) & 0x80) d0 = (d0 + d0) & 0xff;
      d0 = ((d0 + 1) & 0xff) & 0xfe;
      a2 += 8 + d0;
      a3 += 2;
    }
    return { a2, a3 };
  }

  // Shared "strip" transfer used by the parallax art routines: first DMA of table[i] words
  // from art+d1 to d4, d4 += 2*len, second DMA of table[i+1] words from art+d5 (if non-zero).
  // Returns the advanced d4 (only advanced by the second length where the original does so).
  strip(art, d1, d5, table, idx, d4, advanceSecond = false) {
    let len = table[idx];
    this.dma(art + d1, d4, len);
    d4 = u16(d4 + len * 2);
    len = table[idx + 1];
    if (len) {
      const d2 = d4;
      if (advanceSecond) d4 = u16(d4 + len * 2);
      this.dma(art + d5, d2, len);
    }
    return d4;
  }

  // ---------------------------------------------------------------- AIZ
  // AnimateTiles_AIZ1: scripts only run once the intro is over (Dynamic_resize_routine != 0)
  aiz1() {
    const m = this.m;
    if (m.ub(RAM.Boss_flag)) return;
    if (m.ub(R.Dynamic_resize_routine)) this.doAniPLC();
  }

  // AnimateTiles_AIZ2: left of camera X $1C0 only the first script (waterfall) runs and the
  // first tree's art is kept loaded at tile $0CA (where the other scripts' art would go)
  aiz2() {
    const m = this.m;
    if (m.ub(RAM.Boss_flag)) return;
    if (m.uw(R.Camera_X_pos) >= 0x1c0) { this.doAniPLC(); return; }
    const { a3 } = this.part2(this.aniPLC + 2, AC, 0);
    m.setW(a3, 0); m.setW(a3 + 2, 0); // clr.l (a3)
    this.dma(A.ArtUnc_AniAIZ2_FirstTree, tiles(0x0ca), 0x230);
  }

  // ---------------------------------------------------------------- HCZ1
  // AnimateTiles_HCZ1: waterline extending into the background. Events_bg+$10 is the BG
  // waterline's distance from the camera (set by the HCZ1 BG deformation).
  hcz1() {
    if (this.m.ub(R.Events_bg + 0x16)) return;
    this.loc_26BC6(AC + 4);
  }

  loc_26BC6(a3) {
    const m = this.m;
    const d1 = m.w(R.Events_bg + 0x10);
    if (d1 === m.w(a3)) { this.doAniPLC(); return; }
    m.setW(a3, d1);
    if (d1 === 0) { this.loc_26CB8(a3); return; }
    if (d1 < 0) {
      const v = u16(d1) + 0x60;
      if (v > 0xffff) { // carry
        this.hczWaterline(v & 0xffff, A.ArtUnc_AniHCZ1_WaterlineBelow, tiles(0x2dc));
        if (m.w(a3 + 2) >= 0) { m.setW(a3 + 2, -1); this.aniHCZ_FixLowerBG(); }
      }
    } else {
      const v = u16(-d1) + 0x60;
      if (v > 0xffff) {
        this.hczWaterline(v & 0xffff, A.ArtUnc_AniHCZ1_WaterlineAbove, tiles(0x2f4));
        if (m.w(a3 + 2) !== 0) { m.setW(a3 + 2, 0); this.aniHCZ_FixUpperBG(); }
      }
    }
    this.doAniPLC(); // loc_26CB4
  }

  // loc_26C00 / loc_26C6E: build $60 columns of 2 tile rows from the per-line scroll data
  hczWaterline(d1, art, vram) {
    const rom = this.rom, buf = this.buf;
    let a5 = A.HCZ_WaterlineScroll_Data + d1 * 0x60;
    let a4 = 0;
    for (let i = 0; i < 0x60; i++) {
      const a0 = art + rom.u8at(a5++) * 4;
      buf.set(rom.u8.subarray(a0, a0 + 4), a4);
      buf.set(rom.u8.subarray(a0 + 0x600, a0 + 0x604), a4 + 0x180);
      a4 += 4;
    }
    this.dma(buf, vram, 0x180);
  }

  // loc_26CB8: waterline exactly at the camera; falls through into AniHCZ_FixUpperBG
  loc_26CB8(a3) {
    this.m.setW(a3, 1);
    this.aniHCZ_FixLowerBG();
    this.aniHCZ_FixUpperBG();
  }
  aniHCZ_FixUpperBG() {
    this.dma(A.ArtUnc_FixHCZ1_UpperBG1, tiles(0x2dc), 0xc0);
    this.dma(A.ArtUnc_FixHCZ1_UpperBG2, tiles(0x2e8), 0xc0);
  }
  aniHCZ_FixLowerBG() {
    this.dma(A.ArtUnc_FixHCZ1_LowerBG1, tiles(0x2f4), 0xc0);
    this.dma(A.ArtUnc_FixHCZ1_LowerBG2, tiles(0x300), 0xc0);
  }

  // sub_26D0E (Animate_Init for HCZ1)
  sub_26D0E() {
    const m = this.m, a3 = AC + 4;
    const d1 = m.w(R.Events_bg + 0x10);
    if (d1 === 0) { this.loc_26CB8(a3); return; }
    if (d1 < 0) {
      this.aniHCZ_FixLowerBG();
      if (u16(d1) + 0x60 > 0xffff) { this.loc_26BC6(a3); return; }
      this.dma(A.ArtUnc_AniHCZ1_WaterlineBelow, tiles(0x2dc), 0xc0);
      this.dma(A.ArtUnc_AniHCZ1_WaterlineBelow2, tiles(0x2e8), 0xc0);
    } else {
      this.aniHCZ_FixUpperBG();
      if (u16(-d1) + 0x60 > 0xffff) { this.loc_26BC6(a3); return; }
      this.dma(A.ArtUnc_AniHCZ1_WaterlineAbove, tiles(0x2f4), 0xc0);
      this.dma(A.ArtUnc_AniHCZ1_WaterlineAbove2, tiles(0x300), 0xc0);
    }
  }

  // ---------------------------------------------------------------- HCZ2
  // AnimateTiles_HCZ2: four BG strips whose art is shifted by the BG layers' relative scroll
  hcz2() {
    const m = this.m;
    let a3 = AC;
    // strip 1 ($2D2, 4 tiles, 8 pixel shifts of $80 bytes)
    let v = m.uw(R.Events_bg + 0x12) & 0x1f;
    if (v !== m.ub(a3 + 1)) {
      m.setB(a3 + 1, v);
      let d1 = (v & 7) << 7;
      const d5 = d1;
      const d2 = v & 0x18;
      d1 += d2 << 2;
      this.strip(A.ArtUnc_AniHCZ2_SmallBGLine, d1, d5, W26DF2, d2 >> 2, tiles(0x2d2));
    }
    a3 += 2;
    // strip 2 ($2D6, 8 tiles)
    v = m.uw(R.Events_bg + 0x12) & 0x1f;
    if (v !== m.ub(a3 + 1)) {
      m.setB(a3 + 1, v);
      let d1 = (v & 7) << 8;
      const d5 = d1;
      const d2 = v & 0x18;
      d1 += d2 << 3;
      this.strip(A.ArtUnc_AniHCZ2_2, d1, d5, W26E5E, d2 >> 2, tiles(0x2d6));
    }
    a3 += 2;
    // strip 3 ($2DE, 16 tiles)
    v = m.uw(R.Events_bg + 0x14) & 0x1f;
    if (v !== m.ub(a3 + 1)) {
      m.setB(a3 + 1, v);
      let d1 = (v & 7) << 9; // ror.w #7
      const d5 = d1;
      const d2 = v & 0x18;
      d1 += d2 << 4;
      this.strip(A.ArtUnc_AniHCZ2_3, d1, d5, W26ECA, d2 >> 2, tiles(0x2de));
    }
    a3 += 2;
    // strip 4 ($2EE, 48 tiles, scrolls the other way)
    v = m.uw(R.Events_bg + 0x14) & 0x3f;
    if (v !== m.ub(a3 + 1)) {
      m.setB(a3 + 1, v);
      const n = u16(-v);
      let d1 = ((n & 7) << 9) * 3;
      const d5 = d1;
      const d2 = (~n) & 0x38;
      d1 += (d2 << 3) + (d2 << 4);
      this.strip(A.ArtUnc_AniHCZ2_4, d1, d5, W26F46, d2 >> 2, tiles(0x2ee));
    }
    a3 += 2;
    this.loc_275F0(this.aniPLC, a3);
  }

  // ---------------------------------------------------------------- MGZ
  mgz() {
    if (!this.m.ub(RAM.Boss_flag)) this.doAniPLC();
  }

  // ---------------------------------------------------------------- CNZ
  // AnimateTiles_CNZ: BG strip at $308 (32 tiles) shifted by Events_bg+$10 - BG X
  cnz() {
    const m = this.m;
    const a3 = AC;
    const v = u16(m.uw(R.Events_bg + 0x10) - m.uw(R.Camera_X_pos_BG_copy)) & 0x3f;
    if (v !== m.ub(a3 + 1)) {
      m.setB(a3 + 1, v);
      let d1 = (v & 7) << 10; // ror.w #6
      const d5 = d1;
      const d2 = v & 0x38;
      d1 += d2 << 4;
      this.strip(A.ArtUnc_AniCNZ__6, d1, d5, W26FD6, d2 >> 2, tiles(0x308));
    }
    this.loc_275F0(this.aniPLC, a3 + 2);
  }

  // ---------------------------------------------------------------- ICZ
  icz() {
    const m = this.m;
    let a3 = AC;
    let v = u16(m.uw(R.Events_bg + 0x10) - m.uw(R.Camera_X_pos_BG_copy)) & 0x1f;
    if (v !== m.ub(a3 + 1)) {
      m.setB(a3 + 1, v);
      let d1 = (v & 7) << 9;
      const d5 = d1;
      const d2 = v & 0x18;
      d1 += d2 << 4;
      this.strip(A.ArtUnc_AniICZ__1, d1, d5, W26FF6, d2 >> 2, tiles(0x10e), true);
    }
    a3 += 2;
    if ((this.zoneAct & 1) === 0) {
      // ICZ1: vertically scrolling BG strips (4-byte tile rows: 1 pixel line per step)
      const yBG = m.uw(R.Camera_Y_pos_BG_copy), e12 = m.w(R.Events_bg + 0x12);
      v = u16(-(yBG - e12)) & 0x3f;
      if (v !== m.ub(a3 + 1)) {
        m.setB(a3 + 1, v);
        this.dma(A.ArtUnc_AniICZ__2 + v * 4, tiles(0x122), 0x80);
        let d0 = e12 >> 1;
        let d1 = yBG - d0;
        d0 >>= 1;
        d1 = u16(-(d1 - d0)) & 0x1f;
        this.dma(A.ArtUnc_AniICZ__3 + d1 * 4, tiles(0x12a), 0x40);
        d1 = u16(-(yBG - (e12 >> 1))) & 0xf;
        this.dma(A.ArtUnc_AniICZ__4 + d1 * 4, tiles(0x12e), 0x20);
        d1 = u16(-(yBG - (e12 >> 2))) & 7;
        this.dma(A.ArtUnc_AniICZ__5 + d1 * 4, tiles(0x130), 0x10);
      }
    }
    a3 += 2;
    this.loc_275F0(this.aniPLC, a3);
  }

  // ---------------------------------------------------------------- LBZ
  // FG conveyor/light art at $160 (16 frames of 16 tiles, every 4th frame)
  lbzConveyor(a3) {
    const m = this.m;
    const t = m.ub(a3);
    m.setB(a3, t - 1);
    if (t !== 0) return;
    m.setB(a3, 3);
    const d0 = m.ub(a3 + 1);
    m.setB(a3 + 1, (d0 + 1) & 0xf);
    this.dma(A.ArtUnc_AniLBZ__0 + ((d0 << 9) & 0xffff | (d0 >> 7)), tiles(0x160), 0x100);
  }

  // AnimateTiles_LBZ1
  lbz1() {
    const m = this.m;
    let a3 = AC;
    this.lbzConveyor(a3);
    a3 += 2;
    // BG strip at $350 (20 tiles, 8 pixel shifts) + 1 extra tile column at $364
    const v = u16(m.uw(R.Events_bg + 0x10) - m.uw(R.Camera_X_pos_BG_copy)) & 0x1f;
    if (v !== m.ub(a3 + 1)) {
      m.setB(a3 + 1, v);
      const d6 = v & 7;
      let d1 = d6 * 0x280;
      const d5 = d1;
      const d2 = v & 0x18;
      d1 += d2 * 20;
      const d4 = this.strip(A.ArtUnc_AniLBZ1_1, d1, d5, W2721A, d2 >> 2, tiles(0x350), true);
      this.dma(A.ArtUnc_AniLBZ1_2 + (d6 << 5), d4, 0x10);
    }
    a3 += 2;
    // AniPLC_LBZ1 (alarm light at $365) only animates while Obj_LBZAlarm sets Anim_Counters+4;
    // otherwise it is rewound and stops on its first frame
    const on = m.uw(a3);
    a3 += 2;
    if (on) this.loc_275F0(this.aniPLC, a3);
    else if (m.ub(a3 + 1) !== 1) { m.setW(a3, 0); this.loc_275F0(this.aniPLC, a3); }
    this.loc_275F0(A.AniPLC_LBZSpec, AC + 0xc);
  }

  // AnimateTiles_LBZ2
  lbz2() {
    const m = this.m;
    let a3 = AC;
    if (m.ub(a3 + 0xf)) { this.sub_272A0(a3 + 4); return; } // Death Egg launch
    this.lbzConveyor(a3);
    a3 += 2;
    const v = u16(m.uw(R.Events_bg + 0x12) - m.uw(R.Camera_X_pos_BG_copy)) & 0xf;
    if (v !== m.ub(a3 + 1)) {
      m.setB(a3 + 1, v);
      this.dma(A.ArtUnc_AniLBZ2_2 + (v << 6), tiles(0x2e3), 0x20);
    }
    a3 += 2;
    this.sub_272A0(a3);
    a3 += 4;
    this.loc_275F0(this.aniPLC, a3);
  }

  // sub_272A0: LBZ2 BG waterline art (Events_bg+$10 = waterline distance, +-$40)
  sub_272A0(a3) {
    const m = this.m;
    const d1 = m.w(R.Events_bg + 0x10);
    if (d1 === m.w(a3)) return;
    m.setW(a3, d1);
    if (d1 === 0) { // loc_27384, falls through into sub_2738C
      m.setW(a3 + 2, 1);
      this.sub_273A0();
      this.sub_2738C();
      return;
    }
    if (d1 < 0) {
      const v = u16(d1) + 0x40;
      if (v <= 0xffff) return;
      this.lbzWaterline(v & 0xffff, A.ArtUnc_AniLBZ2_WaterlineBelow, tiles(0x2c3));
      if (m.w(a3 + 2) !== 0) { m.setW(a3 + 2, 0); this.sub_273A0(); }
    } else {
      const v = u16(-d1) + 0x40;
      if (v <= 0xffff) return;
      this.lbzWaterline(v & 0xffff, A.ArtUnc_AniLBZ2_WaterlineAbove, tiles(0x2d3));
      if (m.w(a3 + 2) >= 0) { m.setW(a3 + 2, -1); this.sub_2738C(); }
    }
  }
  lbzWaterline(d1, art, vram) {
    const rom = this.rom, buf = this.buf;
    let a5 = A.LBZ_WaterlineScroll_Data + (d1 << 6);
    let a4 = 0;
    for (let i = 0; i < 0x40; i++) {
      const a0 = art + rom.u8at(a5++) * 4;
      buf.set(rom.u8.subarray(a0, a0 + 4), a4);
      buf.set(rom.u8.subarray(a0 + 0x100, a0 + 0x104), a4 + 0x100);
      a4 += 4;
    }
    this.dma(buf, vram, 0x100);
  }
  sub_2738C() { this.dma(A.ArtUnc_AniLBZ2_LowerBG, tiles(0x2c3), 0x100); }
  sub_273A0() { this.dma(A.ArtUnc_AniLBZ2_UpperBG, tiles(0x2d3), 0x100); }
  // sub_273B4 (Animate_Init for LBZ2; also called by the LBZ1 -> LBZ2 transition)
  sub_273B4() {
    const m = this.m, a3 = AC + 4;
    m.setW(a3 + 2, 1);
    const d1 = m.w(R.Events_bg + 0x10);
    if (d1 === 0) { m.setW(a3 + 2, 1); this.sub_273A0(); this.sub_2738C(); return; }
    if (d1 > 0) this.sub_2738C();
    else this.sub_273A0();
    this.sub_272A0(a3);
  }

  // ================================================================ palettes
  // Animate_Palette: no cycling while the level fades in, then AnPal_Load
  animatePalette() {
    if (this.fadeTimer > 0) { this.fadeTimer--; return; }
    this.palDirty = false;
    switch (this.actIdx) {
      case 0: this.anPalAIZ1(); break;
      case 1: this.anPalAIZ2(); break;
      case 2: this.anPalHCZ1(); break;
      case 6: case 7: this.anPalCNZ(); break;
      case 10: case 11: this.anPalICZ(); break;
      case 12: this.anPalLBZ(A.AnPal_PalLBZ1); break;
      case 13: this.anPalLBZ(A.AnPal_PalLBZ2); break;
      default: break; // AnPal_HCZ2 / AnPal_None (MGZ) / AnPal_FBZ: rts
    }
    if (this.palDirty) this.vdp.updatePalette();
  }

  // Normal_palette / Water_palette byte offsets -> colour index
  setPal(ofs, n, src) {
    const pal = this.level.palette;
    for (let i = 0; i < n; i++) pal[(ofs >> 1) + i] = this.rom.u16(src + i * 2);
    this.palDirty = true;
  }
  setWaterPal(ofs, n, src) {
    const wp = this.level.waterPalette;
    if (!wp) return;
    for (let i = 0; i < n; i++) wp[(ofs >> 1) + i] = this.rom.u16(src + i * 2);
    this.palDirty = true;
  }
  // subq.w #1,counter / bpl: returns true when the counter expired (and reloads it)
  tick(addr, reload) {
    const m = this.m;
    if (m.addW(addr, -1) >= 0) return false;
    m.setW(addr, reload);
    return true;
  }
  // move.w (counter),d0 / addq.w #step,(counter) / cmpi.w #limit / blo / clear
  step(addr, inc, limit) {
    const m = this.m;
    const d0 = m.uw(addr);
    const n = u16(d0 + inc);
    m.setW(addr, limit !== undefined && n >= limit ? 0 : n);
    return d0;
  }

  // AnPal_AIZ1 (AIZ1_palette_cycle_flag is only set during the intro, camera X < $1000)
  anPalAIZ1() {
    const m = this.m;
    const L3 = 0x40, L4 = 0x60;
    if (!m.ub(RAM.AIZ1_palette_cycle_flag)) {
      if (!this.tick(RAM.Palette_cycle_counter1, 7)) return;
      const d0 = this.step(RAM.Palette_cycle_counter0, 8) & 0x18;
      this.setPal(L3 + 0x16, 4, A.AnPal_PalAIZ1_1 + d0);
      if (m.ub(PCC)) return;
      const d1 = this.step(PCC + 2, 6, 0x30);
      this.setPal(L4 + 0x18, 3, A.AnPal_PalAIZ1_2 + d1);
      return;
    }
    // loc_24A6: intro beach cycles
    if (!this.tick(RAM.Palette_cycle_counter1, 9)) return;
    const d0 = this.step(RAM.Palette_cycle_counter0, 8, 0x50);
    this.setPal(L4 + 0x04, 4, A.AnPal_PalAIZ1_3 + d0);
    const d1 = this.step(PCC + 2, 6, 0x3c);
    this.setPal(L4 + 0x1a, 3, A.AnPal_PalAIZ1_4 + d1);
  }

  // AnPal_AIZ2: waterfall shimmer, water / torch colours (different set past X $3800)
  anPalAIZ2() {
    const m = this.m, rom = this.rom, pal = this.level.palette;
    const L3 = 0x40, L4 = 0x60;
    const camX = m.uw(R.Camera_X_pos);
    if (this.tick(RAM.Palette_cycle_counter1, 5)) {
      const d0 = this.step(RAM.Palette_cycle_counter0, 8) & 0x18;
      this.setPal(L4 + 0x18, 4, A.AnPal_PalAIZ2_1 + d0);
      const d1 = this.step(PCC + 2, 6, 0x30);
      const a0 = (camX >= 0x3800 ? A.AnPal_PalAIZ2_3 : A.AnPal_PalAIZ2_2) + d1;
      pal[(L3 + 0x08) >> 1] = rom.u16(a0);
      pal[(L3 + 0x10) >> 1] = rom.u16(a0 + 2);
      pal[(L4 + 0x16) >> 1] = rom.u16(a0 + 4);
      pal[(L3 + 0x1c) >> 1] = 0xa0e;
      if (camX < 0x1c0) pal[(L3 + 0x1c) >> 1] = rom.u16(a0 + 4);
      this.palDirty = true;
    }
    if (!this.tick(PCC + 8, 1)) return;
    const d0 = this.step(PCC + 4, 2, 0x34);
    this.setPal(L4 + 0x02, 1, (camX >= 0x3800 ? A.AnPal_PalAIZ2_5 : A.AnPal_PalAIZ2_4) + d0);
  }

  // AnPal_HCZ1 (Palette_cycle_counters+0 speeds it up)
  anPalHCZ1() {
    const m = this.m;
    if (!this.tick(RAM.Palette_cycle_counter1, 7)) return;
    if (m.ub(PCC)) m.setW(RAM.Palette_cycle_counter1, 0);
    const d0 = this.step(RAM.Palette_cycle_counter0, 8, 0x20);
    this.setPal(0x40 + 0x06, 4, A.AnPal_PalHCZ1 + d0);
    this.setWaterPal(0x40 + 0x06, 4, A.AnPal_PalHCZ1 + d0);
  }

  // AnPal_CNZ
  anPalCNZ() {
    if (this.tick(RAM.Palette_cycle_counter1, 3)) {
      const d0 = this.step(RAM.Palette_cycle_counter0, 6, 0x60);
      this.setPal(0x60 + 0x12, 3, A.AnPal_PalCNZ_1 + d0);
      this.setWaterPal(0x60 + 0x12, 3, A.AnPal_PalCNZ_2 + d0);
    }
    const d1 = this.step(PCC + 2, 6, 0xb4);
    this.setPal(0x40 + 0x12, 3, A.AnPal_PalCNZ_3 + d1);
    this.setWaterPal(0x40 + 0x12, 3, A.AnPal_PalCNZ_4 + d1);
    if (!this.tick(PCC + 8, 2)) return;
    const d2 = this.step(PCC + 4, 4, 0x40);
    this.setPal(0x40 + 0x0e, 2, A.AnPal_PalCNZ_5 + d2);
    this.setWaterPal(0x40 + 0x0e, 2, A.AnPal_PalCNZ_5 + d2);
  }

  // AnPal_ICZ (two of the cycles only indoors: Events_bg+$16)
  anPalICZ() {
    const m = this.m;
    if (this.tick(RAM.Palette_cycle_counter1, 5)) {
      const d0 = this.step(RAM.Palette_cycle_counter0, 4, 0x40);
      this.setPal(0x40 + 0x1c, 2, A.AnPal_PalICZ_1 + d0);
    }
    if (this.tick(PCC + 8, 9)) {
      const d0 = this.step(PCC + 2, 4, 0x48);
      if (m.w(R.Events_bg + 0x16)) this.setPal(0x60 + 0x1c, 2, A.AnPal_PalICZ_2 + d0);
    }
    if (!this.tick(PCC + 0xa, 7)) return;
    const d0 = this.step(PCC + 4, 4, 0x18);
    if (m.w(R.Events_bg + 0x16)) this.setPal(0x60 + 0x18, 2, A.AnPal_PalICZ_3 + d0);
    const d1 = this.step(PCC + 6, 4, 0x40);
    this.setPal(0x40 + 0x18, 2, A.AnPal_PalICZ_4 + d1);
  }

  // AnPal_LBZ1 / AnPal_LBZ2
  anPalLBZ(table) {
    if (!this.tick(RAM.Palette_cycle_counter1, 3)) return;
    const d0 = this.step(RAM.Palette_cycle_counter0, 6, 0x12);
    this.setPal(0x40 + 0x10, 3, table + d0);
  }
}
