// Per-act screen / background event tables (LevelSetupArray + LevelEventArray), indexed
// by act ((zone << 1) | act). Each entry: { screenInit, screenEvent, bgInit, bgEvent }
// taking the Scroll instance (scroll.js).
import { GENERIC } from './generic.js';
import { AIZ1, AIZ2 } from './aiz.js';
import { HCZ1, HCZ2 } from './hcz.js';
import { MGZ1, MGZ2 } from './mgz.js';
import { CNZ1, CNZ2 } from './cnz.js';
import { ICZ1, ICZ2 } from './icz.js';
import { LBZ1, LBZ2 } from './lbz.js';

export const ZONE_EVENTS = [
  AIZ1, AIZ2, HCZ1, HCZ2, MGZ1, MGZ2, CNZ1, CNZ2,
  GENERIC, GENERIC, // FBZ (not in Sonic 3)
  ICZ1, ICZ2, LBZ1, LBZ2,
];
ZONE_EVENTS.none = GENERIC;
