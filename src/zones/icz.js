// IceCap Zone screen / background events and deformation.
// Ported: ICZ1_ScreenInit (vertically looping: Screen_Y_wrap_value $7FF, Camera_Y_pos_mask
// $7F0, Layout_row_index_mask $3C), ICZ1_ScreenEvent, ICZ1_BackgroundInit,
// ICZ1_BackgroundEvent (Intro / SnowFall / Refresh / Refresh2 / Normal), ICZ1_IntroDeform,
// ICZ1_BigSnowFall, ICZ1_Deform, ICZ1_SetIntroPal / ICZ1_SetIndoorPal; ICZ2_ScreenInit,
// ICZ2_ScreenEvent, ICZ2_BackgroundInit, ICZ2_BackgroundEvent (FromICZ1 / Normal /
// Refresh), ICZ2_OutDeform, ICZ2_InDeform and the three ICZ2 palette setters.
// Not ported: ICZ1BGE_Transition (seamless load of act 2 at $6900), the ICZ1 Kos art queue
// for act 2 and the snowfall sound effects. The palette values are immediates in the code.
import { R, s16 } from '../ram.js';

const ICZ1_IntroBGDeformArray = 0x3defa;
const ICZ2_OutBGDeformArray = 0x3e23e;
const ICZ2_InBGDeformArray = 0x3e246;
const AIZ2_ALZ_BGDeformDelta = 0x3be5a;

const HS = R.HScroll_table;
const BG_LAYOUT = 0xff800a;

// Normal_palette_line_4+2 writes (Target_palette mirrors are not modelled)
function setPal4(s, words) {
  const pal = s.level.palette;
  for (let i = 0; i < words.length; i++) pal[0x31 + i] = words[i];
  s.game.vdp?.updatePalette();
}
const ICZ1_INTRO_PAL = [0xeee, 0xeec, 0xeea, 0xeca, 0xec8, 0xea6, 0xe86, 0xe64, 0xe40, 0xe00, 0xc00, 0x000, 0xaec, 0xcea, 0xe80];
const ICZ1_INDOOR_PAL = [0xec0, 0xe40, 0xe04, 0xc00, 0x600, 0x200, 0x000, 0xe64, 0xe24, 0xa02, 0x402];
const ICZ2_OUT_PAL = [0xeee, 0xeea, 0xec8, 0xea4, 0xc82, 0xc60, 0xc40, 0xe20, 0xa00, 0xe00];
const ICZ2_IN_PAL = [0xee2, 0xe24, 0xe04, 0xe02, 0x402, 0x200, 0x000, 0xe20, 0xe40, 0x840, 0x600];
const ICZ2_ICZ1_PAL = [0xeec, 0xcc6, 0xc80, 0xc60, 0xc40, 0xa40, 0x820, 0x620, 0x200, 0x600];

// ------------------------------------------------------------------------------- ICZ1
export const ICZ1 = {
  screenInit(s) {
    const m = s.m;
    m.setW(R.Screen_Y_wrap_value, 0x7ff);
    m.setW(R.Camera_Y_pos_mask, 0x7f0);
    m.setW(R.Layout_row_index_mask, 0x3c);
    s.resetTileOffsetPositionActual();
  },
  // ICZ1_ScreenEvent (indexed by the BG routine)
  screenEvent(s) {
    const m = s.m;
    const r = m.w(R.Events_routine_bg);
    if (r === 0) m.addW(R.Camera_X_pos_copy, m.w(R.Screen_shake_offset)); // ICZ1SE_Init
    else if (r === 4) m.addW(R.Camera_Y_pos_copy, m.w(R.Screen_shake_offset)); // ICZ1SE_WaitQuake
    s.drawTilesAsYouMove();
  },
  bgInit(s) {
    const m = s.m;
    // upper $400 of the BG is mirrored in the lower $400
    for (let i = 0; i < 8; i++) m.setW(BG_LAYOUT + i * 4 + 0x20, m.w(BG_LAYOUT + i * 4));
    m.setW(R.Events_fg_0, m.w(R.Camera_Y_pos_copy));
    m.setW(R.Events_fg_1, m.w(R.Camera_Y_pos_copy));
    const cx = m.uw(R.Camera_X_pos_copy);
    if (cx < 0x3940) {
      if (cx >= 0x3600) m.addW(R.Events_fg_1, 0x2800);
      if (m.uw(R.Camera_Y_pos_copy) < 0x580) {
        m.setW(R.Events_bg + 0x16, 0); // outdoors
        setPal4(s, ICZ1_INTRO_PAL);
        icz1IntroDeform(s);
        const { d0 } = s.resetTileOffsetPositionEff();
        s.refreshPlaneFull(d0, 0x1880);
        s.applyDeformation(ICZ1_IntroBGDeformArray, HS);
        return;
      }
    }
    // loc_3DB9C: indoors
    m.setW(R.Events_routine_bg, 0x10);
    m.setW(R.Events_bg + 0x16, -1);
    setPal4(s, ICZ1_INDOOR_PAL);
    icz1Deform(s);
    const { d0, d1 } = s.resetTileOffsetPositionEff();
    s.refreshPlaneFull(d0, d1);
    s.plainDeformation();
  },
  bgEvent(s) {
    const m = s.m;
    switch (m.w(R.Events_routine_bg)) {
      case 0: // ICZ1BGE_Intro
        if (m.w(R.Events_fg_5)) {
          m.setW(R.Events_fg_5, 0);
          m.setL(R.Events_bg, 0);
          m.setL(R.Events_bg + 4, 0);
          icz1BigSnowFall(s);
          s.resetTileOffsetPositionEff();
          m.addW(R.Events_routine_bg, 4);
          snowFallDraw(s);
          return;
        }
        icz1IntroDeform(s);
        s.drawTileRow(R.Camera_Y_pos_BG_copy, R.Camera_Y_pos_BG_rounded, 0x1880, 0x20);
        s.applyDeformation(ICZ1_IntroBGDeformArray, HS);
        s.shakeScreenSetup();
        return;
      case 4: // ICZ1BGE_SnowFall
        if (!m.w(R.Events_fg_5)) {
          icz1BigSnowFall(s);
          snowFallDraw(s);
          return;
        }
        m.setW(R.Events_fg_5, 0);
        m.setW(R.Draw_delayed_position, 0x2e0);
        m.setW(R.Draw_delayed_rowcount, 0xf);
        m.addW(R.Events_routine_bg, 4);
      // fallthrough
      case 8: { // ICZ1BGE_Refresh
        if (s.drawPlaneVertBottomUp(0x1880, 0x200) >= 0) { s.plainDeformation(); return; }
        icz1Deform(s);
        const { d0 } = s.resetTileOffsetPositionEff();
        m.setW(R.Draw_delayed_position, (d0 + 0xe0) & m.uw(R.Camera_Y_pos_mask));
        m.setW(R.Draw_delayed_rowcount, 0xf);
        m.addW(R.Events_routine_bg, 4);
        refresh2(s);
        return;
      }
      case 0xc: // ICZ1BGE_Refresh2
        icz1Deform(s);
        refresh2(s);
        return;
      default: // $10: ICZ1BGE_Normal (the act 2 art load / $14 transition are not ported)
        icz1Deform(s);
        s.drawBGAsYouMove();
        s.plainDeformation();
        return;
    }
  },
};

// loc_3DC2A
function snowFallDraw(s) {
  s.drawBGAsYouMove();
  s.plainDeformation();
  s.shakeScreenSetup();
}

// loc_3DC7E
function refresh2(s) {
  const m = s.m;
  if (s.drawPlaneVertBottomUp(m.w(R.Camera_X_pos_BG_copy), m.w(R.Camera_Y_pos_BG_copy)) < 0) {
    m.setW(R.Events_bg + 0x16, -1); // indoors
    setPal4(s, ICZ1_INDOOR_PAL);
    m.addW(R.Events_routine_bg, 4);
  }
  s.drawBGAsYouMove();
  s.plainDeformation();
}

// ICZ1_IntroDeform: BG Y = looped camera Y / 128, 14 X speeds (5 fast, 9 slower)
function icz1IntroDeform(s) {
  const m = s.m;
  s.adjustBGDuringLoop(R.Events_fg_0, m.w(R.Camera_Y_pos_copy), 0x400, 0x800);
  m.setW(R.Camera_Y_pos_BG_copy, m.w(R.Events_fg_1) >> 7);
  const d3 = m.w(R.Screen_shake_offset);
  let d0 = (s16(m.w(R.Camera_X_pos_copy) - d3) << 16) >> 5;
  let d1 = d0;
  d0 = (((((d0 >> 16) + d3) & 0xffff) << 16) | (d0 & 0xffff)) | 0;
  let a1 = HS;
  const run = (n) => { for (let i = 0; i < n; i++) { m.setW(a1, d0 >> 16); a1 += 2; d0 = (d0 + d1) | 0; } };
  run(5);
  d0 = (d0 + d1) | 0;
  d1 = (d1 + (d1 >> 1)) | 0;
  run(9);
}

// ICZ1_BigSnowFall: the BG plane shows the big falling snow pile
function icz1BigSnowFall(s) {
  const m = s.m;
  if (m.w(R.Events_bg) > -0x120) {
    m.setW(R.Screen_shake_flag, -1);
    m.setL(R.Events_bg + 4, m.l(R.Events_bg + 4) + 0x2400);
    m.setL(R.Events_bg, m.l(R.Events_bg) - m.l(R.Events_bg + 4));
  } else if (m.w(R.Screen_shake_flag) < 0) m.setW(R.Screen_shake_flag, 4);
  m.setW(R.Camera_Y_pos_BG_copy, m.w(R.Camera_Y_pos_copy) - 0x460 + m.w(R.Events_bg));
  m.setW(R.Camera_X_pos_BG_copy, m.w(R.Camera_X_pos_copy) - 0x1d40);
}

// ICZ1_Deform: indoors, half speed both ways
function icz1Deform(s) {
  const m = s.m;
  let d0 = m.w(R.Camera_Y_pos_copy) >> 1;
  m.setW(R.Camera_Y_pos_BG_copy, d0);
  m.setW(R.Events_bg + 0x12, d0 >> 1);
  d0 = s16((m.w(R.Camera_X_pos_copy) >> 1) - 0x1d80);
  m.setW(R.Camera_X_pos_BG_copy, d0);
  m.setW(R.Events_bg + 0x10, d0 >> 1);
}

// ------------------------------------------------------------------------------- ICZ2
export const ICZ2 = {
  screenInit(s) { s.resetTileOffsetPositionActual(); },
  screenEvent(s) { s.drawTilesAsYouMove(); },
  bgInit(s) {
    const m = s.m;
    m.setW(R.Events_routine_bg, 4);
    const cx = m.uw(R.Camera_X_pos_copy), cy = m.uw(R.Camera_Y_pos_copy);
    let indoors = false;
    if (cx < 0x3600) {
      if (cy >= 0x720) indoors = true;
      else if (cx < 0x1000 && cy >= 0x580) indoors = true;
    }
    if (!indoors) { // loc_3DF48
      m.setW(R.Events_bg + 0x16, 0);
      setPal4(s, cx >= 0x720 ? ICZ2_OUT_PAL : ICZ2_ICZ1_PAL);
      icz2OutDeform(s);
      s.refreshPlaneFull(0, 0);
      s.applyDeformation(ICZ2_OutBGDeformArray, HS);
      return;
    }
    // loc_3DF76
    m.setW(R.Events_bg + 0x16, -1);
    setPal4(s, ICZ2_IN_PAL);
    icz2InDeform(s);
    const { d0 } = s.resetTileOffsetPositionEff();
    s.refreshPlaneFull(d0, 0);
    s.applyDeformation(ICZ2_InBGDeformArray, HS);
  },
  bgEvent(s) {
    const m = s.m;
    switch (m.w(R.Events_routine_bg)) {
      case 0: // ICZ2BGE_FromICZ1
        m.addW(R.Events_routine_bg, 4);
        if (m.uw(R.Camera_Y_pos_copy) >= 0x580) goIndoors(s); else goOutdoors(s);
        return;
      case 4: { // ICZ2BGE_Normal
        const cx = m.uw(R.Camera_X_pos_copy), cy = m.uw(R.Camera_Y_pos_copy);
        if (!m.w(R.Events_bg + 0x16)) { // outdoors
          if (cx >= 0x1000 && cx < 0x3600 && cy >= 0x720) { goIndoors(s); return; }
          icz2OutDeform(s);
          s.applyDeformation(ICZ2_OutBGDeformArray, HS);
          return;
        }
        // indoors (loc_3E012)
        const stay = (cx >= 0x1900 && cx < 0x1b80) || cx < 0x1000 || cx >= 0x3600 || cy >= 0x720;
        if (!stay) { goOutdoors(s); return; }
        icz2InDeform(s);
        inDraw(s);
        return;
      }
      default: // 8: ICZ2BGE_Refresh
        if (!m.w(R.Events_bg + 0x16)) { icz2OutDeform(s); outRefresh(s); } else { icz2InDeform(s); inRefresh(s); }
        return;
    }
  },
};

// loc_3DFD8
function goIndoors(s) {
  const m = s.m;
  m.setW(R.Events_bg + 0x16, -1);
  setPal4(s, ICZ2_IN_PAL);
  icz2InDeform(s);
  const { d0 } = s.resetTileOffsetPositionEff();
  m.setW(R.Draw_delayed_position, (d0 + 0xe0) & m.uw(R.Camera_Y_pos_mask));
  m.setW(R.Draw_delayed_rowcount, 0xf);
  m.addW(R.Events_routine_bg, 4);
  inRefresh(s);
}

// loc_3E036
function goOutdoors(s) {
  const m = s.m;
  m.setW(R.Events_bg + 0x16, 0);
  setPal4(s, m.uw(R.Camera_X_pos_copy) >= 0x720 ? ICZ2_OUT_PAL : ICZ2_ICZ1_PAL);
  icz2OutDeform(s);
  const { d0 } = s.resetTileOffsetPositionEff();
  m.setW(R.Draw_delayed_position, (d0 + 0xe0) & m.uw(R.Camera_Y_pos_mask));
  m.setW(R.Draw_delayed_rowcount, 0xf);
  m.addW(R.Events_routine_bg, 4);
  outRefresh(s);
}

// loc_3E096
function outRefresh(s) {
  const m = s.m;
  if (s.drawPlaneVertBottomUp(0, m.w(R.Camera_Y_pos_BG_copy)) < 0) m.addW(R.Events_routine_bg, -4);
  s.applyDeformation(ICZ2_OutBGDeformArray, HS);
}

// loc_3E0B0
function inRefresh(s) {
  const m = s.m;
  if (s.drawPlaneVertBottomUp(0, m.w(R.Camera_Y_pos_BG_copy)) < 0) m.addW(R.Events_routine_bg, -4);
  inDraw(s);
}

// loc_3E070
function inDraw(s) {
  s.drawTileRow(R.Camera_Y_pos_BG_copy, R.Camera_Y_pos_BG_rounded, 0, 0x20);
  s.applyDeformation(ICZ2_InBGDeformArray, HS);
}

// ICZ2_OutDeform: BG Y = 0; 40 per-line sky values + 2 bands + 8 rippling water lines
function icz2OutDeform(s) {
  const m = s.m;
  m.setW(R.Camera_Y_pos_BG_copy, 0);
  const frame = m.w(R.Level_frame_counter);
  let d0 = ((s16(m.w(R.Camera_X_pos_copy) + (frame >> 1)) << 16) >> 1) & 0x7fffff;
  let d1 = d0 >> 6;
  let a1 = HS + 0x64;
  for (let i = 0; i < 40; i++) { a1 -= 2; m.setW(a1, d0 >> 16); d0 = (d0 - d1) | 0; }
  a1 = HS;
  d0 = (m.w(R.Camera_X_pos_copy) << 16) >> 1;
  d1 = d0;
  d0 >>= 1;
  d1 = (d1 + d0) | 0;
  m.setL(a1 + 0x64, d1);
  d0 >>= 2;
  d1 = d0;
  m.setW(a1, d0 >> 16); a1 += 2;
  d0 = (d0 + d1) | 0;
  m.setW(a1, d0 >> 16); a1 += 2;
  let a5 = AIZ2_ALZ_BGDeformDelta + ((frame & 0xffff) >>> 2 & 0x3e);
  for (let i = 0; i < 8; i++) { m.setW(a1, m.w(a5) + (d0 >> 16)); a1 += 2; a5 += 2; }
}

// ICZ2_InDeform: indoors, BG Y = (camera Y - $700) / 4 + $118, symmetric X bands
function icz2InDeform(s) {
  const m = s.m;
  m.setW(R.Camera_Y_pos_BG_copy, (s16(m.w(R.Camera_Y_pos_copy) - 0x700) >> 2) + 0x118);
  const a1 = HS;
  let d0 = (m.w(R.Camera_X_pos_copy) << 16) >> 1;
  const d1 = d0 >> 3;
  m.setW(a1, d0 >> 16); m.setW(a1 + 0x10, d0 >> 16);
  d0 = (d0 - d1) | 0; m.setW(a1 + 2, d0 >> 16); m.setW(a1 + 0xe, d0 >> 16);
  d0 = (d0 - d1) | 0; m.setW(a1 + 4, d0 >> 16); m.setW(a1 + 0xc, d0 >> 16);
  d0 = (d0 - d1) | 0; m.setW(a1 + 6, d0 >> 16); m.setW(a1 + 0xa, d0 >> 16);
  d0 = (d0 - d1) | 0; m.setW(R.Camera_X_pos_BG_copy, d0 >> 16); m.setW(a1 + 8, d0 >> 16);
  d0 = (d0 - d1) | 0; m.setW(R.Events_bg + 0x10, d0 >> 16);
}
