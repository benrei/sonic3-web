// Angel Island Zone screen / background events and deformation.
// Ported: AIZ1_ScreenInit/ScreenEvent (DrawTilesAsYouMove part), AIZ1_BackgroundInit
// (post-intro path), AIZ1BGE_NormalRefresh/AIZ1BGE_Normal, AIZ1_Deform,
// AIZ1_ApplyDeformWater; AIZ2_ScreenInit/AIZ2SE_Normal, AIZ2_BackgroundInit,
// AIZ2_BackgroundEvent (Normal / ShipRefresh / ShipMove BG routines), AIZ2_Deform,
// AIZ2_ApplyDeform.
// Not ported: the AIZ1 intro deformation (this game starts after the intro), the AIZ1 tree
// reveal tile drawing (the chunk swaps are ported), the AIZ1->AIZ2 fire transition and the AIZ2
// bombership sequence (screen-event routines 4..16, Obj_AIZBattleship, AIZ2_DoShipLoop).
import { R, s16, u16 } from '../ram.js';

// ROM data (located by matching the tables of the disassembly against the ROM)
const AIZ1_BGDrawArray = 0x3b254; // $220, $7FFF
const AIZ1_DeformArray = 0x3b258;
const AIZ1_WaterFGDeformDelta = 0x3a170;
const AIZ1_WaterBGDeformDelta = 0x3a3b0;
const AIZ2_BGDeformArray = 0x3bc06;
const AIZ2_BGDeformMake = 0x3bc38;
const AIZ2_FGDeformDelta = 0x3bc5a;
const AIZ2_ALZ_BGDeformDelta = 0x3be5a;

const HS = R.HScroll_table;

// ------------------------------------------------------------------------------- AIZ1
export const AIZ1 = {
  screenInit(s) { s.resetTileOffsetPositionActual(); },
  // AIZ1_ScreenEvent: DrawTilesAsYouMove + the hollow tree's chunk swaps (Events_fg_4 is
  // counted up by Obj_AIZ1TreeRevealControl, objects-aiz.js)
  screenEvent(s) {
    s.drawTilesAsYouMove();
    aiz1TreeChunks(s);
  },
  // AIZ1_BackgroundInit, "not in the intro" branch (loc_3ACE6)
  bgInit(s) {
    const m = s.m;
    m.setW(R.Events_routine_bg, 8);
    const d2 = aiz1Deform(s);
    const { d0 } = s.resetTileOffsetPositionEff();
    m.setL(HS, 0);
    m.setW(HS + 6, d2);
    s.refreshPlaneTileDeform(d0, AIZ1_BGDrawArray, HS);
    aiz1ApplyDeformWater(s);
  },
  bgEvent(s) {
    const m = s.m;
    switch (m.w(R.Events_routine_bg)) {
      case 4: { // AIZ1BGE_NormalRefresh (after the intro): delayed redraw of the whole BG
        aiz1Deform(s);
        const r = s.drawPlaneVertBottomUpComplex(m.w(R.Camera_Y_pos_BG_copy), AIZ1_BGDrawArray, HS - 4);
        if (r < 0) m.addW(R.Events_routine_bg, 4);
        break;
      }
      default: // 8: AIZ1BGE_Normal (Events_fg_5 would start the fire transition: not ported)
        aiz1Deform(s);
        break;
    }
    // loc_3ADAC
    s.drawBG(AIZ1_BGDrawArray, HS, 0x20, 2);
    aiz1ApplyDeformWater(s);
  },
};

// AIZ1_ScreenEvent, tree part: AIZ1SE_ChangeChunk1-4 copy the "revealed" tree chunks stored at
// columns 0-1 of layout rows 0-3 over columns $59-$5A of rows 5-8 as the player climbs.
// Not ported: the gradual AIZ_TreeReveal tile-row drawing into plane A (the renderer draws
// plane A straight from the layout, so each swap shows up at once).
function aiz1TreeChunks(s) {
  const m = s.m;
  const d0 = m.uw(R.Events_fg_4);
  if (!d0) return;
  const row = (r) => { const p = m.uw(0xff8008 + r * 4); return p & 0x8000 ? 0xff0000 | p : p; };
  const change = (dst, src) => {
    const a1 = row(dst), a5 = row(src);
    m.setB(a1 + 0x59, m.ub(a5));
    m.setB(a1 + 0x5a, m.ub(a5 + 1));
  };
  let first;
  if (m.uw(R.Camera_X_pos_copy) >= 0x2d30 || d0 >= 0x39) { // AIZ1SE_ChangeChunk1
    m.setW(R.Events_fg_4, 0);
    first = 5;
  } else if (d0 >= 0x34) first = 6;
  else if (d0 >= 0x24) first = 7;
  else if (d0 >= 0x14) first = 8;
  else return;
  for (let r = first; r <= 8; r++) change(r, r - 5);
}

// AIZ1_Deform: Camera_Y_pos_BG = Camera_Y / 2; band X positions in HScroll_table.
// Returns d2 (used by the init code for HScroll_table+6).
function aiz1Deform(s) {
  const m = s.m;
  m.setW(R.Camera_Y_pos_BG_copy, m.w(R.Camera_Y_pos_copy) >> 1);
  const base = (s16(m.w(R.Camera_X_pos_copy) - 0x1300) << 16) >> 5; // (x - $1300) / 32, 16.16
  let d2 = base;
  const d1 = base * 2;
  let d0 = base * 14;
  const hi = (v) => v >> 16;
  const a1 = HS + 0x30;
  m.setW(a1, hi(d0));
  d0 = (d0 + d1) | 0;
  m.setW(a1 - 0x2c, hi(d0)); m.setW(a1 + 2, hi(d0)); m.setW(a1 + 0xa, hi(d0));
  d0 = (d0 + d1) | 0;
  m.setW(a1 + 4, hi(d0)); m.setW(a1 + 8, hi(d0));
  d0 = (d0 + d1) | 0;
  m.setW(a1 + 6, hi(d0));
  // clouds: six bands drifting with the auto-scroll accumulator at HScroll_table+$3C
  let p = HS + 0x16;
  p -= 2; m.setW(p, hi(d2));
  const d3 = m.l(HS + 0x3c);
  m.setL(HS + 0x3c, d3 + 0x2000);
  d0 = d2 >> 1;
  for (let i = 0; i < 6; i++) {
    d0 = (d0 + d3) | 0;
    p -= 2; m.setW(p, hi(d0));
    d0 = (d0 + d2) | 0;
  }
  // 13 per-line values of the per-line band
  p = HS + 0x16;
  d0 = d2;
  d2 >>= 3;
  for (let i = 0; i < 13; i++) {
    d0 = (d0 + d2) | 0;
    m.setW(p, hi(d0)); p += 2;
  }
  return d2;
}

// AIZ1_ApplyDeformWater
function aiz1ApplyDeformWater(s) {
  const m = s.m;
  let d1 = s16(m.w(R.Water_level) - m.w(R.Camera_Y_pos_copy));
  if (d1 >= 0xe0) { s.applyDeformation(AIZ1_DeformArray, HS + 8); return; }
  d1 = s16(d1 - 1);
  const a1 = s.applyDeformation3(AIZ1_DeformArray, HS + 8, d1);
  let d0 = m.w(R.Water_level);
  d1 = s16(0xde - d1);
  let d2 = (m.w(R.Level_frame_counter) + d0 + d0) & 0x7e;
  s.makeFGDeformArray(HS + 0x40, AIZ1_WaterFGDeformDelta + d2, -m.w(R.Camera_X_pos_copy), d1);
  d0 = s16(m.w(R.Water_level) - m.w(R.Camera_Y_pos_copy) + m.w(R.Camera_Y_pos_BG_copy));
  d2 = ((m.w(R.Level_frame_counter) >> 1) + d0 + d0) & 0x7e;
  s.applyFGandBGDeformation(a1, HS + 0x40, AIZ1_DeformArray, HS + 8, AIZ1_WaterBGDeformDelta + d2, d0, d1);
}

// ------------------------------------------------------------------------------- AIZ2
export const AIZ2 = {
  screenInit(s) { s.resetTileOffsetPositionActual(); },
  // AIZ2_ScreenEvent / AIZ2SE_Normal (Events_fg_4 = bombership start is never raised here)
  screenEvent(s) {
    const m = s.m;
    m.addW(R.Camera_Y_pos_copy, m.w(R.Screen_shake_offset));
    s.drawTilesAsYouMove();
  },
  bgInit(s) {
    const m = s.m;
    m.setW(R.Events_fg_0, m.w(R.Camera_X_pos_copy));
    m.setW(R.Events_fg_1, m.w(R.Camera_X_pos_copy));
    m.setW(R.Events_routine_bg, 0xc);
    if (m.uw(R.Camera_X_pos_copy) >= 0x3e80) {
      m.setW(R.Events_routine_bg, 0x14);
      m.setW(R.Events_bg + 2, 0x4440);
    }
    aiz2Deform(s);
    const { d0 } = s.resetTileOffsetPositionEff();
    s.refreshPlaneFull(d0, 0);
    aiz2ApplyDeform(s);
  },
  bgEvent(s) {
    const m = s.m;
    s.adjustBGDuringLoop(R.Events_fg_0, m.w(R.Camera_X_pos_copy), 0x100, 0x200);
    const drawRowAndDeform = () => {
      s.drawTileRow(R.Camera_Y_pos_BG_copy, R.Camera_Y_pos_BG_rounded, 0, 0x20);
      aiz2ApplyDeform(s);
      s.shakeScreenSetup();
    };
    switch (m.w(R.Events_routine_bg)) {
      case 0xc: { // AIZ2BGE_Normal
        aiz2Deform(s);
        if (!m.w(R.Events_fg_5)) { drawRowAndDeform(); return; } // loc_3B5C8
        // the bombership is coming: shift the BG down/up to the sky section and redraw it
        m.setW(R.Events_fg_5, 0);
        const d0 = m.uw(R.Camera_Y_pos_copy) < 0x400 ? 0xa8 : -0x198;
        m.setW(R.Events_bg + 0x16, d0);
        m.addW(R.Camera_Y_pos_BG_copy, d0);
        const r = s.resetTileOffsetPositionEff();
        m.setW(R.Draw_delayed_position, (r.d0 + 0xe0) & m.uw(R.Camera_Y_pos_mask));
        m.setW(R.Draw_delayed_rowcount, 0xf);
        m.setW(R.Events_bg + 2, 0x4440);
        m.addW(R.Events_routine_bg, 4);
        shipRefresh(s);
        return;
      }
      case 0x10: // AIZ2BGE_ShipRefresh
        aiz2Deform(s);
        shipRefresh(s);
        return;
      default: // 0x14: AIZ2BGE_ShipMove
        aiz2Deform(s);
        drawRowAndDeform(); // (Events_bg+4 = bombership V-scroll split is never set here)
        return;
    }
  },
};

// loc_3B5E4
function shipRefresh(s) {
  const m = s.m;
  if (s.drawPlaneVertBottomUp(0, m.w(R.Camera_Y_pos_BG_copy)) < 0) m.addW(R.Events_routine_bg, 4);
  s.drawTileRow(R.Camera_Y_pos_BG_copy, R.Camera_Y_pos_BG_rounded, 0, 0x20);
  aiz2ApplyDeform(s);
  s.shakeScreenSetup();
}

// AIZ2_Deform: BG Y = half the camera Y (shake applied fully); band X values at
// HScroll_table+$1C0 built from AIZ2_BGDeformMake, speeds 3/64 steps of Events_fg_1 / 2.
function aiz2Deform(s) {
  const m = s.m;
  const shake = m.w(R.Screen_shake_offset);
  m.setW(R.Camera_Y_pos_BG_copy, (s16(m.w(R.Camera_Y_pos_copy) - shake) >> 1) + shake);
  if (m.uw(R.Events_routine_bg) >= 0x10) m.addW(R.Camera_Y_pos_BG_copy, m.w(R.Events_bg + 0x16));
  let d0 = (m.w(R.Events_fg_1) << 16) >> 1;
  let d1 = d0 >> 5;
  d1 = (d1 * 3) | 0;
  const a1 = HS + 0x1c0;
  let a5 = AIZ2_BGDeformMake;
  for (;;) {
    const d3 = m.b(a5++);
    if (d3 < 0) return;
    for (let i = 0; i <= d3; i++) m.setW(a1 + m.ub(a5++), d0 >> 16);
    d0 = (d0 + d1) | 0;
  }
}

// AIZ2_ApplyDeform: FG heat/water waviness into HScroll_table, then FG + BG lines.
function aiz2ApplyDeform(s) {
  const m = s.m;
  const frame = m.w(R.Level_frame_counter);
  let a1 = HS;
  let a6 = AIZ2_FGDeformDelta;
  let d0 = m.w(R.Camera_Y_pos_copy);
  let d1 = 0xdf;
  let d2 = frame + d0 + d0;
  let d3 = 0x3e;
  const d6 = -m.w(R.Camera_X_pos_copy);
  let d4 = u16(m.w(R.Water_level) - d0);
  let water = false;
  if (d4 === 0 || u16(m.w(R.Water_level)) < u16(d0)) water = true; // bls: fully underwater
  else if (d4 <= d1) { // water line on screen
    d1 = d4 - 1;
    d2 &= d3;
    [a1] = s.makeFGDeformArray(a1, a6 + d2, d6, d1);
    d0 = m.w(R.Water_level);
    d1 = 0xde - d1;
    d2 = frame + d0 + d0;
    water = true;
  }
  if (water) { a6 = AIZ1_WaterFGDeformDelta; d3 = 0x7e; }
  d2 &= d3;
  s.makeFGDeformArray(a1, a6 + d2, d6, d1);

  // background
  a1 = R.H_scroll_buffer;
  let a2 = HS;
  a6 = AIZ2_ALZ_BGDeformDelta;
  d0 = m.w(R.Camera_Y_pos_BG_copy);
  d1 = 0xdf;
  d2 = (frame >> 1) + d0 + d0;
  d3 = 0x3e;
  const cy = m.w(R.Camera_Y_pos_copy);
  d4 = u16(m.w(R.Water_level) - cy);
  water = false;
  if (d4 === 0 || u16(m.w(R.Water_level)) < u16(cy)) water = true;
  else if (d4 <= d1) {
    d1 = d4 - 1;
    d2 &= d3;
    [a1, a2] = s.applyFGandBGDeformation(a1, a2, AIZ2_BGDeformArray, HS + 0x1c0, a6 + d2, d0, d1);
    d0 = s16(m.w(R.Water_level) - cy + m.w(R.Camera_Y_pos_BG_copy));
    d1 = 0xde - d1;
    d2 = (frame >> 1) + d0 + d0;
    water = true;
  }
  if (water) { a6 = AIZ1_WaterBGDeformDelta; d3 = 0x7e; }
  d2 &= d3;
  s.applyFGandBGDeformation(a1, a2, AIZ2_BGDeformArray, HS + 0x1c0, a6 + d2, d0, d1);
}
