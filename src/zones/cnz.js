// Carnival Night Zone screen / background events and deformation.
// Ported: CNZ1_ScreenInit, CNZ1_ScreenEvent (Refresh_PlaneScreenDirect request +
// DrawTilesAsYouMove), CNZ1_BackgroundInit, CNZ1BGE_Normal (incl. the switch to the
// miniboss arena BG at X $3000 and the $700 path adjustment), CNZ1BGE_BossStart,
// CNZ1BGE_Boss, CNZ1_Deform, CNZ1_BossLevelScroll(2); CNZ2_ScreenInit/ScreenEvent,
// CNZ2_BackgroundInit, CNZ2_BackgroundEvent (loc_3DA88 / loc_3DAB6 / loc_3DACC).
// Not ported: the miniboss arena chunk removal in CNZ1_ScreenEvent (Events_bg+0 is set by
// the miniboss), Obj_CNZMinibossScrollControl (the arena BG scroll offset Events_bg+8 stays
// 0, so CNZ1BGE_AfterBoss / FGRefresh / FGRefresh2 / DoTransition are never reached), and
// the Pal_CNZMiniboss palette line load.
import { R } from '../ram.js';

const CNZ1_BGDeformArray = 0x3da28;
const HS = R.HScroll_table;
const hi = (v) => v >> 16;

// CNZ1_ScreenEvent / CNZ2_ScreenEvent common part
function screenEvent(s) {
  const m = s.m;
  if (m.w(R.Events_bg + 6)) { m.setW(R.Events_bg + 6, 0); s.refreshPlaneScreenDirect(); return; }
  s.drawTilesAsYouMove();
}

function normalDeform(s) {
  s.drawTileRow(R.Camera_Y_pos_BG_copy, R.Camera_Y_pos_BG_rounded, 0, 0x20);
  s.applyDeformation(CNZ1_BGDeformArray, HS);
}

function bgInit(s) {
  cnz1Deform(s);
  const { d0 } = s.resetTileOffsetPositionEff();
  s.refreshPlaneFull(d0, 0);
  s.applyDeformation(CNZ1_BGDeformArray, HS);
}

// ------------------------------------------------------------------------------- CNZ1
export const CNZ1 = {
  screenInit(s) { s.resetTileOffsetPositionActual(); },
  screenEvent,
  bgInit,
  bgEvent(s) {
    const m = s.m;
    switch (m.w(R.Events_routine_bg)) {
      case 0: { // CNZ1BGE_Normal
        if (m.uw(R.Camera_X_pos_copy) < 0x3000) { cnz1Deform(s); normalDeform(s); return; }
        if (m.uw(R.Camera_Y_pos_copy) >= 0x54c) {
          // positional adjustment for the lower (Knuckles) path
          const d0 = 0x700, p = s.game.player;
          p.y_pos -= d0;
          m.addW(R.Camera_Y_pos, -d0);
          m.addW(R.Camera_Y_pos_copy, -d0);
          s.resetTileOffsetPositionActual();
        }
        cnz1BossLevelScroll(s);
        s.resetTileOffsetPositionEff();
        // (PalLoad_Line1 Pal_CNZMiniboss skipped)
        m.setW(R.Camera_min_Y_pos, 0x1c0);
        m.setW(R.Camera_target_min_Y_pos, 0x1c0);
        m.addW(R.Events_routine_bg, 4);
        s.drawBGAsYouMove();
        s.plainDeformation();
        return;
      }
      case 4: // CNZ1BGE_BossStart
        cnz1BossLevelScroll(s);
        s.drawBGAsYouMove();
        s.plainDeformation();
        return;
      default: // 8: CNZ1BGE_Boss (later routines need the miniboss scroll object)
        cnz1BossLevelScroll2(s);
        s.drawTileColumn(R.Camera_X_pos_BG_copy, R.Camera_X_pos_BG_rounded, 0x200, 0x10);
        s.plainDeformation();
        return;
    }
  },
};

// CNZ1_Deform: BG Y = 13/128 of camera Y; BG X bands at 7/16 .. 1/2 of camera X
function cnz1Deform(s) {
  const m = s.m;
  let d0 = (m.w(R.Camera_Y_pos_copy) << 16) >> 4;
  let d1 = d0 >> 1;
  d0 = (d0 + d1) | 0;
  d1 >>= 2;
  d0 = (d0 + d1) | 0;
  m.setW(R.Camera_Y_pos_BG_copy, hi(d0));
  d0 = (m.w(R.Camera_X_pos_copy) << 16) >> 1;
  d1 = d0 >> 3;
  let a1 = HS + 0xa;
  a1 -= 2; m.setW(a1, hi(d0));
  d0 = (d0 - d1) | 0;
  m.setW(R.Camera_X_pos_BG_copy, hi(d0));
  a1 -= 2; m.setW(a1, hi(d0));
  d0 = (d0 - d1 - d1) | 0;
  m.setW(R.Events_bg + 0x10, hi(d0)); // dynamic art reload speed (5/16)
  d0 = (d0 - d1) | 0;
  a1 -= 2; m.setW(a1, hi(d0));
  d0 = (d0 - d1 - d1) | 0;
  a1 -= 2; m.setW(a1, hi(d0));
  d0 = (d0 - d1) | 0;
  d1 >>= 1;
  d0 = (d0 - d1) | 0;
  a1 -= 2; m.setW(a1, hi(d0));
}

// CNZ1_BossLevelScroll
function cnz1BossLevelScroll(s) {
  const m = s.m;
  if (m.uw(R.Camera_Y_pos_BG_copy) >= 0x1e0) m.addW(R.Events_routine_bg, 4);
  cnz1BossLevelScroll2(s);
}

// CNZ1_BossLevelScroll2: the arena is part of the BG layout
function cnz1BossLevelScroll2(s) {
  const m = s.m;
  m.setW(R.Camera_Y_pos_BG_copy, m.w(R.Camera_Y_pos_copy) - 0x100 + m.w(R.Events_bg + 8));
  m.setW(R.Camera_X_pos_BG_copy, m.w(R.Camera_X_pos_copy) - 0x2f80);
}

// ------------------------------------------------------------------------------- CNZ2
export const CNZ2 = {
  screenInit(s) { s.resetTileOffsetPositionActual(); },
  screenEvent(s) {
    const m = s.m;
    m.addW(R.Camera_Y_pos_copy, m.w(R.Screen_shake_offset));
    screenEvent(s);
  },
  bgInit(s) {
    s.m.setW(R.Events_routine_bg, 8);
    bgInit(s);
  },
  bgEvent(s) {
    const m = s.m;
    switch (m.w(R.Events_routine_bg)) {
      case 0: { // loc_3DA88: redraw after the CNZ1 -> CNZ2 transition
        if (s.drawPlaneVertSingleBottomUp(0, 0x200) >= 0) { s.plainDeformation(); return; }
        cnz1Deform(s);
        const { d0 } = s.resetTileOffsetPositionEff();
        m.setW(R.Draw_delayed_position, (d0 + 0xe0) & m.uw(R.Camera_Y_pos_mask));
        m.setW(R.Draw_delayed_rowcount, 0xf);
        m.addW(R.Events_routine_bg, 4);
        cnz2Refresh(s);
        break;
      }
      case 4: // loc_3DAB6
        cnz1Deform(s);
        cnz2Refresh(s);
        break;
      default: // 8: loc_3DACC
        cnz1Deform(s);
        break;
    }
    normalDeform(s);
    s.shakeScreenSetup();
  },
};

// loc_3DABA
function cnz2Refresh(s) {
  const m = s.m;
  if (s.drawPlaneVertSingleBottomUp(0, m.w(R.Camera_Y_pos_BG_copy)) < 0) m.addW(R.Events_routine_bg, 4);
}
