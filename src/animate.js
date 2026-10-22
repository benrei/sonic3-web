// Animated level tiles (AnimateTiles_DoAniPLC, $275EC) and AIZ1 palette cycling (AnPal_AIZ1).
const OFFS_ANIFUNC = 0x26ab2; // pairs of words per act: [func offset, AniPLC offset]

export class TileAnimator {
  constructor(rom, level, vdp, actIdx) {
    this.rom = rom;
    this.vdp = vdp;
    this.level = level;
    this.scripts = [];
    if (actIdx < 14) {
      let p = OFFS_ANIFUNC + rom.s16(OFFS_ANIFUNC + actIdx * 4 + 2);
      const n = rom.s16(p) + 1;
      p += 2;
      for (let i = 0; i < n && n < 32; i++) {
        const dur = rom.u8at(p);
        const art = rom.u32(p) & 0xffffff;
        const vram = rom.u16(p + 4);
        const frames = rom.u8at(p + 6);
        const tiles = rom.u8at(p + 7);
        const perFrame = dur & 0x80;
        const data = [];
        for (let f = 0; f < frames; f++) {
          data.push(perFrame ? { tile: rom.u8at(p + 8 + f * 2), dur: rom.u8at(p + 9 + f * 2) } : { tile: rom.u8at(p + 8 + f), dur });
        }
        this.scripts.push({ art, vram, tiles, data, timer: 0, frame: 0 });
        let size = frames;
        if (perFrame) size *= 2;
        p += 8 + ((size + 1) & 0xfe);
      }
    }
    this.palCounter0 = 0;
    this.palCounter1 = 0;
    this.palCounter2 = 0;
    this.isAIZ1 = actIdx === 0;
  }

  update() {
    for (const s of this.scripts) {
      if (--s.timer >= 0) continue;
      if (s.frame >= s.data.length) s.frame = 0;
      const f = s.data[s.frame++];
      s.timer = f.dur;
      const src = s.art + f.tile * 32;
      this.vdp.writeVram(s.vram, this.rom.u8.subarray(src, src + s.tiles * 32));
    }
    if (this.isAIZ1) this.aiz1Palette();
  }

  // AnPal_AIZ1 (normal, non-fire branch): waterfall / water shimmer colours.
  aiz1Palette() {
    if (--this.palCounter1 >= 0) return;
    this.palCounter1 = 7;
    const rom = this.rom, pal = this.level.palette;
    const d0 = this.palCounter0 & 0x18;
    this.palCounter0 += 8;
    for (let i = 0; i < 4; i++) pal[0x20 + 0x0b + i] = rom.u16(0x291a + d0 + i * 2);
    const d1 = this.palCounter2;
    this.palCounter2 += 6;
    if (this.palCounter2 >= 0x30) this.palCounter2 = 0;
    for (let i = 0; i < 3; i++) pal[0x30 + 0x0c + i] = rom.u16(0x2a1a + d1 + i * 2);
    this.vdp.updatePalette();
  }
}
