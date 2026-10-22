// Generic (NoScreenInit / NoScreenEvent / NoBackgroundInit / NoBackgroundEvent) events.
import { R } from '../ram.js';

// NoScreenInit / NoScreenEvent / NoBackgroundInit / NoBackgroundEvent / No_Deform
export const GENERIC = {
  screenInit(s) { s.resetTileOffsetPositionActual(); },
  screenEvent(s) { s.drawTilesAsYouMove(); },
  bgInit(s) {
    noDeform(s);
    const { d0, d1 } = s.resetTileOffsetPositionEff();
    s.refreshPlaneFull(d0, d1);
    s.plainDeformation();
  },
  bgEvent(s) {
    noDeform(s);
    s.drawBGAsYouMove();
    s.plainDeformation();
  },
};

export function noDeform(s) {
  const m = s.m;
  m.setW(R.Camera_X_pos_BG_copy, m.w(R.Camera_X_pos_copy) >> 3);
  m.setW(R.Camera_Y_pos_BG_copy, m.w(R.Camera_Y_pos_copy) >> 3);
}

