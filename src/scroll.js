// Level drawing / scrolling core: port of LevelSetup / ScreenEvents and the shared plane
// drawing and deformation routines of the original ($39xxx-$3Axxx in the ROM).
//
// Plane B (the background) is emulated as a real 64x32-cell VDP name table: the ported
// BG events write rows / columns of blocks into it exactly like the original does through
// Plane_buffer + VInt_DrawLevel, and the renderer then shows it with the per-line
// H_scroll_buffer and V_scroll_value_BG, wrapping at 512x256 pixels like the hardware.
// That makes "which part of the BG layout is visible" (stale columns, bands drawn from
// different X positions, BG layouts relying on the 512px plane wrap, ...) come out the same
// as on the console. Plane A (foreground) is still rendered straight from the layout since
// DrawTilesAsYouMove always keeps it in sync with Camera_X/Y_pos_copy; draw requests aimed
// at plane A only update the "rounded" bookkeeping variables.
import { R, s16, u16, SKIP_VSCROLL } from './ram.js';
import { ZONE_EVENTS } from './zones/index.js';

export const PLANE_W = 64, PLANE_H = 32; // cells (VDP reg $10 = $01: 512x256 pixels)

export class Scroll {
  constructor(game, ram) {
    this.game = game;
    this.level = game.level;
    this.rom = game.rom;
    this.m = ram;
    this.bgNT = new Uint16Array(PLANE_W * PLANE_H);
    this.bgOn = true; // false: draws target plane A (no-op)
    this.layoutSel = 2; // a3 = Level_layout_main + 0 (FG) / + 2 (BG)
    const z = game.zone.id;
    this.actIdx = ((z >> 8) << 1) | (z & 1);
    this.events = ZONE_EVENTS[this.actIdx] ?? ZONE_EVENTS.none;
    this.state = {}; // per-zone scratch for things that live in object RAM in the original
    // per-16px-column V-scroll (VDP reg $0B bit 2), enabled by SpecialVInt_VScrollOn
    this.columnVScroll = false;
    this.fgVcols = new Int16Array(20);
    this.bgVcols = new Int16Array(20);
    this.fgHScroll = new Int16Array(224);
    this.bgHScroll = new Int16Array(224);
  }

  // ------------------------------------------------------------------ frame entry points
  // LevelSetup ($3A9A0-ish): initial plane drawing
  levelSetup() {
    const m = this.m;
    m.setB(0xfff664, 0); // Background_collision_flag
    m.setL(R.Plane_double_update_flag, 0);
    m.setW(R.Special_events_routine, 0);
    m.setL(R.Level_repeat_offset, 0);
    m.setL(R.Events_routine_fg, 0);
    m.setL(R.Events_fg_4, 0);
    m.setW(R.Screen_shake_flag, 0);
    m.setL(R.Screen_shake_offset, 0);
    m.clear(R.Events_bg, 0x10);
    m.setW(R.Screen_Y_wrap_value, 0xfff);
    m.setW(R.Camera_Y_pos_mask, 0xff0);
    m.setW(R.Layout_row_index_mask, 0x7c);
    m.setW(R.Camera_X_pos_copy, m.w(R.Camera_X_pos));
    m.setW(R.Camera_Y_pos_copy, m.w(R.Camera_Y_pos));
    this.selectFG();
    this.events.screenInit(this);
    this.selectBG();
    this.events.bgInit(this);
    m.setW(R.V_scroll_value_FG, m.w(R.Camera_Y_pos_copy));
    m.setW(R.V_scroll_value_BG, m.w(R.Camera_Y_pos_BG_copy));
  }

  // ScreenEvents ($3AA06-ish), run every frame after DeformBgLayer
  screenEvents() {
    const m = this.m;
    m.setW(R.Camera_X_pos_copy, m.w(R.Camera_X_pos));
    m.setW(R.Camera_Y_pos_copy, m.w(R.Camera_Y_pos));
    this.selectFG();
    this.events.screenEvent(this);
    this.selectBG();
    const skip = this.events.bgEvent(this);
    if (skip !== SKIP_VSCROLL) {
      m.setW(R.V_scroll_value_FG, m.w(R.Camera_Y_pos_copy));
      m.setW(R.V_scroll_value_BG, m.w(R.Camera_Y_pos_BG_copy));
    }
    this.specialVInt();
  }

  // SpecialVInt_Function: the V-scroll mode switches done in the next V-blank
  specialVInt() {
    const m = this.m;
    switch (m.w(R.Special_V_int_routine)) {
      case 4: // SpecialVInt_VScrollOn
        this.columnVScroll = true;
        m.setW(R.Special_V_int_routine, 8);
      // fallthrough
      case 8: // SpecialVInt_VScrollCopy: 20 columns of (FG, BG) from Vscroll_buffer
        for (let i = 0; i < 20; i++) {
          this.fgVcols[i] = m.w(R.Vscroll_buffer + i * 4);
          this.bgVcols[i] = m.w(R.Vscroll_buffer + i * 4 + 2);
        }
        break;
      case 0xc: // SpecialVInt_VScrollOff
        this.columnVScroll = false;
        m.setW(R.Special_V_int_routine, 0);
        break;
      default: break; // LBZ2 window copies: not emulated
    }
  }

  selectFG() { this.bgOn = false; this.layoutSel = 0; }
  selectBG() { this.bgOn = true; this.layoutSel = 2; }

  // Per-line scroll values for the renderer (plane coordinate of the screen's left edge).
  scrollLines() {
    const m = this.m, fg = this.fgHScroll, bg = this.bgHScroll;
    for (let i = 0; i < 224; i++) {
      const a = R.H_scroll_buffer + i * 4;
      fg[i] = -m.w(a);
      bg[i] = -m.w(a + 2);
    }
    const cols = this.columnVScroll;
    return {
      fg, bg, fgV: m.w(R.V_scroll_value_FG), bgV: m.w(R.V_scroll_value_BG), bgNT: this.bgNT,
      fgVcols: cols ? this.fgVcols : null, bgVcols: cols ? this.bgVcols : null,
    };
  }

  // ------------------------------------------------------------------ layout access
  // Get_LevelAddrChunkRow: a4 = row pointer (sign-extended word from the layout header)
  rowPtr(y) {
    const idx = (s16(y) >> 5) & this.m.uw(R.Layout_row_index_mask);
    const p = this.m.uw(0xff8008 + idx + this.layoutSel);
    return p & 0x8000 ? 0xff0000 | p : p; // movea.w: $8xxx -> $FFFF8xxx, else low ROM
  }

  // write one 16x16 block (chunk entry `bw`) at block position (bx, by) of plane B
  putBlock(bx, by, bw) {
    const blocks = this.level.blocks;
    const id = (bw & 0x3ff) << 2;
    let tl = blocks[id] ?? 0, tr = blocks[id + 1] ?? 0, bl = blocks[id + 2] ?? 0, br = blocks[id + 3] ?? 0;
    if (bw & 0x800) { // Y flip
      let t = tl; tl = bl ^ 0x1000; bl = t ^ 0x1000;
      t = tr; tr = br ^ 0x1000; br = t ^ 0x1000;
    }
    if (bw & 0x400) { // X flip
      let t = tl; tl = tr ^ 0x800; tr = t ^ 0x800;
      t = bl; bl = br ^ 0x800; br = t ^ 0x800;
    }
    const nt = this.bgNT;
    const o = ((by & 15) * 2) * PLANE_W + (bx & 31) * 2;
    nt[o] = tl; nt[o + 1] = tr; nt[o + PLANE_W] = bl; nt[o + PLANE_W + 1] = br;
  }

  chunkWord(chunk, y, blockInRow) {
    return this.level.chunks[chunk * 64 + ((y & 0x70) >> 1) + blockInRow] ?? 0;
  }

  // Setup_TileRowDraw: d0 = y, d1 = x, d6 = number of 16px blocks
  setupTileRowDraw(y, x, count) {
    if (!this.bgOn) return;
    const m = this.m;
    y = s16(y);
    let blk = s16(x) >> 4;
    let cx = blk >> 3, sub = blk & 7;
    const a4 = this.rowPtr(y);
    let chunk = m.ub(a4 + s16(cx));
    const by = (y & 0xf0) >> 4;
    for (let i = 0; i < count; i++) {
      this.putBlock(blk + i, by, this.chunkWord(chunk, y, sub));
      if (++sub === 8) { sub = 0; cx++; chunk = m.ub(a4 + s16(cx)); }
    }
  }

  // Setup_TileColumnDraw: d0 = x, d1 = y, d6 = number of blocks
  setupTileColumnDraw(x, y, count) {
    if (!this.bgOn) return;
    const m = this.m, mask = m.uw(R.Layout_row_index_mask);
    x = s16(x); y = s16(y);
    let row = (y >> 5) & mask;
    let by = y >> 4;
    let br = by & 7;
    const bx = x >> 4, cx = x >> 7, sub = (x >> 4) & 7;
    const chunkAt = () => {
      const p = m.uw(0xff8008 + row + this.layoutSel);
      return m.ub((p & 0x8000 ? 0xff0000 | p : p) + cx);
    };
    let chunk = chunkAt();
    for (let i = 0; i < count; i++) {
      this.putBlock(bx, by, this.level.chunks[chunk * 64 + br * 8 + sub] ?? 0);
      by++;
      if (++br === 8) { br = 0; row = (row + 4) & mask; chunk = chunkAt(); }
    }
  }

  // Draw_TileColumn: a6 = position variable, a5 = its "rounded" variable, d1 = y, d6 = count
  drawTileColumn(a6, a5, y, count, yRight = y) {
    const m = this.m;
    let d0 = m.w(a6) & 0xfff0;
    const d3 = m.w(a5);
    m.setW(a5, d0);
    let d2 = s16(d3 - d0);
    if (d2 === 0) return;
    let d1 = y;
    if ((d2 & 0x80) !== 0) { d2 = -d2; d0 = d3 + 0x150; d1 = yRight; } // Draw_TileColumn2's swap d1
    const dbl = (d2 & 0x30) !== 0x10;
    this.setupTileColumnDraw(d0, d1, count);
    if (dbl) this.setupTileColumnDraw(d0 + 0x10, d1, count);
  }

  // Draw_TileRow / Draw_TileRow2 (xBottom: x used when drawing the bottom row)
  drawTileRow(a6, a5, x, count, xBottom = x) {
    const m = this.m, mask = m.uw(R.Camera_Y_pos_mask);
    let d0 = m.w(a6) & mask;
    const d3 = m.w(a5);
    m.setW(a5, d0);
    let d2 = s16(d3 - d0);
    if (d2 === 0) return;
    let d1 = x;
    if ((d2 & 0x80) !== 0) { d2 = -d2; d0 = (d3 + 0xf0) & mask; d1 = xBottom; }
    const dbl = (d2 & 0x30) !== 0x10;
    this.setupTileRowDraw(d0, d1, count);
    if (dbl) this.setupTileRowDraw((d0 + 0x10) & mask, d1, count);
  }

  // Refresh_PlaneFull: 16 rows of $20 blocks from (d1, d0)
  refreshPlaneFull(y, x) {
    for (let i = 0; i < 16; i++, y += 0x10) this.setupTileRowDraw(y, x, 0x20);
  }

  // Refresh_PlaneTileDeform: d0 = y, a4 = draw array (ROM), a5 = HScroll entries (x, rounded)
  refreshPlaneTileDeform(y, a4, a5) {
    const m = this.m;
    let d2 = m.w(a4); a4 += 2;
    for (let i = 0; i < 16; i++) {
      while (s16(y - d2) >= 0) { d2 = s16(d2 + m.w(a4)); a4 += 2; a5 += 4; }
      this.setupTileRowDraw(y, m.w(a5), 0x20);
      y += 0x10;
    }
  }

  // Refresh_PlaneDirectVScroll: columns, for per-column V-scroll layouts
  refreshPlaneDirectVScroll(x, a4, a5) {
    const m = this.m;
    let d2 = m.w(a4); a4 += 2;
    for (let i = 0; i < 32; i++) {
      while (s16(x - d2) >= 0) { d2 = s16(d2 + m.w(a4)); a4 += 2; a5 += 4; }
      this.setupTileColumnDraw(x, m.w(a5), 0x10);
      x += 0x10;
    }
  }

  // Refresh_PlaneScreenDirect
  refreshPlaneScreenDirect() {
    const m = this.m;
    let y = m.w(R.Camera_Y_pos_copy);
    const x = m.w(R.Camera_X_pos_copy);
    for (let i = 0; i < 15; i++, y += 0x10) this.setupTileRowDraw(y, x, 0x15);
  }

  // DrawTilesAsYouMove (plane A): keeps Camera_X/Y_pos_rounded up to date
  drawTilesAsYouMove() {
    const m = this.m;
    this.drawTileColumn(R.Camera_X_pos_copy, R.Camera_X_pos_rounded, m.w(R.Camera_Y_pos_copy), 0xf);
    this.drawTileRow(R.Camera_Y_pos_copy, R.Camera_Y_pos_rounded, m.w(R.Camera_X_pos_copy), 0x15);
  }

  // DrawBGAsYouMove
  drawBGAsYouMove() {
    const m = this.m;
    this.drawTileColumn(R.Camera_X_pos_BG_copy, R.Camera_X_pos_BG_rounded, m.w(R.Camera_Y_pos_BG_copy), 0xf);
    this.drawTileRow(R.Camera_Y_pos_BG_copy, R.Camera_Y_pos_BG_rounded, m.w(R.Camera_X_pos_BG_copy), 0x15);
  }

  // Get_DeformDrawPosVert: x of the bands at the top and bottom screen line
  deformDrawPosVert(a4, a5) {
    const m = this.m;
    let d2 = m.w(a4); a4 += 2;
    let d0 = m.w(R.Camera_Y_pos_BG_copy);
    const find = () => { while (s16(d0 - d2) >= 0) { d2 = s16(d2 + m.w(a4)); a4 += 2; a5 += 4; } return m.w(a5); };
    const top = find();
    d0 += 0xe0;
    const bottom = find();
    return [top, bottom];
  }

  // Draw_BG: a4 = draw array (band heights, $7FFF-terminated), a5 = HScroll_table entries
  // (x, rounded x) per band, d6 = row width in blocks, d5 = number of bands
  drawBG(a4, a5, d6, d5) {
    const m = this.m;
    const [xt, xb] = this.deformDrawPosVert(a4, a5);
    this.drawTileRow(R.Camera_Y_pos_BG_copy, R.Camera_Y_pos_BG_rounded, xt, d6, xb);
    this.drawBGNoVert(a4, a5, d5, m.w(R.Camera_Y_pos_BG_rounded));
  }

  // Draw_BGNoVert: columns for every band intersecting the screen
  drawBGNoVert(a4, a6, d5, d6) {
    const m = this.m;
    let d1 = d6;
    for (;;) {
      d6 = s16(d6 - m.w(a4)); a4 += 2;
      if (d6 < 0) break;
      m.setW(a6 + 2, m.w(a6) & 0xfff0); a6 += 4;
      d5--;
    }
    d6 = u16(-d6) >> 4;
    let d4 = 0xf - d6;
    if (d4 < 0) { d4 = 0; d6 = 0xf; }
    for (;;) {
      this.drawTileColumn(a6, a6 + 2, d1, d6);
      a6 += 4;
      if (d4 === 0) break;
      d1 = s16(d1 + (d6 << 4));
      d5--;
      d6 = u16(m.w(a4)) >> 4; a4 += 2;
      const d0 = d4;
      d4 -= d6;
      if (d4 < 0) { d6 = d0; d4 = 0; }
    }
    for (;;) {
      d5--;
      if (d5 === 0) return;
      m.setW(a6 + 2, m.w(a6) & 0xfff0); a6 += 4;
    }
  }

  // Get_XDeformRange + DrawTilesVDeform2: BG with per-column vertical bands (rows per band)
  drawTilesVDeform2(a4, a5, d6, d5) {
    const m = this.m;
    let d2 = m.w(a4); let p4 = a4 + 2, p5 = a5;
    let d0 = m.w(R.Camera_X_pos_BG_copy);
    const find = () => { while (u16(d0) >= u16(d2)) { d2 = s16(d2 + m.w(p4)); p4 += 2; p5 += 4; } return m.w(p5); };
    const left = find();
    d0 += 0x140;
    const right = find();
    this.drawTileColumn(R.Camera_X_pos_BG_copy, R.Camera_X_pos_BG_rounded, left, d6, right);
    let a6 = a5;
    let d6r = m.w(R.Camera_X_pos_BG_rounded);
    let d1 = d6r;
    const mask = m.uw(R.Camera_Y_pos_mask);
    for (;;) {
      const v = m.uw(a4); a4 += 2;
      const borrow = u16(d6r) < v;
      d6r = s16(d6r - v);
      if (borrow) break;
      m.setW(a6 + 2, m.w(a6) & mask); a6 += 4;
      d5--;
    }
    let cnt = u16(-d6r) >> 4;
    let d4 = 0x15 - cnt;
    if (d4 < 0) { d4 = 0; cnt = 0x15; }
    for (;;) {
      this.drawTileRow(a6, a6 + 2, d1, cnt);
      a6 += 4;
      if (d4 === 0) break;
      d1 = s16(d1 + (cnt << 4));
      d5--;
      cnt = m.uw(a4) >> 4; a4 += 2;
      const d0b = d4;
      d4 -= cnt;
      if (d4 < 0) { cnt = d0b; d4 = 0; }
    }
    for (;;) {
      d5--;
      if (d5 === 0) return;
      m.setW(a6 + 2, m.w(a6) & mask); a6 += 4;
    }
  }

  // Draw_PlaneVertSingleBottomUp / Draw_PlaneVertBottomUp: delayed full redraw, 2 rows per
  // frame from Draw_delayed_position upwards. Returns Draw_delayed_rowcount (< 0 = done).
  drawPlaneVertBottomUp(x, y) {
    const r = this.drawPlaneVertSingleBottomUp(x, y);
    if (r >= 0) return this.drawPlaneVertSingleBottomUp(x, y);
    return r;
  }

  drawPlaneVertSingleBottomUp(x, y) {
    const m = this.m, mask = m.uw(R.Camera_Y_pos_mask);
    const d2 = y & mask, d3 = (d2 + 0xf0) & mask;
    const d0 = m.uw(R.Draw_delayed_position);
    if (!(d0 < d2) && !(d0 > d3)) this.setupTileRowDraw(d0, x, 0x20);
    m.addW(R.Draw_delayed_position, -0x10);
    return m.addW(R.Draw_delayed_rowcount, -1);
  }

  // Draw_PlaneVertBottomUpComplex: same with an X per band (a5 = HScroll_table - 4)
  drawPlaneVertBottomUpComplex(y, a4, a5) {
    const r = this.planeVertComplexRow(y, a4, a5);
    if (r >= 0) return this.planeVertComplexRow(y, a4, a5);
    return r;
  }

  planeVertComplexRow(d1, a4, a5) {
    const m = this.m, mask = m.uw(R.Camera_Y_pos_mask);
    d1 &= mask;
    const d2 = (d1 + 0xf0) & mask;
    const d0 = m.uw(R.Draw_delayed_position);
    if (!(d0 < d1) && !(d0 > d2)) {
      do { a5 += 4; } while (s16(d0 - m.w((a4 += 2) - 2)) >= 0);
      this.setupTileRowDraw(d0, m.w(a5), 0x20);
    }
    m.addW(R.Draw_delayed_position, -0x10);
    return m.addW(R.Draw_delayed_rowcount, -1);
  }

  // ------------------------------------------------------------------ H-scroll building
  // PlainDeformation
  plainDeformation() {
    const m = this.m;
    const fg = -m.w(R.Camera_X_pos_copy), bg = -m.w(R.Camera_X_pos_BG_copy);
    for (let a = R.H_scroll_buffer; a < R.H_scroll_buffer_end; a += 4) { m.setW(a, fg); m.setW(a + 2, bg); }
  }

  // MakeFGDeformArray: d1+1 words of (a6)+ + d6 to a1. Returns [a1, a6].
  makeFGDeformArray(a1, a6, d6, d1) {
    const m = this.m;
    for (let i = 0; i <= d1; i++) { m.setW(a1, m.w(a6) + d6); a1 += 2; a6 += 2; }
    return [a1, a6];
  }

  // ApplyDeformation: a4 = band heights (bit 15: one value per line), a5 = BG X values.
  // Writes $E0 lines of (FG = -Camera_X_pos_copy, BG = -value) to H_scroll_buffer.
  applyDeformation(a4, a5) { return this.applyDeformation3(a4, a5, 0xdf); }

  applyDeformation3(a4, a5, d1, a1 = R.H_scroll_buffer, d0 = this.m.w(R.Camera_Y_pos_BG_copy), d3 = this.m.w(R.Camera_X_pos_copy)) {
    const m = this.m;
    let d2, perLine;
    // ApplyDeformation2: skip bands above the screen
    for (;;) {
      d2 = m.uw(a4); a4 += 2;
      perLine = (d2 & 0x8000) !== 0;
      d2 &= 0x7fff;
      d0 = s16(d0 - d2);
      if (d0 < 0) break;
      a5 += perLine ? d2 * 2 : 2;
    }
    if (perLine) a5 += s16(d2 + d0) * 2;
    d0 = s16(-d0);
    d2 = d1 - d0;
    if (u16(d1) < u16(d0)) d0 = d1 + 1;
    const fg = -d3;
    let n = d0; // lines in this band
    for (;;) {
      if (perLine) {
        for (let i = 0; i < n; i++) { m.setW(a1, fg); m.setW(a1 + 2, -m.w(a5)); a1 += 4; a5 += 2; }
      } else {
        const v = -m.w(a5); a5 += 2;
        for (let i = 0; i < n; i++) { m.setW(a1, fg); m.setW(a1 + 2, v); a1 += 4; }
      }
      if (s16(d2) < 0) return a1;
      let h = m.uw(a4); a4 += 2;
      perLine = (h & 0x8000) !== 0;
      h &= 0x7fff;
      const d3b = d2;
      d2 = s16(d2 - h);
      n = d2 >= 0 ? h : d3b + 1;
    }
  }

  // ApplyFGandBGDeformation: FG from a2 (words), BG from a5 (bands) + per-line delta a6
  applyFGandBGDeformation(a1, a2, a4, a5, a6, d0, d1) {
    const m = this.m;
    let d3, perLine;
    for (;;) {
      d3 = m.uw(a4); a4 += 2;
      perLine = (d3 & 0x8000) !== 0;
      d3 &= 0x7fff;
      d0 = s16(d0 - d3);
      if (d0 < 0) break;
      a5 += perLine ? d3 * 2 : 2;
    }
    if (perLine) a5 += s16(d3 + d0) * 2;
    d0 = s16(-d0);
    let d4 = d1 - d0;
    if (u16(d1) < u16(d0)) d0 = d1 + 1;
    let n = d0;
    for (;;) {
      if (perLine) {
        for (let i = 0; i < n; i++) {
          m.setW(a1, m.w(a2)); m.setW(a1 + 2, -m.w(a5) + m.w(a6));
          a1 += 4; a2 += 2; a5 += 2; a6 += 2;
        }
      } else {
        const d5 = -m.w(a5); a5 += 2;
        for (let i = 0; i < n; i++) {
          m.setW(a1, m.w(a2)); m.setW(a1 + 2, m.w(a6) + d5);
          a1 += 4; a2 += 2; a6 += 2;
        }
      }
      if (s16(d4) < 0) return [a1, a2];
      let h = m.uw(a4); a4 += 2;
      perLine = (h & 0x8000) !== 0;
      h &= 0x7fff;
      const d5b = d4;
      d4 = s16(d4 - h);
      n = d4 >= 0 ? h : d5b + 1;
    }
  }

  // Apply_FGVScroll: per-16px-column FG V-scroll (into Vscroll_buffer); a4 = column widths,
  // a5 = values. Enables per-column scrolling for the renderer.
  applyFGVScroll(a4, a5) {
    const m = this.m;
    let a1 = R.Vscroll_buffer;
    const d1 = m.w(R.Camera_Y_pos_BG_copy);
    let d0 = m.w(R.Camera_X_pos_copy);
    if (d0 & 0xf) d0 += 0x10;
    d0 = u16(d0) >> 4;
    let d2;
    for (;;) { a5 += 2; d2 = m.uw(a4) >> 4; a4 += 2; d0 = s16(d0 - d2); if (d0 < 0) break; }
    d0 = -d0;
    d2 = 0x13 - d0;
    if (d2 < 0) d0 = 0x14;
    let n = d0;
    for (;;) {
      const d3 = m.w(a5); a5 += 2;
      for (let i = 0; i < n; i++) { m.setW(a1, d3); m.setW(a1 + 2, d1); a1 += 4; }
      if (d2 < 0) return;
      const w = m.uw(a4) >> 4; a4 += 2;
      const d3b = d2;
      d2 -= w;
      n = d2 >= 0 ? w : d3b + 1;
    }
  }

  // Reset_TileOffsetPositionActual -> returns d0 (rounded Y)
  resetTileOffsetPositionActual() {
    const m = this.m;
    m.setW(R.Camera_X_pos_rounded, m.w(R.Camera_X_pos_copy) & 0xfff0);
    const d0 = m.w(R.Camera_Y_pos_copy) & m.uw(R.Camera_Y_pos_mask);
    m.setW(R.Camera_Y_pos_rounded, d0);
    return d0;
  }

  // Reset_TileOffsetPositionEff -> returns { d0: rounded BG Y, d1: BG X, d2: rounded BG X }
  resetTileOffsetPositionEff() {
    const m = this.m;
    const d1 = m.w(R.Camera_X_pos_BG_copy);
    const d2 = d1 & 0xfff0;
    m.setW(R.Camera_X_pos_BG_rounded, d2);
    const d0 = m.w(R.Camera_Y_pos_BG_copy) & m.uw(R.Camera_Y_pos_mask);
    m.setW(R.Camera_Y_pos_BG_rounded, d0);
    return { d0, d1, d2 };
  }

  // Get_BGActualEffectiveDiff
  bgActualEffectiveDiff() {
    const m = this.m;
    m.setW(R.Camera_X_diff, m.w(R.Camera_X_pos_copy) - m.w(R.Camera_X_pos_BG_copy));
    m.setW(R.Camera_Y_diff, m.w(R.Camera_Y_pos_copy) - m.w(R.Camera_Y_pos_BG_copy));
  }

  // Adjust_BGDuringLoop: a1 -> (last X, accumulated X); d0 = new X, d2 = jump threshold,
  // d3 = jump size
  adjustBGDuringLoop(a1, d0, d2, d3) {
    const m = this.m;
    const last = m.w(a1);
    m.setW(a1, d0);
    let d = s16(d0 - last);
    if (d < 0) {
      d = -d;
      if (!(u16(d) < u16(d2))) d -= d3;
      m.setW(a1 + 2, m.w(a1 + 2) - d);
    } else {
      if (!(u16(d) < u16(d2))) d -= d3;
      m.setW(a1 + 2, m.w(a1 + 2) + d);
    }
  }

  // ShakeScreen_Setup
  shakeScreenSetup() {
    const m = this.m;
    m.setW(R.Screen_shake_last_offset, m.w(R.Screen_shake_offset));
    if (this.game.player.routine >= 6) { m.setW(R.Screen_shake_offset, 0); return; }
    let d0 = m.w(R.Screen_shake_flag);
    if (d0 === 0) { m.setW(R.Screen_shake_offset, 0); return; }
    if (d0 > 0) {
      d0--;
      m.setW(R.Screen_shake_flag, d0);
      m.setW(R.Screen_shake_offset, this.rom.s8(SCREEN_SHAKE_ARRAY + d0));
      return;
    }
    m.setW(R.Screen_shake_offset, this.rom.u8at(SCREEN_SHAKE_ARRAY2 + (m.uw(R.Level_frame_counter) & 0x3f)));
  }
}

export const SCREEN_SHAKE_ARRAY = 0x3a11c;
export const SCREEN_SHAKE_ARRAY2 = 0x3a130;
