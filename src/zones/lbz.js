// Launch Base Zone screen / background events and deformation.
// Ported: LBZ1_ScreenInit, LBZ1_ScreenEvent (layout mods for the building interiors:
// LBZ1_CheckLayoutMod / LBZ1_LayoutMod1-4 / LBZ1_LayoutExitMod1-4 / LBZ1_DoMod1-4,
// LBZ1_ModEndingLayout, the boss chunk swap at Events_fg_4 = $55), LBZ1_EventVScroll
// (incl. the collapse V-scroll, which only an object can start), LBZ1_BackgroundInit,
// LBZ1BGE_Normal, LBZ1_Deform, Apply_FGVScroll with LBZ1_FGVScrollArray;
// LBZ2_ScreenInit, LBZ2SE_Normal, LBZ2_LayoutMod, LBZ2_BackgroundInit,
// LBZ2BGE_FromTransition/Refresh/Normal, LBZ2_Deform (water line, clouds, underwater bands,
// LBZ_WaterlineScroll_Data and LBZ_WaterWaveArray waviness).
// Not ported: the LBZ1 -> LBZ2 seamless transition (LBZ1BGE_DoTransition, Kos art loads),
// the LBZ2 Death Egg sequence (LBZ2BGE_DeathEgg/PlatformDetach/Falling,
// LBZ2_DeathEggDeform, LBZ2_DeathEggMoveScreen, LBZ2_EndFallingAccel, SpecialVInt_LBZ2*
// window-plane copies) and objects (Obj_LBZ1InvisibleBarrier, sounds). Plane A draws
// (Refresh_PlaneScreenDirect, DrawTilesVDeform) are only bookkeeping here because the
// foreground is rendered straight from the (modified) layout.
import { R, s16, u16 } from '../ram.js';

// ROM data
const LBZ1_FGVScrollArray = 0x3e598;
const LBZ1_LayoutModRange = 0x3e5b0;
const LBZ1_LayoutModExitRange = 0x3e5d0;
const LBZ1_CollapseScrollSpeed = 0x3e5e0;
const LBZ1_BGDrawArray = 0x3e7c4;
const LBZ1_BGDeformArray = 0x3e7c8;
const LBZ2_BGDeformArray = 0x3eee0;
const LBZ2_CloudDeformArray = 0x3ef34;
const LBZ2_BGUWDeformRange = 0x3ef4e;
const LBZ_WaterWaveArray = 0x3a570;
const LBZ_WaterlineScroll_Data = 0x6f460; // lea (LBZ_WaterlineScroll_Data).l,a6 at $3EAD8

const HS = R.HScroll_table;
const LAYOUT_MAIN = 0xff8008; // a3 = Level_layout_main (FG row pointers)
const hi = (v) => v >> 16;

// movea.w n(a3),a1 -> FG row pointer as a 24-bit address
function rowPtr(m, ofs) { return 0xff0000 | m.uw(LAYOUT_MAIN + ofs); }
const fgWidth = (m) => m.w(LAYOUT_MAIN - 8);

// copy `rows` rows of `bytes` bytes, stride = FG layout width (LBZ1_DoMod*, LBZ2_LayoutMod)
function copyRows(m, src, dst, bytes, rows) {
  const stride = fgWidth(m);
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < bytes; i++) m.setB(dst + i, m.ub(src + i));
    src += stride; dst += stride;
  }
}

// LBZ1_DoMod1..4: destination / size of each building interior
const DO_MOD = [
  null,
  (m, a5) => copyRows(m, a5, rowPtr(m, 8) + 0x26, 8, 9), // LBZ1_DoMod1
  (m, a5) => copyRows(m, a5, rowPtr(m, 0) + 0x42, 10, 14), // LBZ1_DoMod2
  (m, a5) => copyRows(m, a5, rowPtr(m, 0) + 0x74, 4, 12), // LBZ1_DoMod3
  (m, a5) => copyRows(m, a5, rowPtr(m, 0) + 0x7a, 6, 6), // LBZ1_DoMod4
];

// LBZ1_CheckLayoutMod: d0/d1 = player x/y, d2 = 0. Returns d3 (< 0: no layout change).
function lbz1CheckLayoutMod(s, d0, d1) {
  const m = s.m, rom = s.rom;
  let d2 = 0;
  for (let i = 0; i < 4; i++, d2 += 4) {
    const a = LBZ1_LayoutModRange + i * 8;
    if (d0 < rom.u16(a) || d0 > rom.u16(a + 2) || d1 < rom.u16(a + 4) || d1 > rom.u16(a + 6)) continue;
    // the first range ignores a small corner on the lower right
    if (d2 === 0 && !(d0 < 0x1580) && !(d1 < 0x400)) continue;
    // loc_3E48A
    const n = d2 + 4;
    m.setW(R.Events_bg, n);
    switch (n >> 2) {
      case 1: DO_MOD[1](m, rowPtr(m, 0) + 0x80); break; // LBZ1_LayoutMod1
      case 2: DO_MOD[2](m, rowPtr(m, 0x24) + 0x80); break; // LBZ1_LayoutMod2
      case 3: // LBZ1_LayoutMod3 (disabled once LBZ1_ModEndingLayout ran)
        if (m.w(R.Events_bg + 2)) { m.setW(R.Events_bg, 0); return -1; }
        DO_MOD[3](m, rowPtr(m, 0) + 0x94); break;
      default: DO_MOD[4](m, rowPtr(m, 0x30) + 0x94); break; // LBZ1_LayoutMod4
    }
    return 3 - i; // d3 = remaining dbf counter (>= 0)
  }
  return -1;
}

// LBZ1_LayoutExitMod1..4: restore the outside view
function lbz1ExitMod(s, d2) {
  const m = s.m;
  switch (d2 >> 2) {
    case 1: DO_MOD[1](m, rowPtr(m, 0) + 0x88); break;
    case 2: DO_MOD[2](m, rowPtr(m, 0x24) + 0x8a); break;
    case 3: DO_MOD[3](m, rowPtr(m, 0) + 0x98); break;
    default: DO_MOD[4](m, rowPtr(m, 0x30) + 0x9a); break;
  }
}

// LBZ1_ModEndingLayout
function lbz1ModEndingLayout(s) {
  const m = s.m, stride = fgWidth(m);
  let a1 = rowPtr(m, 0) + 0x74;
  for (let r = 0; r < 12; r++, a1 += stride) for (let i = 0; i < 4; i++) m.setB(a1 + i, 0);
  m.setW(R.Events_bg + 2, -1);
}

// LBZ1_EventVScroll: per-column FG Y offsets (HScroll_table+$148, used by the collapsing
// buildings at the end of act 1 once an object sets Events_fg_4), then the 12 column Y
// values at HScroll_table+$100 (pairs) and +$130.
function lbz1EventVScroll(s) {
  const m = s.m, rom = s.rom;
  const f4 = m.w(R.Events_fg_4);
  if (f4 !== 0) {
    if (f4 < 0) {
      m.setW(R.Events_fg_4, 1);
      m.setW(R.Special_V_int_routine, 4); // (Obj_LBZ1InvisibleBarrier skipped)
    }
    let a1 = HS + 0x14c;
    const d0 = m.l(a1 + 0x2c);
    m.setL(a1 + 0x2c, d0 + 0x100);
    let d1 = m.w(a1 + 0x30) >> 6;
    m.addW(a1 + 0x30, 1);
    let d2 = 0xa;
    for (let i = 0; i < 10; i++, a1 += 4) {
      d1 = (d1 + 2) & 0xe;
      const d4 = rom.s16(LBZ1_CollapseScrollSpeed + d1) << 4;
      let d5 = (m.l(a1) - d4 - d0) | 0;
      if (!(hi(d5) > -0x300)) { d5 = (-0x300 << 16) | (d5 & 0xffff); d2--; }
      m.setL(a1, d5);
    }
    if (d2 === 0) {
      m.setW(R.Screen_shake_flag, 0);
      m.setW(R.Events_fg_4, 0);
      m.setW(R.Special_V_int_routine, 0xc);
      lbz1ModEndingLayout(s);
      m.clear(HS + 0x148, 0xe * 4);
    }
  }
  // loc_3E434
  const d0 = m.w(R.Camera_Y_pos_copy);
  for (let i = 0; i < 12; i++) {
    const d2 = m.w(HS + 0x148 + i * 4) + d0;
    m.setW(HS + 0x100 + i * 4, d2);
    m.setW(HS + 0x130 + i * 2, d2);
  }
}

// DrawTilesVDeform (plane A): only the "rounded" bookkeeping matters here
function fgVDeformBookkeeping(s) {
  const m = s.m, mask = m.uw(R.Camera_Y_pos_mask);
  s.drawTileColumn(R.Camera_X_pos_copy, R.Camera_X_pos_rounded, m.w(R.Camera_Y_pos_copy), 0xf);
  for (let i = 0; i < 12; i++) m.setW(HS + 0x102 + i * 4, m.w(HS + 0x100 + i * 4) & mask);
  m.setW(R.Camera_Y_pos_rounded, m.w(R.Camera_Y_pos_copy) & mask);
}

// ------------------------------------------------------------------------------- LBZ1
export const LBZ1 = {
  screenInit(s) {
    const m = s.m, p = s.game.player;
    // FG rows $1C-$1F point just before row 1 (wrap rows above the top of the level)
    const d0 = m.w(LAYOUT_MAIN + 4) - 0x76;
    for (const o of [0x70, 0x74, 0x78, 0x7c]) m.setW(LAYOUT_MAIN + o, d0);
    m.clear(HS + 0x148, 0xe * 4);
    lbz1EventVScroll(s);
    const mask = m.uw(R.Camera_Y_pos_mask);
    for (let i = 0; i < 12; i++) m.setW(HS + 0x102 + i * 4, m.w(HS + 0x100 + i * 4) & mask);
    // (+ invisible barrier object); S3&K: always for Knuckles, without the barrier
    if (p.character_id === 2 || m.uw(R.Camera_X_pos_copy) >= 0x3b60) lbz1ModEndingLayout(s);
    lbz1CheckLayoutMod(s, u16(p.x_pos), u16(p.y_pos));
    s.resetTileOffsetPositionActual();
  },
  screenEvent(s) {
    const m = s.m, p = s.game.player;
    m.addW(R.Camera_Y_pos_copy, m.w(R.Screen_shake_offset));
    // S3&K LBZ1_KnuxLevelSizeAdjust: the top of the screen near the end of Knuckles' route
    if (p.character_id === 2 && u16(p.x_pos) >= 0x37c0 && u16(p.x_pos) <= 0x3800 && u16(p.y_pos) >= 0x600 && u16(p.y_pos) <= 0x680) {
      m.setW(R.Camera_min_Y_pos, u16(p.y_pos) >= 0x640 ? 0 : 0x40c);
    }
    if (m.w(R.Events_fg_4) === 0x55) {
      // the boss (object) asks for its chunk to be swapped in
      m.setW(R.Events_fg_4, 0);
      if (m.uw(R.Camera_Y_pos_copy) < 0x540) m.setB(rowPtr(m, 8) + 0x7d, 0xda);
      else m.setB(rowPtr(m, 0x4c) + 0x79, 0xdb);
      return; // Refresh_PlaneScreenDirect
    }
    const d0 = u16(p.x_pos), d1 = u16(p.y_pos);
    const d2 = m.w(R.Events_bg);
    if (d2 === 0) {
      if (lbz1CheckLayoutMod(s, d0, d1) >= 0) return; // Refresh_PlaneScreenDirect
    } else {
      const a = LBZ1_LayoutModExitRange - 4 + d2;
      if (d0 < s.rom.u16(a) || d0 > s.rom.u16(a + 2)) {
        m.setW(R.Events_bg, 0);
        lbz1ExitMod(s, d2);
        return; // Refresh_PlaneScreenDirect
      }
    }
    // loc_3E36E
    lbz1EventVScroll(s);
    fgVDeformBookkeeping(s);
  },
  bgInit(s) {
    const m = s.m;
    lbz1Deform(s);
    const { d0, d2 } = s.resetTileOffsetPositionEff();
    m.setW(HS + 2, d2);
    m.setL(HS + 4, 0);
    s.refreshPlaneTileDeform(d0, LBZ1_BGDrawArray, HS);
    s.applyDeformation(LBZ1_BGDeformArray, HS + 8);
  },
  // LBZ1BGE_Normal (Events_fg_5 = transition to act 2: not ported)
  bgEvent(s) {
    lbz1Deform(s);
    s.drawBG(LBZ1_BGDrawArray, HS, 0x20, 2);
    s.applyDeformation(LBZ1_BGDeformArray, HS + 8);
    s.applyFGVScroll(LBZ1_FGVScrollArray, HS + 0x12e);
    s.shakeScreenSetup();
  },
};

// LBZ1_Deform: BG Y = camera Y / 16, sky / far city bands at 1/16 .. camera X speeds
function lbz1Deform(s) {
  const m = s.m;
  const shake = m.w(R.Screen_shake_offset);
  m.setW(R.Camera_Y_pos_BG_copy, (s16(m.w(R.Camera_Y_pos_copy) - shake) >> 4) + shake);
  let d0 = (m.w(R.Camera_X_pos_copy) << 16) >> 4;
  let d1 = d0;
  d0 >>= 1;
  m.setW(R.Events_bg + 0x10, hi(d0));
  m.setW(R.Camera_X_pos_BG_copy, hi(d1));
  m.setW(HS, hi(d1));
  m.setW(HS + 8, hi(d1));
  d1 = (d1 + d0 + d0) | 0;
  d0 >>= 2;
  for (let i = 0; i < 4; i++) { m.setW(HS + 0xa + i * 2, hi(d1)); d1 = (d1 + d0) | 0; }
  for (const a of [R.Events_bg + 0x10, R.Camera_X_pos_BG_copy, HS, HS + 8]) m.addW(a, 0xa);
  m.addW(HS + 0xa, 4);
  m.addW(HS + 0xc, -2);
  m.addW(HS + 0xe, 7);
}

// ------------------------------------------------------------------------------- LBZ2
export const LBZ2 = {
  screenInit(s) {
    const m = s.m;
    m.setW(R.Events_routine_fg, 4);
    m.setL(R.Events_bg + 0x14, 0);
    m.setW(R._unkEEA0, 0);
    lbz2LayoutMod(s);
    s.resetTileOffsetPositionActual();
  },
  // LBZ2_ScreenEvent: routine 0 (LBZ2SE_FromTransition) only follows the act 1 transition
  screenEvent(s) {
    const m = s.m;
    m.addW(R.Camera_Y_pos_copy, m.w(R.Screen_shake_offset));
    if (m.w(R.Events_routine_fg) === 0) {
      if (u16(s.game.player.x_pos) >= 0x60a) { lbz2LayoutMod(s); m.addW(R.Events_routine_fg, 4); return; }
    }
    s.drawTilesAsYouMove();
  },
  bgInit(s) {
    const m = s.m;
    m.setW(R.Events_routine_bg, 8);
    lbz2Deform(s);
    const { d0 } = s.resetTileOffsetPositionEff();
    s.refreshPlaneFull(d0, 0);
    // keep the waterline art-reload value in range
    const v = m.w(R.Events_bg + 0x10);
    if (v > 0x40) m.setW(R.Events_bg + 0x10, 0x40);
    else if (v < -0x40) m.setW(R.Events_bg + 0x10, -0x40);
    s.applyDeformation(LBZ2_BGDeformArray, HS);
  },
  bgEvent(s) {
    const m = s.m;
    switch (m.w(R.Events_routine_bg)) {
      case 0: { // LBZ2BGE_FromTransition
        lbz2Deform(s);
        const { d0 } = s.resetTileOffsetPositionEff();
        m.setW(R.Draw_delayed_position, (d0 + 0xe0) & m.uw(R.Camera_Y_pos_mask));
        m.setW(R.Draw_delayed_rowcount, 0xf);
        m.addW(R.Events_routine_bg, 4);
        refresh(s);
        break;
      }
      case 4: // LBZ2BGE_Refresh
        lbz2Deform(s);
        refresh(s);
        break;
      default: // 8: LBZ2BGE_Normal (Events_fg_5 = Death Egg sequence: not ported)
        lbz2Deform(s);
        break;
    }
    // loc_3E8E2
    s.drawTileRow(R.Camera_Y_pos_BG_copy, R.Camera_Y_pos_BG_rounded, 0, 0x20);
    s.applyDeformation(LBZ2_BGDeformArray, HS);
    s.shakeScreenSetup();
  },
};

function refresh(s) {
  const m = s.m;
  if (s.drawPlaneVertBottomUp(0, m.w(R.Camera_Y_pos_BG_copy)) < 0) m.addW(R.Events_routine_bg, 4);
}

// LBZ2_LayoutMod
function lbz2LayoutMod(s) {
  const m = s.m;
  copyRows(m, rowPtr(m, 0) + 0x94, rowPtr(m, 0) + 6, 6, 6);
}

// LBZ2_Deform: BG Y follows the camera around the water line at $5F0 (~0.41x), above-water
// and below-water band sets, LBZ_WaterlineScroll_Data for the line itself, clouds, and the
// underwater waviness.
function lbz2Deform(s) {
  const m = s.m, rom = s.rom;
  const shake = m.w(R.Screen_shake_offset);
  let d0 = s16(m.w(R.Camera_Y_pos_copy) - shake - 0x5f0);
  const d1y = d0;
  d0 = (d0 << 16) >> 1;
  let d2 = d0 >> 3;
  d0 = (d0 - d2) | 0;
  d2 >>= 2;
  d0 = (d0 - d2) | 0;
  d2 = hi(d0);
  m.setW(R.Camera_Y_pos_BG_copy, d2 + 0x2c0 + shake);
  d2 = s16(d2 - d1y);
  m.setW(R.Events_bg + 0x10, d2);
  d0 = m.w(R.Camera_X_pos_copy) << 16;
  let d1, d3;
  if (d2 !== 0) {
    d1 = d0;
    d3 = d0 >> 6;
    d3 = (d3 - (d3 >> 3)) | 0;
    if (!(d2 > -0x40)) {
      let a1 = HS + 0x1e; // above water
      for (let i = 0; i < 64; i++) { m.setW(a1, hi(d1)); a1 += 2; d1 = (d1 - d3) | 0; }
    } else {
      let a1 = HS + 0x11e; // below water
      for (let i = 0; i < 64; i++) { a1 -= 2; m.setW(a1, hi(d1)); d1 = (d1 - d3) | 0; }
      if (d2 < 0x40) {
        // water line: per-line values picked from the band values by LBZ_WaterlineScroll_Data
        let a1w = HS + 0x9e;
        const a5 = HS + 0x9e;
        let a6 = LBZ_WaterlineScroll_Data;
        if (d2 >= 0) {
          a6 += ((-d2 + 0x40) & 0xffff) << 6;
          for (let i = 0; i < d2; i++) { m.setW(a1w, m.w(a5 + rom.u8at(a6++) * 2)); a1w += 2; }
        } else {
          a6 += ((d2 + 0x40) & 0xffff) << 6;
          for (let i = 0; i < -d2; i++) { a1w -= 2; m.setW(a1w, m.w(a5 + rom.u8at(a6++) * 2)); }
        }
      }
    }
  }
  // loc_3EB36: underwater area bands (written downwards from HScroll_table+$1E2)
  let a1 = HS + 0x1e2;
  d1 = d0 >> 1;
  d3 = d1 >> 3;
  m.setW(R.Camera_X_pos_BG_copy, hi(d1));
  a1 -= 2; m.setW(a1, hi(d1));
  d1 = (d1 - d3) | 0;
  m.setW(R.Events_bg + 0x12, hi(d1));
  a1 -= 2; m.setW(a1, hi(d1));
  d1 = (d1 - d3) | 0;
  for (let k = 0; k < 5; k++) {
    d1 = (d1 - d3) | 0;
    const n = rom.u16(LBZ2_BGUWDeformRange + k * 2);
    for (let i = 0; i <= n; i++) for (let j = 0; j < 4; j++) { a1 -= 2; m.setW(a1, hi(d1)); }
  }
  let cnt = 0x3f;
  let skip = false;
  if (d2 >= 0) { if (u16(d2) > 0x3f) skip = true; else cnt -= d2; }
  if (!skip) for (let i = 0; i <= cnt; i++) { a1 -= 2; m.setW(a1, hi(d1)); }
  // loc_3EB90: clouds
  d1 = d0 >> 6;
  d3 = d1;
  const d4c = m.l(HS + 0x1e2);
  m.setL(HS + 0x1e2, d4c + 0xe00);
  for (let i = 0; i < 13; i++) {
    const ofs = rom.u16(LBZ2_CloudDeformArray + i * 2);
    d1 = (d1 + d4c) | 0;
    m.setW(HS + ofs, hi(d1));
    d1 = (d1 + d3) | 0;
  }
  // the rest of the above-water deformation
  d1 = d0 >> 4;
  d3 = d1 >> 1;
  a1 = HS + 0x1a;
  m.setW(a1, hi(d1)); a1 += 2;
  d1 = (d1 + d3) | 0;
  m.setW(a1, hi(d1)); a1 += 2;
  let d4 = -1;
  let first = true; // run loc_3EBEE ($30 lines)
  if (d2 >= 0) d4 = 0xf;
  else {
    d4 = 0x3f + d2;
    if (d4 < 0) first = null; // skip both
    else if (d4 < 0x30) first = false;
    else d4 -= 0x30;
  }
  if (first !== null) {
    if (first) {
      for (let i = 0; i < 0x30; i++) { m.setW(a1, hi(d1)); a1 += 2; }
      d1 = (d1 + d3) | 0;
    }
    for (let i = 0; i <= d4; i++) { m.setW(a1, hi(d1)); a1 += 2; }
  }
  // loc_3EC0A: underwater waviness
  let n = 0x3f - d2;
  if (n < 0) return;
  n += 0x60;
  if (n >= 0xe0) n = 0xdf;
  a1 = HS + 0x1de;
  let a5 = LBZ_WaterWaveArray + ((m.w(R.Level_frame_counter) >> 1) & 0x7e);
  for (let i = 0; i <= n; i++) {
    a5 -= 2; a1 -= 2;
    m.setW(a1, m.w(a1) + rom.s16(a5));
  }
}
