// Marble Garden Zone screen / background events and deformation.
// Ported: MGZ1_ScreenInit/ScreenEvent, MGZ1_BackgroundInit, MGZ1BGE_Normal, MGZ1_Deform;
// MGZ2_ScreenInit, MGZ2_ScreenEvent (MGZ2SE_Normal: MGZ2_ChunkEvent incl. MGZ2_ModifyChunk,
// minus the FG plane redraw which is implicit here), MGZ2_BackgroundInit,
// MGZ2_BackgroundEvent (GoRefresh / Normal / Refresh), MGZ2_BGDeform (all 4 modes),
// MGZ2_ClearBottomBG, MGZ2_BGEventTrigger, Obj_MGZ2BGMoveKnux / Obj_MGZ2BGMoveSonic (the
// BG-offset movers, run inline), Apply_FGVScroll call.
// Not ported (object driven): MGZ2_QuakeEvent (needs Obj_MGZ2DrillingRobotnik to end the
// quake, otherwise the camera would stay locked), MGZ2SE_Collapse / MGZ2_LevelCollapse and
// MGZ2SE_MoveBG (end boss), the MGZ1->MGZ2 transition (MGZ1BGE_Transition), Do_ShakeSound
// (sound only). BG collision (Background_collision_flag) is set but not used by the player.
import { R, s16 } from '../ram.js';

const MGZ1_BGDeformArray = 0x3c9f8;
const MGZ2_ChunkEventArray = 0x3cf7c;
const MGZ2_ChunkReplaceArray = 0x3cffc;
const MGZ2_FGVScrollArray = 0x3d070;
const MGZ2_BGDrawArray = 0x3d494;
const MGZ2_BGDeformArray = 0x3d498;
const MGZ2_BGDeformIndex = 0x3d4c8;
const MGZ2_BGDeformOffset = 0x3d4e6;
const MGZ2_QuakeChunks = 0x1cbbb4; // lea (MGZ2_QuakeChunks).l,a4 in sub_3CF00

const HS = R.HScroll_table;
const BG_LAYOUT = 0xff800a; // a3 in background events (Level_layout_main + 2)

// ------------------------------------------------------------------------------- MGZ1
export const MGZ1 = {
  screenInit(s) {
    s.m.setW(R.Events_bg + 0x16, 0);
    s.resetTileOffsetPositionActual();
  },
  screenEvent(s) {
    const m = s.m;
    m.addW(R.Camera_Y_pos_copy, m.w(R.Screen_shake_offset));
    s.drawTilesAsYouMove();
  },
  bgInit(s) {
    mgz1Deform(s);
    s.refreshPlaneFull(0, 0);
    s.applyDeformation(MGZ1_BGDeformArray, HS);
  },
  // MGZ1BGE_Normal (Events_fg_5 -> act transition is not ported)
  bgEvent(s) {
    mgz1Deform(s);
    s.applyDeformation(MGZ1_BGDeformArray, HS);
    s.shakeScreenSetup();
  },
};

// MGZ1_Deform: BG Y fixed (only the shake), 14 bands of X speeds + drifting clouds
function mgz1Deform(s) {
  const m = s.m;
  m.setW(R.Camera_Y_pos_BG_copy, m.w(R.Screen_shake_offset));
  let d0 = (m.w(R.Camera_X_pos_copy) << 16) >> 2;
  const d1 = d0 >> 4;
  let a1 = HS + 0x1c;
  for (let i = 0; i < 9; i++) { a1 -= 2; m.setW(a1, d0 >> 16); d0 = (d0 - d1) | 0; }
  let d2 = m.l(HS + 0x1c);
  m.setL(HS + 0x1c, d2 + 0x500);
  d0 >>= 1;
  a1 = HS;
  for (let i = 0; i < 5; i++) {
    d0 = (d0 + d2) | 0;
    d2 = (d2 + 0x500) | 0;
    m.setW(a1, d0 >> 16); a1 += 2;
    d0 = (d0 + d1) | 0;
  }
  const t = m.w(a1 - 2);
  m.setW(a1 - 2, m.w(a1 - 4));
  m.setW(a1 - 4, t);
}

// ------------------------------------------------------------------------------- MGZ2
export const MGZ2 = {
  screenInit(s) {
    const m = s.m;
    m.setL(R.Events_bg + 0x10, 0);
    m.setL(R.Events_bg + 0x14, 0);
    s.resetTileOffsetPositionActual();
  },
  // MGZ2_ScreenEvent / MGZ2SE_Normal (Events_fg_4 = collapse start comes from the boss)
  screenEvent(s) {
    const m = s.m;
    m.addW(R.Camera_Y_pos_copy, m.w(R.Screen_shake_offset));
    mgz2ChunkEvent(s);
    s.drawTilesAsYouMove();
  },
  bgInit(s) {
    const m = s.m, p = s.game.player;
    mgz2ClearBottomBG(s);
    m.setW(R.Events_routine_bg, 4);
    m.setW(R._unkEEA2, 0); // _unkEEA2: VScroll routine flag
    const x = p.x_pos & 0xffff, y = p.y_pos & 0xffff;
    let mover = null;
    if (y < 0x500) {
      if (x >= 0x3800) {
        m.setW(R.Events_bg, 4);
        if (x < 0x3a80) mover = 'knux';
        else m.setW(R.Events_bg + 2, 0x220);
      }
    } else if (y >= 0x800) {
      if (x >= 0x34c0) {
        m.setW(R.Events_bg, 8);
        if (x < 0x3800) mover = 'sonic';
        else m.setW(R.Events_bg + 2, 0x1d0);
      }
    } else if (x >= 0x3900) {
      m.setW(R.Events_bg, 0xc);
      m.setW(R.Events_bg + 2, 0x1d0);
      m.setW(R.Events_bg + 0xe, -1);
      m.setL(HS + 0x38, 0);
    }
    if (mover) startMover(s, mover);
    const d2 = mgz2BGDeform(s);
    const { d0 } = s.resetTileOffsetPositionEff();
    m.setL(HS, 0);
    m.setW(HS + 6, d2);
    s.refreshPlaneTileDeform(d0, MGZ2_BGDrawArray, HS);
    s.applyDeformation(MGZ2_BGDeformArray, HS + 8);
  },
  bgEvent(s) {
    const m = s.m;
    runMover(s);
    switch (m.w(R.Events_routine_bg)) {
      case 0: // MGZ2BGE_GoRefresh
        mgz2ClearBottomBG(s);
        m.setL(HS, 0);
        m.addW(R.Events_routine_bg, 4);
        goRefresh(s);
        return;
      case 4: // MGZ2BGE_Normal
        if (mgz2BGEventTrigger(s)) { goRefresh(s); return; }
        mgz2BGDeform(s);
        normal(s);
        return;
      default: // 8: MGZ2BGE_Refresh
        mgz2BGDeform(s);
        refresh(s);
        return;
    }
  },
};

// loc_3D190
function goRefresh(s) {
  const m = s.m;
  const d2 = mgz2BGDeform(s);
  const { d0 } = s.resetTileOffsetPositionEff();
  m.setW(HS + 6, d2);
  m.setW(R.Draw_delayed_position, (d0 + 0xe0) & m.uw(R.Camera_Y_pos_mask));
  m.setW(R.Draw_delayed_rowcount, 0xf);
  m.addW(R.Events_routine_bg, 4);
  refresh(s);
}

// loc_3D1B8
function refresh(s) {
  const m = s.m;
  if (s.drawPlaneVertBottomUpComplex(m.w(R.Camera_Y_pos_BG_copy), MGZ2_BGDrawArray, HS - 4) < 0) m.addW(R.Events_routine_bg, -4);
  normal(s);
}

// loc_3D160
function normal(s) {
  s.drawBG(MGZ2_BGDrawArray, HS, 0x20, 2);
  s.applyDeformation(MGZ2_BGDeformArray, HS + 8);
  s.applyFGVScroll(MGZ2_FGVScrollArray, HS + 0x126);
  s.bgActualEffectiveDiff();
  s.shakeScreenSetup();
}

// MGZ2_BGDeform: returns d2 (used for HScroll_table+6 by the init/refresh code)
function mgz2BGDeform(s) {
  const m = s.m;
  const mode = m.w(R.Events_bg);
  if (mode === 4 || mode === 8) {
    // loc_3D1F4 / loc_3D1EA: BG moved as a solid layer (offset Events_bg+2)
    const d1 = mode === 4 ? 0x1e0 : 0x8f0, d2 = mode === 4 ? 0x3580 : 0x3200;
    m.setW(R.Camera_Y_pos_BG_copy, m.w(R.Camera_Y_pos_copy) - d1 + m.w(R.Events_bg + 2));
    const x = s16(m.w(R.Camera_X_pos_copy) - d2);
    m.setW(R.Camera_X_pos_BG_copy, x);
    m.setW(HS + 4, x);
    m.setW(HS + 0x36, x);
  } else {
    // loc_3D21E / loc_3D220: BG Y = 3/16 of (camera Y - offset), shake added back
    const d1 = mode === 0xc ? 0x500 : 0;
    const d2 = m.w(R.Screen_shake_offset);
    let d0 = (s16(m.w(R.Camera_Y_pos_copy) - d2 - d1) << 16) >> 4;
    d0 = (d0 * 3) | 0;
    m.setW(R.Camera_Y_pos_BG_copy, (d0 >> 16) + d2);
    m.setW(R.Camera_X_pos_BG_copy, 0);
    m.setW(HS + 4, 0);
    m.setW(HS + 0x36, 0);
  }
  // loc_3D24C
  let x = m.w(R.Camera_X_pos_copy);
  if (m.w(R.Events_routine_fg) === 8) x = m.w(R.Events_bg + 0xc);
  let d0 = (x << 16) >> 1;
  let d1 = d0 >> 3;
  let d2 = d1 >> 2;
  let a1 = HS + 0x36;
  for (let i = 0; i < 8; i++) { a1 -= 2; m.setW(a1, d0 >> 16); d0 = (d0 - d1) | 0; }
  if (!m.w(R.Events_bg + 0xe)) m.setL(HS + 0x38, m.l(HS + 0x38) + 0x800);
  d1 = m.l(HS + 0x38);
  a1 = HS + 8;
  let a5 = MGZ2_BGDeformIndex;
  d0 = d2;
  d2 >>= 1;
  for (let i = 0; i < 15; i++) {
    const d4 = m.w(a5); a5 += 2;
    d0 = (d0 + d1) | 0;
    m.setW(a1 + d4, d0 >> 16);
    d0 = (d0 + d2) | 0;
  }
  a5 = MGZ2_BGDeformOffset;
  for (let i = 0; i < 23; i++) { m.setW(a1, m.w(a1) + m.w(a5)); a1 += 2; a5 += 2; }
  return d2;
}

// MGZ2_ClearBottomBG: the last three BG rows point into row 0 + 8
function mgz2ClearBottomBG(s) {
  const m = s.m;
  const d0 = m.w(BG_LAYOUT) + 8;
  m.setW(BG_LAYOUT + 0x74, d0);
  m.setW(BG_LAYOUT + 0x78, d0);
  m.setW(BG_LAYOUT + 0x7c, d0);
}

// MGZ2_BGEventTrigger: returns true (d0 = -1) when the BG must be refreshed
function mgz2BGEventTrigger(s) {
  const m = s.m, p = s.game.player;
  if (m.w(R._unkEEA2)) return false;
  const x = p.x_pos & 0xffff, y = p.y_pos & 0xffff;
  const BGC = 0xfff664; // Background_collision_flag
  switch (m.w(R.Events_bg)) {
    case 0: // loc_3D376
      m.setB(BGC, 0);
      if (y < 0x80) return false;
      if (y < 0x180) {
        if (x < 0x3800) return false;
        m.setW(R.Events_bg, 4); m.setW(R.Events_bg + 2, 0); startMover(s, 'knux');
        return false;
      }
      if (y < 0x800 || y >= 0x900 || x < 0x34c0) return false;
      m.setW(R.Events_bg, 8); m.setW(R.Events_bg + 2, 0); startMover(s, 'sonic');
      return false;
    case 4: // loc_3D348
      m.setB(BGC, 0xff);
      if (y < 0x100 && x >= 0x3c00) m.setB(BGC, 0);
      if (y < 0x80 || y >= 0x180 || x >= 0x3800) return false;
      m.setW(R.Events_bg, 0);
      return true;
    case 8: { // loc_3D310
      m.setB(BGC, 0xff);
      let d0;
      if (y < 0x800) {
        if (x < 0x3900) return false;
        m.setW(R.Events_bg + 0xe, -1);
        m.setL(HS + 0x38, 0);
        d0 = 0xc;
      } else {
        if (y >= 0x900 || x >= 0x34c0) return false;
        d0 = 0;
      }
      m.setW(R.Events_bg, d0);
      return true;
    }
    default: // $C: after the BG move
      m.setB(BGC, 0);
      if (y < 0x800 || x < 0x3a40) return false;
      m.setW(R.Events_bg, 8);
      return false;
  }
}

// Obj_MGZ2BGMoveKnux / Obj_MGZ2BGMoveSonic, kept in Scroll.state instead of object RAM
function startMover(s, kind) {
  s.state.mgzMover = kind === 'knux'
    ? { mode: 4, y: 0x400, x: 0x38a0, target: 0x220, vel: 0x6000, sonic: false, stage: 0, pos: 0, done: false }
    : { mode: 8, y: 0xa80, x: 0x36d0, target: 0x1d0, vel: 0x6000, sonic: true, stage: 0, pos: 0, done: false };
}

function runMover(s) {
  const o = s.state.mgzMover;
  if (!o) return;
  const m = s.m, p = s.game.player;
  if (o.stage === 0) {
    if (m.w(R.Events_bg) !== o.mode) { s.state.mgzMover = null; return; }
    if (!(o.y < (p.y_pos & 0xffff)) || !(o.x < (p.x_pos & 0xffff))) return;
    m.setW(R.Camera_min_X_pos, m.w(R.Camera_X_pos_copy));
    m.setW(R.Camera_target_min_X_pos, m.w(R.Camera_X_pos_copy));
    o.stage = 1;
  }
  // loc_3D426
  const d0 = m.uw(R.Events_bg + 2);
  if (d0 >= o.target) { m.setW(R.Screen_shake_flag, 0xe); s.state.mgzMover = null; return; }
  let d1;
  if (o.done) d1 = d0 + 1;
  else {
    const x = p.x_pos & 0xffff, y = p.y_pos & 0xffff;
    if (o.sonic ? x >= 0x3d50 : (y < 0x200 && x < 0x3cb0)) o.done = true;
    o.pos = (o.pos + o.vel) | 0;
    d1 = o.pos >>> 16;
  }
  m.setW(R.Events_bg + 2, d1);
  p.y_pos = s16(p.y_pos - (d1 - d0));
}

// MGZ2_ChunkEvent: the floors that sink during the quake sections (chunk RAM rewrites)
function mgz2ChunkEvent(s) {
  const m = s.m, p = s.game.player;
  switch (m.w(R.Events_bg + 4)) {
    case 0: { // MGZ2_ChunkEventCheck
      const x = p.x_pos & 0xffff, y = p.y_pos & 0xffff;
      let a1 = MGZ2_ChunkEventArray;
      for (let d2 = 4; d2 <= 12; d2 += 4, a1 += 12) {
        if (x < m.uw(a1) || x >= m.uw(a1 + 2) || y < m.uw(a1 + 4) || y >= m.uw(a1 + 6)) continue;
        if (d2 === 4 && !(m.w(R.Screen_shake_flag) < 0)) continue;
        m.setW(R.Events_bg + 4, d2);
        m.setW(R.Events_bg + 6, 0);
        m.setW(R.Events_bg + 8, 0);
        m.setW(R.Events_bg + 0xa, m.w(a1 + 8));
        m.setW(R.Events_bg + 0xc, m.w(a1 + 10));
        chunkStep(s, d2 === 4);
        return;
      }
      return;
    }
    case 4: chunkStep(s, true); return; // MGZ2_ChunkEvent1
    case 8: case 0xc: chunkStep(s, false); return; // MGZ2_ChunkEvent2_3
    case 0x10: // MGZ2_ChunkEventReset
      if ((p.x_pos & 0xffff) < 0x2a00) return;
      m.setW(R.Events_bg + 4, 0);
      modifyChunk(s, 0x5c);
      return;
    default: return;
  }
}

function chunkStep(s, first) {
  const m = s.m;
  const d0 = m.w(R.Events_bg + 6);
  if (d0 >= 0x5c) {
    if (first) {
      m.setW(R.Screen_shake_flag, 0);
      m.setW(R.Camera_min_X_pos, 0); m.setW(R.Camera_target_min_X_pos, 0);
      m.setW(R.Events_bg + 4, 0x10);
    } else {
      m.setW(R.Camera_max_X_pos, 0x6000); m.setW(R.Camera_target_max_X_pos, 0x6000);
      m.setW(R.Events_bg + 4, 0x14);
    }
    return;
  }
  // loc_3CE7C: every 7 frames (the plane A redraw that follows is implicit here)
  if (m.addW(R.Events_bg + 8, -1) >= 0) return;
  m.setW(R.Events_bg + 8, 6);
  modifyChunk(s, d0);
}

// MGZ2_ModifyChunk: copy two 128x128 chunk definitions from MGZ2_QuakeChunks into chunk
// RAM at $FF5880 (chunk $B1) and $FF7500 (chunk $EA)
function modifyChunk(s, d0) {
  const m = s.m, chunks = s.level.chunks;
  for (const dest of [0x5880, 0x7500]) {
    const src = MGZ2_QuakeChunks + m.uw(MGZ2_ChunkReplaceArray + d0);
    for (let i = 0; i < 64; i++) chunks[(dest >> 1) + i] = m.uw(src + i * 2);
    d0 += 2;
    m.setW(R.Events_bg + 6, d0);
  }
}
