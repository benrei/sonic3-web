// Hydrocity Zone screen / background events and deformation.
// Ported: HCZ1_ScreenInit/ScreenEvent, HCZ1_BackgroundInit, HCZ1BGE_Normal, HCZ1_Deform
// (incl. the water line scroll using HCZ_WaterlineScroll_Data); HCZ2_ScreenInit/ScreenEvent,
// HCZ2_BackgroundInit, HCZ2_BackgroundEvent (WallMoveInit / WallMove / NormalTransition /
// NormalRefresh / Normal), HCZ2_WallMove (moving wall BG + screen shake, sound effects
// skipped), HCZ2_Deform.
// Not ported: HCZ1BGE_DoTransition (seamless HCZ1->HCZ2 switch; Events_fg_5 in HCZ1 is
// raised by the end-of-act objects) and the Kos/PLC art queueing that goes with it.
import { R, s16 } from '../ram.js';

const HCZ1_BGDeformArray = 0x3c590;
const HCZ2_BGDeformArray = 0x3c7d2;
const HCZ2_BGDeformIndex = 0x3c800;
const HCZ_WaterlineScroll_Data = 0x6d000; // lea (HCZ_WaterlineScroll_Data).l,a6 in HCZ1_Deform
const Background_collision_flag = 0xfff664;

const HS = R.HScroll_table;
const hi = (v) => v >> 16;

// ------------------------------------------------------------------------------- HCZ1
export const HCZ1 = {
  screenInit(s) {
    s.m.setW(R.Events_bg + 0x16, 0);
    s.resetTileOffsetPositionActual();
  },
  screenEvent(s) { s.drawTilesAsYouMove(); },
  bgInit(s) {
    const m = s.m;
    hcz1Deform(s);
    const { d0 } = s.resetTileOffsetPositionEff();
    s.refreshPlaneFull(d0, 0);
    // cap the dynamic art reloading value at +-$60
    const e = m.w(R.Events_bg + 0x10);
    if (0x60 < e) m.setW(R.Events_bg + 0x10, 0x60);
    else if (-0x60 > e) m.setW(R.Events_bg + 0x10, -0x60);
    s.applyDeformation(HCZ1_BGDeformArray, HS);
  },
  // HCZ1BGE_Normal (Events_fg_5 -> act transition not ported)
  bgEvent(s) {
    hcz1Deform(s);
    s.drawTileRow(R.Camera_Y_pos_BG_copy, R.Camera_Y_pos_BG_rounded, 0, 0x20);
    s.applyDeformation(HCZ1_BGDeformArray, HS);
  },
};

// HCZ1_Deform: BG Y = (camY - $610) / 4 + $190 around the water line equilibrium; the
// 192 per-line values of the water band are a perspective ramp, with the water line itself
// drawn through HCZ_WaterlineScroll_Data.
function hcz1Deform(s) {
  const m = s.m;
  let d0 = s16(m.w(R.Camera_Y_pos_copy) - 0x610);
  let d1 = d0;
  d0 >>= 2;
  const d2 = s16(d0 - d1);
  m.setW(R.Camera_Y_pos_BG_copy, d0 + 0x190);
  m.setW(R.Events_bg + 0x10, d2);
  d0 = m.w(R.Camera_X_pos_copy) << 16;
  if (d2 !== 0) {
    d1 = d0;
    const d3 = d0 >> 7;
    if (!(d2 > -0x60)) {
      let a1 = HS + 0x1a;
      for (let i = 0; i < 0x30; i++) {
        m.setW(a1, hi(d1)); a1 += 2; d1 = (d1 - d3) | 0;
        m.setW(a1, hi(d1)); a1 += 2; d1 = (d1 - d3) | 0;
      }
    } else {
      let a1 = HS + 0x19a;
      for (let i = 0; i < 0x30; i++) {
        a1 -= 2; m.setW(a1, hi(d1)); d1 = (d1 - d3) | 0;
        a1 -= 2; m.setW(a1, hi(d1)); d1 = (d1 - d3) | 0;
      }
      if (d2 < 0x60) {
        let a1w = HS + 0xda;
        const a5 = a1w;
        let a6 = HCZ_WaterlineScroll_Data;
        if (d2 >= 0) { // water line displayed below the water level
          a6 += (0x60 - d2) * 0x60;
          for (let i = 0; i < d2; i++) { m.setW(a1w, m.w(a5 + m.ub(a6++) * 2)); a1w += 2; }
        } else { // above the water level
          a6 += (d2 + 0x60) * 0x60;
          for (let i = 0; i < -d2; i++) { a1w -= 2; m.setW(a1w, m.w(a5 + m.ub(a6++) * 2)); }
        }
      }
    }
  }
  // loc_3C4E2: the 13 bands above/below the water band
  d1 = d0 >> 5;
  d0 >>= 2;
  const pairs = [[0, 0x18], [2, 0x16], [4, 0x14], [6, 0x12], [8, 0x10], [0xa, 0xe], [0xc, 0x19a]];
  let d3 = 0, d4 = 0;
  pairs.forEach(([a, b], i) => {
    if (i) d0 = (d0 - d1) | 0;
    m.setW(HS + a, hi(d0)); m.setW(HS + b, hi(d0));
    if (i === 0) d3 = hi(d0);
    d4 = hi(d0);
  });
  if (d2 >= 0) {
    let a1 = HS + 0x1a;
    for (let i = 0; i < 0x60; i++) { m.setW(a1, d3); a1 += 2; }
    const n = 0x5f - d2;
    if (n >= 0) { a1 = HS + 0x19a; for (let i = 0; i <= n; i++) { a1 -= 2; m.setW(a1, d4); } }
  } else {
    let a1 = HS + 0xda;
    for (let i = 0; i < 0x60; i++) { m.setW(a1, d4); a1 += 2; }
    const n = 0x5f + d2;
    if (n >= 0) { a1 = HS + 0x1a; for (let i = 0; i <= n; i++) { m.setW(a1, d3); a1 += 2; } }
  }
}

// ------------------------------------------------------------------------------- HCZ2
export const HCZ2 = {
  screenInit(s) { s.resetTileOffsetPositionActual(); },
  screenEvent(s) {
    const m = s.m;
    m.addW(R.Camera_Y_pos_copy, m.w(R.Screen_shake_offset));
    s.drawTilesAsYouMove();
  },
  bgInit(s) {
    const m = s.m;
    if (m.uw(R.Camera_X_pos_copy) < 0xc00 && m.uw(R.Camera_Y_pos_copy) >= 0x500) {
      // the moving wall section at the start of the act
      m.setW(R.Events_routine_bg, 4);
      hcz2WallMove(s);
      const { d0, d1 } = s.resetTileOffsetPositionEff();
      s.refreshPlaneFull(d0, d1);
      s.plainDeformation();
      return;
    }
    m.setW(R.Events_routine_bg, 0x10);
    hcz2Deform(s);
    const { d0 } = s.resetTileOffsetPositionEff();
    s.refreshPlaneFull(d0, 0);
    s.applyDeformation(HCZ2_BGDeformArray, HS);
  },
  bgEvent(s) {
    const m = s.m;
    let r = m.w(R.Events_routine_bg);
    if (r === 0) { m.addW(R.Events_routine_bg, 4); r = 4; } // HCZ2BGE_WallMoveInit
    if (r === 4) { // HCZ2BGE_WallMove
      if (!m.w(R.Events_fg_5)) {
        hcz2WallMove(s);
        s.drawBGAsYouMove();
        s.plainDeformation();
        s.shakeScreenSetup();
        s.bgActualEffectiveDiff();
        m.setB(Background_collision_flag, 0);
        const p = s.game.player;
        const x = p.x_pos & 0xffff, y = p.y_pos & 0xffff;
        if (x >= 0x3f0 && x < 0xc10 && y >= 0x600 && y < 0x840) m.setB(Background_collision_flag, 0xff);
        return;
      }
      // loc_3C66C: wall finished (HCZ2_Resize at $C00), redraw the normal BG
      m.setW(R.Events_fg_5, 0);
      if (m.w(R.Screen_shake_flag) < 0) m.setW(R.Screen_shake_flag, 0);
      m.setB(Background_collision_flag, 0);
      m.setW(R.Draw_delayed_position, 0xf0);
      m.setW(R.Draw_delayed_rowcount, 0xf);
      m.addW(R.Events_routine_bg, 4);
      r = 8;
    }
    if (r === 8) { // HCZ2BGE_NormalTransition
      if (s.drawPlaneVertSingleBottomUp(0x400, 0) >= 0) { s.plainDeformation(); return; }
      hcz2Deform(s);
      const { d0 } = s.resetTileOffsetPositionEff();
      m.setW(R.Draw_delayed_position, (d0 + 0xe0) & m.uw(R.Camera_Y_pos_mask));
      m.setW(R.Draw_delayed_rowcount, 0xf);
      m.addW(R.Events_routine_bg, 4);
      refresh(s);
    } else if (r === 0xc) { // HCZ2BGE_NormalRefresh
      hcz2Deform(s);
      refresh(s);
    } else { // 0x10: HCZ2BGE_Normal
      hcz2Deform(s);
    }
    // loc_3C6D6
    s.drawTileRow(R.Camera_Y_pos_BG_copy, R.Camera_Y_pos_BG_rounded, 0, 0x20);
    s.applyDeformation(HCZ2_BGDeformArray, HS);
  },
};

// loc_3C6C0
function refresh(s) {
  const m = s.m;
  if (s.drawPlaneVertBottomUp(0, m.w(R.Camera_Y_pos_BG_copy)) < 0) m.addW(R.Events_routine_bg, 4);
}

// HCZ2_WallMove: the wall (a BG layer) slides left once Sonic passes $680
function hcz2WallMove(s) {
  const m = s.m, p = s.game.player;
  if (p.routine < 6) {
    const d0 = (p.x_pos & 0xffff) < 0xa88 ? 0xe000 : 0x14000;
    const d1 = m.w(R.Events_bg);
    let move = true;
    if (d1 === 0) {
      if ((p.x_pos & 0xffff) < 0x680) move = false;
      else m.setW(R.Screen_shake_flag, -1); // constant shake
    } else if (!(d1 > -0x600)) {
      // wall has travelled $600 pixels: timed shake (sfx_Crash skipped)
      if (m.w(R.Screen_shake_flag) < 0) m.setW(R.Screen_shake_flag, 0xe);
      move = false;
    }
    if (move) m.setL(R.Events_bg, m.l(R.Events_bg) - d0); // (sfx_Rumble2 every 16 frames skipped)
  }
  m.setW(R.Camera_Y_pos_BG_copy, m.w(R.Camera_Y_pos_copy) - 0x500);
  m.setW(R.Camera_X_pos_BG_copy, m.w(R.Camera_X_pos_copy) - 0x200 + m.w(R.Events_bg));
}

// HCZ2_Deform: BG Y = camY / 4, bands at 1/2 .. speeds from HCZ2_BGDeformIndex
function hcz2Deform(s) {
  const m = s.m;
  m.setW(R.Camera_Y_pos_BG_copy, m.w(R.Camera_Y_pos_copy) >> 2);
  let d0 = (m.w(R.Camera_X_pos_copy) << 16) >> 1;
  const d1 = d0 >> 3;
  let a5 = HCZ2_BGDeformIndex;
  for (;;) {
    const d3 = m.b(a5++);
    if (d3 < 0) break;
    for (let i = 0; i <= d3; i++) m.setW(HS + m.ub(a5++), hi(d0));
    d0 = (d0 - d1) | 0;
  }
  m.setW(R.Events_bg + 0x10, m.w(HS + 0x12) - m.w(HS + 0xa));
  m.setW(R.Events_bg + 0x12, m.w(HS + 6) - m.w(HS + 0x12));
  m.setW(R.Events_bg + 0x14, m.w(HS + 4) - m.w(HS + 0x12));
}
