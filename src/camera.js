// Camera: port of Get_LevelSizeStart, DeformBgLayer (MoveCameraX / MoveCameraY),
// Sonic_RecordPos, Do_ResizeEvents (+ the per-act resize routines of Sonic 3) and the
// water height part of Handle_Onscreen_Water_Height. All state lives in the emulated RAM
// (ram.js) at the original addresses, with the original fixed-point formats
// (Camera_Y_pos is a 16.16 long, H_scroll_frame_offset is frames.8, ...).
import { R, s16, u16 } from './ram.js';

const STATUS_INAIR = 2, STATUS_ROLL = 4;
const WORD_1AA84 = 0x1aa84; // AIZ1 Resize_MaxYFromX table
const STARTING_WATER_HEIGHTS = 0x51d6; // lea (StartingWaterHeights).l,a1 in CheckLevelForWater
const WATER_HCZ1 = 0x5324, WATER_HCZ2 = 0x5344, WATER_LBZ1 = 0x5356; // DynamicWaterHeight tables

export class Camera {
  constructor(game, ram) {
    this.game = game;
    this.rom = game.rom;
    this.level = game.level;
    this.m = ram;
    const z = game.zone.id;
    this.zoneAct = z;
    this.actIdx = ((z >> 8) << 1) | (z & 1);
    this.shakeTimer = 0; // Obj_5308 (AIZ2 water drain quake) countdown
  }

  get player() { return this.game.player; }

  // Get_LevelSizeStart ($1A1A8): camera bounds from LevelSizes, start camera position.
  levelSizeStart() {
    const m = this.m, b = this.level.bounds, p = this.player;
    m.setB(R.Deform_lock, 0);
    m.setB(R.Scroll_lock, 0);
    m.setB(R.Scroll_lock_P2, 0);
    m.setB(R.Fast_V_scroll_flag, 0);
    m.setB(R.Dynamic_resize_routine, 0);
    for (const base of [R.Camera_min_X_pos, R.Camera_target_min_X_pos, R.Camera_min_X_pos_P2]) {
      m.setW(base, b.minX); m.setW(base + 2, b.maxX); m.setW(base + 4, b.minY); m.setW(base + 6, b.maxY);
    }
    m.setW(R.Distance_from_top, 0x60);
    m.setW(R.Distance_from_top_P2, 0x60);
    m.setW(R.Screen_X_wrap_value, -1);
    m.setW(R.Screen_Y_wrap_value, -1);
    // loc_1A43C (the intro / Tails-ICZ1 start overrides don't apply: the game starts post-intro)
    let d1 = u16(p.x_pos) - 0xa0;
    if (d1 < 0) d1 = 0;
    const maxX = m.uw(R.Camera_max_X_pos);
    if (d1 >= maxX) d1 = maxX;
    m.setW(R.Camera_X_pos, d1); m.setW(R.Camera_X_pos + 2, 0);
    let d0 = u16(p.y_pos) - 0x60;
    if (d0 < 0) d0 = 0;
    if (s16(d0) >= m.w(R.Camera_max_Y_pos)) d0 = m.w(R.Camera_max_Y_pos);
    m.setW(R.Camera_Y_pos, d0); m.setW(R.Camera_Y_pos + 2, 0);
    // Pos_table starts filled with the start position (Reset_Player_Position_Array)
    this.resetPosTable();
    this.initWater();
  }

  // Reset_Player_Position_Array
  resetPosTable() {
    const m = this.m, p = this.player;
    for (let i = 0; i < 0x100; i += 4) { m.setW(R.Pos_table + i, p.x_pos); m.setW(R.Pos_table + i + 2, p.y_pos); }
    m.setW(R.Pos_table_index, 0);
  }

  // Sonic_RecordPos: one (x, y) entry per frame into the $100-byte ring buffer.
  recordPos() {
    const m = this.m, p = this.player;
    const i = m.uw(R.Pos_table_index);
    m.setW(R.Pos_table + i, p.x_pos);
    m.setW(R.Pos_table + i + 2, p.y_pos);
    m.setB(R.Pos_table_index + 1, m.ub(R.Pos_table_index + 1) + 4);
  }

  // Per-frame entry: everything the original does between Process_Sprites and ScreenEvents
  // for the camera (Sonic_RecordPos happens at the end of Sonic's own code).
  update() {
    const m = this.m, p = this.player;
    m.addW(R.Level_frame_counter, 1);
    const req = p.scrollDelayRequest;
    if (req) {
      p.scrollDelayRequest = null;
      m.setW(R.H_scroll_frame_offset, req.offset);
      if (req.resetPosTable) this.resetPosTable();
    }
    // loc_118B6: vertical wrapping (MGZ1 / ICZ1 have Camera_min_Y_pos = -$100)
    if (m.w(R.Camera_min_Y_pos) === -0x100) p.y_pos = s16(p.y_pos & m.uw(R.Screen_Y_wrap_value));
    this.recordPos();
    // Sonic_Death (sub_13230) sets Scroll_lock so the camera stops when he dies
    if (p.routine >= 6) m.setB(R.Scroll_lock, 1);
    m.setW(R.Distance_from_top, p.distance_from_top);
    this.deformBgLayer();
    this.water();
  }

  // DeformBgLayer ($1A476), single player part
  deformBgLayer() {
    const m = this.m;
    if (m.ub(R.Deform_lock)) return;
    m.setW(R.H_scroll_amount, 0);
    m.setW(R.V_scroll_amount, 0);
    m.setW(R.H_scroll_amount_P2, 0);
    m.setW(R.V_scroll_amount_P2, 0);
    if (!m.ub(R.Scroll_lock)) {
      this.moveCameraX();
      this.moveCameraY(m.w(R.Distance_from_top));
    }
    this.doResizeEvents();
  }

  // MoveCameraX ($1A55A)
  moveCameraX() {
    const m = this.m, p = this.player;
    const cam = m.w(R.Camera_X_pos);
    let d0;
    let d1 = m.uw(R.H_scroll_frame_offset);
    if (d1) {
      // camera lag after a spindash: follow the position from (offset >> 8) + 1 frames ago
      d1 = u16(d1 - 0x100);
      m.setW(R.H_scroll_frame_offset, d1);
      d1 = (((d1 >> 8) << 2) + 4) & 0xff;
      let idx = m.uw(R.Pos_table_index);
      idx = (idx & 0xff00) | ((idx - d1) & 0xff);
      d0 = m.uw(R.Pos_table + s16(idx)) & 0x7fff;
    } else {
      d0 = p.x_pos;
    }
    d0 = s16(d0 - cam - 0x90);
    if (d0 < 0) {
      if (d0 <= -0x18) d0 = -0x18;
      d0 = s16(d0 + cam);
      if (d0 <= m.w(R.Camera_min_X_pos)) d0 = m.w(R.Camera_min_X_pos);
    } else {
      d0 = s16(d0 - 0x10);
      if (d0 < 0) { m.setW(R.H_scroll_amount, 0); return; }
      if (u16(d0) >= 0x18) d0 = 0x18;
      d0 = s16(d0 + cam);
      if (d0 >= m.w(R.Camera_max_X_pos)) d0 = m.w(R.Camera_max_X_pos);
    }
    m.setW(R.H_scroll_amount, (d0 - cam) << 8);
    m.setW(R.Camera_X_pos, d0);
  }

  // MoveCameraY ($1A5CE). d3 = Distance_from_top.
  moveCameraY(d3) {
    const m = this.m, p = this.player;
    const camL = m.l(R.Camera_Y_pos); // 16.16
    const cam = camL >> 16;
    let d0 = s16(p.y_pos - cam);
    if (m.w(R.Camera_min_Y_pos) === -0x100) d0 = s16(d0 & m.uw(R.Screen_Y_wrap_value));
    if (p.status & STATUS_ROLL) d0 = s16(d0 - 5);
    let d1 = d3;
    let speed; // fast path selector
    let target = null; // 'L1A67A' | 'L1A68A' | 'L1A6AC'
    const pick = (lim, spd) => {
      speed = spd;
      if (d0 > lim) target = 'L1A6AC';
      else if (d0 < -lim) target = 'L1A68A';
      else target = 'L1A67A';
    };
    if (p.status & STATUS_INAIR) {
      d0 = d0 + 0x20;
      const borrow1 = u16(d0) < u16(d1);
      d0 = s16(d0 - d1);
      if (borrow1) pick(0x18, 0x1800);
      else {
        const borrow2 = u16(d0) < 0x40;
        d0 = s16(d0 - 0x40);
        if (!borrow2) pick(0x18, 0x1800);
        else if (m.ub(R.Camera_max_Y_pos_changing)) { d0 = 0; m.setB(R.Camera_max_Y_pos_changing, 0); target = 'L1A67A'; }
        else { m.setW(R.V_scroll_amount, 0); return; }
      }
    } else {
      d0 = s16(d0 - d1);
      if (d0 !== 0) {
        if (d3 !== 0x60) pick(2, 0x200);
        else if (m.ub(R.Fast_V_scroll_flag)) pick(0x18, 0x1800);
        else {
          const gv = Math.abs(s16(p.ground_vel));
          if (gv >= 0x800) pick(0x18, 0x1800);
          else pick(6, 0x600);
        }
      } else if (m.ub(R.Camera_max_Y_pos_changing)) { d0 = 0; m.setB(R.Camera_max_Y_pos_changing, 0); target = 'L1A67A'; }
      else { m.setW(R.V_scroll_amount, 0); return; }
    }
    // d1 as (int word, fraction word)
    let yi, yf, down;
    if (target === 'L1A67A') {
      yi = s16(d0 + cam); yf = 0; down = d0 >= 0;
    } else {
      const delta = target === 'L1A68A' ? -speed : speed;
      const nl = (camL + (delta << 8)) | 0;
      yi = nl >> 16; yf = nl & 0xffff; down = target === 'L1A6AC';
    }
    const minY = m.w(R.Camera_min_Y_pos), maxY = m.w(R.Camera_max_Y_pos);
    if (!down) {
      // loc_1A694
      if (!(yi > minY)) {
        if (yi > -0x100) yi = minY;
        else yi = s16(yi & m.uw(R.Screen_Y_wrap_value));
      }
    } else if (!(yi < maxY)) {
      // loc_1A6B4
      const d3w = u16(m.uw(R.Screen_Y_wrap_value) + 1);
      if (u16(yi) < d3w) yi = maxY;
      else { yi = s16(yi - d3w); m.setW(R.Camera_Y_pos, m.w(R.Camera_Y_pos) - d3w); }
    }
    // loc_1A6CC
    const newL = ((yi << 16) | yf) | 0;
    const diff = (newL - m.l(R.Camera_Y_pos)) | 0;
    m.setW(R.V_scroll_amount, (diff >>> 8) & 0xffff); // ror.l #8 -> low word
    m.setL(R.Camera_Y_pos, newL);
  }

  // Do_ResizeEvents ($1A858)
  doResizeEvents() {
    const m = this.m;
    const fn = RESIZE[this.actIdx];
    if (fn) fn.call(this);
    let d1 = 2;
    const t = m.uw(R.Camera_target_max_Y_pos), cur = m.uw(R.Camera_max_Y_pos);
    if (t === cur) return;
    if (t >= cur) {
      // loc_1A882: moving the bottom boundary down; faster (8px) while Sonic is airborne
      const d0 = u16(m.w(R.Camera_Y_pos) + 8);
      if (d0 >= cur && (this.player.status & STATUS_INAIR)) d1 <<= 2;
      m.addW(R.Camera_max_Y_pos, d1);
      m.setB(R.Camera_max_Y_pos_changing, 1);
      return;
    }
    d1 = -d1;
    const cy = m.uw(R.Camera_Y_pos);
    if (cy > t) m.setW(R.Camera_max_Y_pos, cy & 0xfffe);
    m.addW(R.Camera_max_Y_pos, d1);
    m.setB(R.Camera_max_Y_pos_changing, 1);
  }

  // Resize_MaxYFromX ($1AE6A)
  resizeMaxYFromX(table) {
    const m = this.m, cx = m.uw(R.Camera_X_pos);
    let a = table, y, x;
    do { y = this.rom.u16(a); x = this.rom.u16(a + 2); a += 4; } while (cx > x);
    if (y & 0x8000) { y &= 0x7fff; m.setW(R.Camera_max_Y_pos, y); }
    m.setW(R.Camera_target_max_Y_pos, y);
  }

  routine() { return this.m.ub(R.Dynamic_resize_routine); }
  nextRoutine(n = 2) { this.m.setB(R.Dynamic_resize_routine, this.routine() + n); }
  camX() { return this.m.uw(R.Camera_X_pos); }
  camY() { return this.m.uw(R.Camera_Y_pos); }
  setBound(sym, v, alsoTarget) { this.m.setW(sym, v); if (alsoTarget) this.m.setW(alsoTarget, v); }

  // Normal_palette writes from the resize routines go straight to the level palette.
  setPalette(byteOfs, word) {
    this.level.palette[byteOfs >> 1] = word;
    this.game.vdp?.updatePalette();
  }

  // --- water (CheckLevelForWater / Handle_Onscreen_Water_Height / DynamicWaterHeight) ----
  initWater() {
    const m = this.m, z = this.zoneAct;
    const zone = z >> 8;
    const flag = zone === 0 || zone === 1 || z === 0x301 || z === 0x501 || z === 0x601;
    m.setB(R.Water_flag, flag ? 1 : 0);
    const h = this.rom.u16(STARTING_WATER_HEIGHTS + this.actIdx * 2);
    m.setW(R.Water_level, h);
    m.setW(R.Mean_water_level, h);
    m.setW(R.Target_water_level, h);
    m.setB(R.Water_speed, 1);
    if (!flag) m.setW(R.Water_level, 0x7fff); // no water: keep every "is water on screen" test false
  }

  water() {
    const m = this.m;
    if (!m.ub(R.Water_flag)) return;
    if (this.player.routine < 6 && !m.ub(R.Deform_lock)) this.dynamicWaterHeight();
    m.setW(R.Water_level, m.w(R.Mean_water_level));
  }

  // DynamicWaterHeight ($5222). The HCZ water tunnels (sub_539A) are object-side and not here.
  dynamicWaterHeight() {
    const m = this.m, cx = this.camX();
    switch (this.actIdx) {
      case 1: { // DynamicWaterHeight_AIZ2
        if (m.uw(R.Camera_target_max_Y_pos) === 0x820) break;
        if (cx < 0x2440) {
          if (m.uw(R.Target_water_level) !== 0x618) break;
          m.setW(R.Target_water_level, 0x528);
          m.setB(R.Water_speed, 2);
          break;
        }
        if (!m.ub(R.Level_trigger_array)) {
          if (cx < 0x2850) break;
          m.setB(R.Level_trigger_array, 1);
        }
        if (m.uw(R.Target_water_level) === 0x618) break;
        if (cx < 0x2900) {
          m.setW(R.Screen_shake_flag, -1);
          this.shakeTimer = 180; // Obj_5308 stops the quake after 180 frames
        }
        // loc_52EC: clear chunk column $4E of FG rows 7-10 (the drained basin)
        for (let r = 0; r < 4; r++) {
          const ptr = m.w(0xff8008 + 0x1c + r * 4);
          m.setB(0xff0000 | (ptr & 0xffff) + 0x4e, 0);
        }
        m.setW(R.Target_water_level, 0x618);
        break;
      }
      case 2: this.waterFromX(WATER_HCZ1); break;
      case 3: this.waterFromX(WATER_HCZ2); break; // (_unkFAA2 is never set without the HCZ2 wall object)
      case 12: this.waterFromX(WATER_LBZ1); break;
      default: break;
    }
    if (this.shakeTimer > 0 && --this.shakeTimer === 0) m.setW(R.Screen_shake_flag, 0);
    const d1 = m.ub(R.Water_speed);
    const d0 = m.uw(R.Target_water_level) - m.uw(R.Mean_water_level);
    if (d0 === 0) return;
    m.addW(R.Mean_water_level, d0 > 0 ? d1 : -d1);
  }

  // loc_537C: (target, x) table; bit 15 of the height = set the mean level immediately
  waterFromX(table) {
    const m = this.m, cx = this.camX();
    let a = table, h, x;
    do { h = this.rom.u16(a); x = this.rom.u16(a + 2); a += 4; } while (cx > x);
    if (h & 0x8000) { h &= 0x7fff; m.setW(R.Mean_water_level, h); }
    m.setW(R.Target_water_level, h);
  }
}

// --- per-act resize routines (LevelResizeArray) --------------------------------------
// Object spawns (bosses), Kos/PLC art loading and Tails' CPU flags are skipped; the camera
// bound / palette / event-flag logic is ported. "Last_star_post_hit" is treated as set in
// AIZ1 because this game starts AIZ1 after the intro (which in the original only happens
// from a star post).
const RESIZE = [];

// AIZ1_Resize
RESIZE[0] = function () {
  const m = this.m;
  switch (this.routine()) {
    case 0: // loc_1A920
      if (this.camX() < 0x1000) return;
      m.setW(R.Camera_min_X_pos, this.camX());
      if (this.camX() < 0x1308) return;
      // (PLC $0B / PalID_AIZ reload / Tails_CPU_routine skipped)
      this.nextRoutine();
      return;
    case 2: // loc_1A96C
      m.setW(R.Camera_min_X_pos, 0x1308);
      if (this.camX() < 0x1400) return;
      // star post was hit: no main-level art reload / Events_fg_5; (Save_Level_Data, PLC 8 skipped)
      this.nextRoutine();
      return;
    case 4: // loc_1A9EC
      this.resizeMaxYFromX(WORD_1AA84);
      m.setW(R.Camera_min_Y_pos, 0);
      this.setPalette(0x40 + 0x1e, this.camX() >= 0x2b00 ? 0x004 : 0x20e);
      if (this.camX() >= 0x2c00) m.setW(R.Camera_min_Y_pos, 0x2e0);
      if (this.camX() < 0x2d80) return;
      this.setPalette(0x40 + 0x1e, 0xc02);
      m.setW(R.Camera_min_X_pos, 0x2d80);
      // (PLC $5A skipped)
      this.nextRoutine();
      return;
    case 6: // loc_1AA40
      this.resizeMaxYFromX(WORD_1AA84);
      m.setW(R.Camera_min_X_pos, this.camX());
      if (this.camX() < 0x2e00) return;
      // (flame art / PLC $0C skipped)
      this.nextRoutine();
      return;
    case 8: // loc_1AA7C
      m.setW(R.Camera_min_X_pos, this.camX());
      return;
  }
};

// AIZ2_Resize
RESIZE[1] = function () {
  const m = this.m, cx = this.camX();
  const setMaxY = (v) => { m.setW(R.Camera_max_Y_pos, v); m.setW(R.Camera_target_max_Y_pos, v); };
  switch (this.routine()) {
    case 0: // AIZ2_Resize1
      if (cx < 0x380) return;
      setMaxY(0x4f0);
      this.nextRoutine();
      // Apparent_zone_and_act is AIZ1 when arriving from the fire transition; this game loads
      // AIZ2 directly (Apparent act 2: miniboss already beaten), so the $590/$F50 branch runs.
      setMaxY(0x590);
      m.setW(R.Camera_min_X_pos, 0xf50);
      this.nextRoutine();
      return;
    case 2: // AIZ2_Resize2 (only reached when the miniboss hasn't been beaten)
      if (this.camY() < 0x300) {
        setMaxY(cx >= 0xed0 ? 0x2b8 : 0x590);
        if (cx < 0xf50) return;
        m.setW(R.Camera_min_X_pos, 0xf50);
        // (Obj_AIZMiniboss spawn skipped)
        this.nextRoutine();
        return;
      }
      if (cx >= 0x11a0) { m.setW(R.Camera_target_max_Y_pos, 0x820); m.setW(R.Target_water_level, 0xf80); return; }
      setMaxY(cx >= 0xed0 ? 0x450 : 0x590);
      return;
    case 4: // AIZ2_Resize3
      if (cx < 0x1500) return;
      setMaxY(0x630);
      this.nextRoutine();
      return;
    case 6: // AIZ2_Resize4: bombership art (skipped) + signal the BG event
      if (cx < 0x3c00) return;
      m.setW(R.Events_fg_5, -1);
      this.nextRoutine();
      return;
    case 8: // AIZ2_Resize5
      if (cx < 0x3f00) return;
      m.setW(R.Camera_min_Y_pos, 0x15a); m.setW(R.Camera_target_min_Y_pos, 0x15a);
      this.nextRoutine();
      return;
    case 10: // AIZ2_Resize6
      if (cx < 0x4000) return;
      setMaxY(0x15a);
      this.nextRoutine();
      return;
    case 12: // AIZ2_Resize7: would start the bombership sequence (Events_fg_4) - not ported
      if (cx < 0x4160) return;
      this.nextRoutine();
      return;
    case 14: // AIZ2_Resize8
      if (cx < 0x4780) return;
      this.nextRoutine();
      return;
    default: return; // AIZ2_ResizeEnd
  }
};

// HCZ1_Resize: palette line 4 swap around the start area
RESIZE[2] = function () {
  const cx = this.camX(), cy = this.camY();
  const pal = (a, b, c) => { this.setPalette(0x60 + 0x10, a); this.setPalette(0x60 + 0x12, b); this.setPalette(0x60 + 0x14, c); };
  switch (this.routine()) {
    case 0: // loc_1AC4E
      if (cx >= 0x360 || cy < 0x3e0) return;
      pal(0xb80, 0x240, 0x220); // (sic: the original writes $B80, a bug for $680)
      this.nextRoutine();
      return;
    case 2: // loc_1AC74
      if (cx < 0x360) {
        if (cy >= 0x3e0) return;
        this.nextRoutine(-2);
      } else {
        if (cy < 0x500 || cx < 0x900) return;
        this.nextRoutine();
      }
      pal(0xcee, 0xace, 0x08a);
      return;
    default: return;
  }
};

// HCZ2_Resize
RESIZE[3] = function () {
  if (this.routine() === 0 && this.camX() >= 0xc00) { this.m.setW(R.Events_fg_5, -1); this.nextRoutine(); }
};

// MGZ2_Resize (MGZ1_Resize falls through into it in the original ROM)
function mgz2Resize() {
  const m = this.m, cx = this.camX();
  switch (this.routine()) {
    case 0: { // loc_1ACEC
      const cy = this.camY();
      if (cy < 0x600 || cy >= 0x700 || cx < 0x3a00) return;
      m.setW(R.Camera_min_Y_pos, 0x6a0); m.setW(R.Camera_target_min_Y_pos, 0x6a0);
      m.setW(R.Camera_max_Y_pos, 0x6a0); m.setW(R.Camera_target_max_Y_pos, 0x6a0);
      m.setW(R.Camera_max_X_pos, 0x3c80); m.setW(R.Camera_target_max_X_pos, 0x3c80);
      this.nextRoutine();
      return;
    }
    case 2: // loc_1AD2A
      if (cx >= 0x3a00) {
        if (0x3c80 > cx) return;
        m.setW(R.Camera_min_X_pos, 0x3c80); m.setW(R.Camera_target_min_X_pos, 0x3c80);
        // (Obj_MGZEndBoss spawn skipped)
        this.nextRoutine();
        return;
      }
      // loc_1AD64
      m.setL(R.Camera_min_Y_pos, 0x1000); m.setL(R.Camera_target_min_Y_pos, 0x1000);
      m.setW(R.Camera_max_X_pos, 0x6000); m.setW(R.Camera_target_max_X_pos, 0x6000);
      this.nextRoutine(-2);
      return;
    default: return;
  }
}
RESIZE[4] = mgz2Resize;
RESIZE[5] = mgz2Resize;
// CNZ1/CNZ2_Resize: rts
// ICZ1_Resize: signals for the screen events
RESIZE[8] = function () {
  const cx = this.camX();
  switch (this.routine()) {
    case 0: // loc_1AD9C
      if (cx < 0x3700 || this.camY() < 0x68c) return;
      this.m.setW(R.Events_fg_5, -1); this.nextRoutine();
      return;
    case 2: // loc_1ADB6
      if (cx < 0x3940) return;
      this.m.setW(R.Events_fg_5, -1); this.nextRoutine();
      return;
    default: return;
  }
};
// ICZ2_Resize
RESIZE[9] = function () {
  if (this.routine() !== 0) return;
  if (this.camX() < 0x740 || this.camY() >= 0x400) return;
  this.m.setW(R.Camera_min_X_pos, 0x740);
  this.nextRoutine();
};
// LBZ1_Resize: rts. LBZ2_Resize only queues the Death Egg art at $3BC0 (skipped).
RESIZE[13] = function () {
  if (this.routine() === 0 && this.camX() >= 0x3bc0 && this.camY() >= 0x500) this.nextRoutine();
};
