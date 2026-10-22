// Sonic's player object, ported from the Sonic 3 (W) 68000 code (s3.asm,
// sonicretro skdisasm). Labels in the comments are the original ones; loc_xxxxx
// labels are real ROM addresses. Arithmetic keeps the original semantics:
// positions are 16.16 longs (pixel word + subpixel word), velocities are signed
// 8.8 words, angles are bytes (256 = 360 degrees) and wrap around.
//
// Not ported: water, Super Sonic, 2P/competition, Tails, debug mode, background
// collision (Background_collision_flag), sound, dust/shield objects, position
// recording. Objects are handled by the game: it can set Status_OnObj (+ an
// optional `interact` object for edge balancing).
import { ADDR } from './rom.js';

// Tables used by GetSineCosine / GetArcTan (located next to the routines:
// GetSineCosine @ $1FD4 reads SineTable(pc) = $1FEC, GetArcTan @ $226C reads
// ArcTanTable(pc) = $22C8).
const SINE_TABLE = 0x1fec;
const ARCTAN_TABLE = 0x22c8;
const ANIM_COUNT = 0x24;

// Status bits (Status_* constants)
export const STATUS = { Facing: 1, InAir: 2, Roll: 4, OnObj: 8, RollJump: 0x10, Push: 0x20, Underwater: 0x40 };
// status_secondary bits
export const STATUS2 = { Shield: 1, Invincible: 2, SpeedShoes: 4, FireShield: 0x10, LtngShield: 0x20, BublShield: 0x40 };

const S_FACING = 1, S_INAIR = 2, S_ROLL = 4, S_ONOBJ = 8, S_ROLLJUMP = 0x10, S_PUSH = 0x20;

const s8 = (v) => (v << 24) >> 24;
const s16 = (v) => (v << 16) >> 16;
const u16 = (v) => v & 0xffff;

// Spindash release speeds (word_12C24)
const SPINDASH_SPEEDS = [0x800, 0x880, 0x900, 0x980, 0xa00, 0xa80, 0xb00, 0xb80, 0xc00];

// Character_Speeds (Sonic): top speed, acceleration, deceleration
const NORMAL_SPEEDS = [0x600, 0xc, 0x80];
const SHOES_SPEEDS = [0xc00, 0x18, 0x80];

export class Player {
  constructor(rom, level) {
    this.rom = rom;
    this.level = level;
    const r = rom.u8;
    this.sine = new Int16Array(0x140);
    for (let i = 0; i < 0x140; i++) this.sine[i] = rom.s16(SINE_TABLE + i * 2);
    this.arctan = r.slice(ARCTAN_TABLE, ARCTAN_TABLE + 0x101);
    // Animation scripts (AniSonic): absolute ROM address of each script.
    this.animAddrs = [];
    for (let i = 0; i < ANIM_COUNT; i++) this.animAddrs.push(ADDR.AniSonic + rom.u16(ADDR.AniSonic + i * 2));

    // camera bounds the player is clamped to (Camera_min/max_X/Y_pos); the game
    // may update these (level events)
    this.bounds = { ...level.bounds };
    this.cameraY = null; // game may set the real Camera_Y_pos (used for the death fall)

    this.onRingLoss = null;
    this.interact = null; // object Sonic stands on (for balancing): {x_pos, width_pixels, status}
    this._reset(level.start.x, level.start.y);
  }

  _reset(x, y) {
    this._x = (x << 16) | 0; // x_pos.l (pixel.w : subpixel.w)
    this._y = (y << 16) | 0;
    this.x_vel = 0;
    this.y_vel = 0;
    this.ground_vel = 0;
    this.angle = 0;
    this.status = 0;
    this.status_secondary = 0;
    this.status_tertiary = 0;
    this.routine = 2;
    // Sonic_Init
    this.y_radius = 0x13;
    this.x_radius = 9;
    this.default_y_radius = 0x13;
    this.default_x_radius = 9;
    this.top_solid_bit = 0xc;
    this.lrb_solid_bit = 0xd;
    [this.max_speed, this.acceleration, this.deceleration] = NORMAL_SPEEDS;
    this.flips_remaining = 0;
    this.flip_speed = 4;
    this.flip_angle = 0;
    this.flip_type = 0;
    this.render_flags = 4;
    this.mapping_frame = 0;
    this.anim = 0;
    this.prev_anim = 0;
    this.anim_frame = 0;
    this.anim_frame_timer = 0;
    this.move_lock = 0;
    this.jumping = 0;
    this.spin_dash_flag = 0;
    this.spin_dash_counter = 0;
    this.double_jump_flag = 0;
    this.stick_to_convex = 0;
    this.object_control = 0;
    this.scroll_delay_counter = 0;
    this.invulnerable_time = 0; // invulnerability_timer
    this.invincibility_timer = 0;
    this.speed_shoes_timer = 0;
    this.next_tilt = 0;
    this.tilt = 0;
    this.obj41 = 0; // $41(a0), used by Player_WalkVertR in AIZ1
    this.shield_anim = 0; // (Shield+anim): 1 = insta-shield / shield attack
    this._instaShieldTimer = 0;
    this.distance_from_top = 0x60; // Distance_from_top (camera look up/down bias)
    this.primaryAngle = 0;
    this.secondaryAngle = 0;
    this.frameCounter = 0;
    this.dead = false;
    this.visible = true;
    this._deathCamY = 0;
    this._d0 = 0; // secondary return registers of the collision helpers
    this._d3 = 0;
  }

  // ---------------------------------------------------------------- public state
  get x_pos() { return this._x >> 16; }
  set x_pos(v) { this._x = ((v << 16) | (this._x & 0xffff)) | 0; }
  get y_pos() { return this._y >> 16; }
  set y_pos(v) { this._y = ((v << 16) | (this._y & 0xffff)) | 0; }
  get x_sub() { return this._x & 0xffff; }
  get y_sub() { return this._y & 0xffff; }
  get rolling() { return (this.status & S_ROLL) !== 0; }
  get inAir() { return (this.status & S_INAIR) !== 0; }
  get flipX() { return (this.render_flags & 1) !== 0; }
  get flipY() { return (this.render_flags & 2) !== 0; }
  get cameraLookOffset() { return 0x60 - this.distance_from_top; } // add to (y - $60) for camera Y
  get instaShieldActive() { return this.double_jump_flag === 1 && (this.status_secondary & 0x73) === 0; }
  get hurting() { return this.routine === 4; }
  get dying() { return this.routine >= 6; }
  get speedShoes() { return (this.status_secondary & STATUS2.SpeedShoes) !== 0; }
  set speedShoes(on) {
    if (on) {
      this.status_secondary |= STATUS2.SpeedShoes;
      this.speed_shoes_timer = 150;
      [this.max_speed, this.acceleration, this.deceleration] = SHOES_SPEEDS;
    } else {
      this.status_secondary &= ~STATUS2.SpeedShoes;
      this.speed_shoes_timer = 0;
      [this.max_speed, this.acceleration, this.deceleration] = NORMAL_SPEEDS;
    }
  }

  _addX(d) { this.x_pos = s16(this.x_pos + d); }
  _addY(d) { this.y_pos = s16(this.y_pos + d); }

  // ---------------------------------------------------------------- math
  // GetSineCosine: returns sin, sets this._cos
  _sincos(a) {
    a &= 0xff;
    this._cos = this.sine[a + 0x40];
    return this.sine[a];
  }

  // GetArcTan: d1 = x, d2 = y -> angle byte
  _arctan(x, y) {
    x = s16(x);
    y = s16(y);
    if (x === 0 && y === 0) return 0x40; // GetArcTan_Zero
    const ax = Math.abs(x), ay = Math.abs(y);
    let d0;
    if (ay < ax) d0 = this.arctan[((ay << 8) / ax) | 0];
    else d0 = (0x40 - this.arctan[((ax << 8) / ay) | 0]) & 0xff;
    if (x < 0) d0 = -d0 + 0x80;
    if (y < 0) d0 = -d0 + 0x100;
    return d0 & 0xff;
  }

  _path() { return this.top_solid_bit === 0xc ? 0 : 1; } // Primary/Secondary_collision_addr

  _setAngleSlot(slot, a) {
    if (slot === 0) this.primaryAngle = a & 0xff;
    else this.secondaryAngle = a & 0xff;
  }

  // ================================================================ collision
  // FindFloor (FG only) -> sub_105DA
  // d2 = y, d3 = x, d5 = solidity bit, a3 = +-$10, d6 = flip mask ($800 for ceilings)
  _findFloor(d2, d3, d5, a3, d6, slot) {
    const lv = this.level;
    const w = lv.blockWord(d3, d2);
    const id = w & 0x3ff;
    if (id !== 0 && ((w >> d5) & 1)) {
      const ci = lv.collision[this._path()][id];
      if (ci !== 0) {
        let ang = lv.angles[ci];
        let d1 = d3;
        if (w & 0x400) { d1 = ~d1; ang = -ang; }
        if (w & 0x800) { ang = -(ang + 0x40) - 0x40; }
        this._setAngleSlot(slot, ang);
        let h = lv.heights[ci * 16 + (d1 & 0xf)];
        if ((w ^ d6) & 0x800) h = -h;
        if (h !== 0) {
          let toAbove = false;
          if (h < 0) {
            if ((d2 & 0xf) + h < 0) toAbove = true; // else: treat as empty (loc_105EA)
          } else if (h === 0x10) {
            toAbove = true;
          } else {
            return s16(0xf - ((d2 & 0xf) + h));
          }
          if (toAbove) {
            // loc_10670: block is full, check the previous block
            return s16(this._findFloor2(s16(d2 - a3), d3, d5, d6, slot) - 0x10);
          }
        }
      }
    }
    // loc_105EA: empty here, check the next block
    return s16(this._findFloor2(s16(d2 + a3), d3, d5, d6, slot) + 0x10);
  }

  // sub_1067E
  _findFloor2(d2, d3, d5, d6, slot) {
    const lv = this.level;
    const w = lv.blockWord(d3, d2);
    const id = w & 0x3ff;
    if (id !== 0 && ((w >> d5) & 1)) {
      const ci = lv.collision[this._path()][id];
      if (ci !== 0) {
        let ang = lv.angles[ci];
        let d1 = d3;
        if (w & 0x400) { d1 = ~d1; ang = -ang; }
        if (w & 0x800) { ang = -(ang + 0x40) - 0x40; }
        this._setAngleSlot(slot, ang);
        let h = lv.heights[ci * 16 + (d1 & 0xf)];
        if ((w ^ d6) & 0x800) h = -h;
        if (h > 0) return s16(0xf - ((d2 & 0xf) + h));
        if (h < 0 && (d2 & 0xf) + h < 0) return s16(~(d2 & 0xf)); // loc_10702
      }
    }
    // loc_1068E
    return 0xf - (d2 & 0xf);
  }

  // FindWall (FG only) -> sub_10846
  _findWall(d2, d3, d5, a3, d6, slot) {
    const lv = this.level;
    const w = lv.blockWord(d3, d2);
    const id = w & 0x3ff;
    if (id !== 0 && ((w >> d5) & 1)) {
      const ci = lv.collision[this._path()][id];
      if (ci !== 0) {
        let ang = lv.angles[ci];
        let d1 = d2;
        if (w & 0x800) { d1 = ~d1; ang = -(ang + 0x40) - 0x40; }
        if (w & 0x400) ang = -ang;
        this._setAngleSlot(slot, ang);
        let h = lv.heightsRot[ci * 16 + (d1 & 0xf)];
        if ((w ^ d6) & 0x400) h = -h;
        if (h !== 0) {
          let toPrev = false;
          if (h < 0) {
            if ((d3 & 0xf) + h < 0) toPrev = true;
          } else if (h === 0x10) {
            toPrev = true;
          } else {
            return s16(0xf - ((d3 & 0xf) + h));
          }
          if (toPrev) return s16(this._findWall2(d2, s16(d3 - a3), d5, d6, slot) - 0x10); // loc_108DC
        }
      }
    }
    // loc_10856
    return s16(this._findWall2(d2, s16(d3 + a3), d5, d6, slot) + 0x10);
  }

  // sub_108EA
  _findWall2(d2, d3, d5, d6, slot) {
    const lv = this.level;
    const w = lv.blockWord(d3, d2);
    const id = w & 0x3ff;
    if (id !== 0 && ((w >> d5) & 1)) {
      const ci = lv.collision[this._path()][id];
      if (ci !== 0) {
        let ang = lv.angles[ci];
        let d1 = d2;
        if (w & 0x800) { d1 = ~d1; ang = -(ang + 0x40) - 0x40; }
        if (w & 0x400) ang = -ang;
        this._setAngleSlot(slot, ang);
        let h = lv.heightsRot[ci * 16 + (d1 & 0xf)];
        if ((w ^ d6) & 0x400) h = -h;
        if (h > 0) return s16(0xf - ((d3 & 0xf) + h));
        if (h < 0 && (d3 & 0xf) + h < 0) return s16(~(d3 & 0xf)); // loc_1096E
      }
    }
    // loc_108FA
    return 0xf - (d3 & 0xf);
  }

  // Rounds an angle to its quadrant the way Player_AnglePos / sub_10980 do
  // (ties at $20/$60/$A0/$E0 go to the floor/ceiling modes).
  static _quadrant(a) {
    let d0;
    if ((a + 0x20) & 0x80) {
      d0 = a;
      if (a & 0x80) d0 -= 1;
      d0 += 0x20;
    } else {
      d0 = a;
      if (a & 0x80) d0 += 1;
      d0 += 0x1f;
    }
    return d0 & 0xc0;
  }

  // Player_AnglePos (loc_FFB8): keep the player attached to the ground
  _anglePos() {
    const d5 = this.top_solid_bit;
    if (this.status & S_ONOBJ) {
      this.primaryAngle = 0;
      this.secondaryAngle = 0;
      return;
    }
    this.primaryAngle = 3;
    this.secondaryAngle = 3;
    const q = Player._quadrant(this.angle);
    if (q === 0x40) return this._walkVertL(d5);
    if (q === 0x80) return this._walkCeiling(d5);
    if (q === 0xc0) return this._walkVertR(d5);
    const x = this.x_pos, y = this.y_pos;
    const d0 = this._findFloor(y + s8(this.y_radius), x + s8(this.x_radius), d5, 0x10, 0, 0);
    let d1 = this._findFloor(y + s8(this.y_radius), x - s8(this.x_radius), d5, 0x10, 0, 1);
    d1 = this._playerAngle(d0, d1);
    if (d1 === 0) return;
    if (d1 < 0) {
      if (d1 >= -0xe) this._addY(d1);
      return;
    }
    // loc_1008A
    if (!this.stick_to_convex && d1 > this._snapLimit(this.x_vel)) return this._leaveGround(); // loc_100AE
    this._addY(d1);
  }

  // abs(high byte of velocity) + 4, capped to $E (loc_1008A)
  _snapLimit(vel) {
    let d0 = (vel >> 8) & 0xff;
    if (d0 & 0x80) d0 = -d0 & 0xff;
    d0 = (d0 + 4) & 0xff;
    if (d0 >= 0xe) d0 = 0xe;
    return d0;
  }

  _leaveGround() {
    this.status |= S_INAIR;
    this.status &= ~S_PUSH;
    this.prev_anim = 1;
  }

  // Player_Angle: d0 = primary distance, d1 = secondary distance; returns nearest
  _playerAngle(d0, d1) {
    let d2 = this.secondaryAngle;
    if (d1 > d0) {
      d2 = this.primaryAngle;
      d1 = d0;
    }
    if (!(d2 & 1)) {
      let diff = (d2 - this.angle) & 0xff;
      if (diff & 0x80) diff = -diff & 0xff;
      if (diff < 0x20) {
        this.angle = d2;
        return d1;
      }
    }
    // loc_100F0: snap to the nearest 90 degrees
    this.angle = (this.angle + 0x20) & 0xc0;
    return d1;
  }

  // Player_WalkVertR
  _walkVertR(d5) {
    const x = this.x_pos, y = this.y_pos;
    const d0 = this._findWall(y - s8(this.x_radius), x + s8(this.y_radius), d5, 0x10, 0, 0);
    let d1 = this._findWall(y + s8(this.x_radius), x + s8(this.y_radius), d5, 0x10, 0, 1);
    d1 = this._playerAngle(d0, d1);
    if (d1 === 0) return;
    if (d1 < 0) {
      if (d1 < -0xe) {
        // loc_10184 (Angel Island 1 only)
        if (this.level.zoneAct === 0) {
          this.angle = 0xc0;
          this.obj41 = 3;
        }
        return;
      }
      if (this.obj41) {
        this.obj41--; // loc_10178
        this.angle = 0xc0;
        return;
      }
      this._addX(d1);
      return;
    }
    if (!this.stick_to_convex && d1 > this._snapLimit(this.y_vel)) return this._leaveGround();
    this._addX(d1);
  }

  // Player_WalkCeiling
  _walkCeiling(d5) {
    const x = this.x_pos, y = this.y_pos;
    const d2 = (y - s8(this.y_radius)) ^ 0xf;
    const d0 = this._findFloor(d2, x + s8(this.x_radius), d5, -0x10, 0x800, 0);
    let d1 = this._findFloor(d2, x - s8(this.x_radius), d5, -0x10, 0x800, 1);
    d1 = this._playerAngle(d0, d1);
    if (d1 === 0) return;
    if (d1 < 0) {
      if (d1 >= -0xe) this._addY(-d1);
      return;
    }
    if (!this.stick_to_convex && d1 > this._snapLimit(this.x_vel)) return this._leaveGround();
    this._addY(-d1);
  }

  // Player_WalkVertL
  _walkVertL(d5) {
    const x = this.x_pos, y = this.y_pos;
    const d3 = (x - s8(this.y_radius)) ^ 0xf;
    const d0 = this._findWall(y - s8(this.x_radius), d3, d5, -0x10, 0x400, 0);
    let d1 = this._findWall(y + s8(this.x_radius), d3, d5, -0x10, 0x400, 1);
    d1 = this._playerAngle(d0, d1);
    if (d1 === 0) return;
    if (d1 < 0) {
      if (d1 >= -0xe) this._addX(-d1);
      return;
    }
    if (!this.stick_to_convex && d1 > this._snapLimit(this.y_vel)) return this._leaveGround();
    this._addX(-d1);
  }

  // loc_10B3E: pick the nearer of two sensors. Returns d1 (nearest), sets _d0
  // (farthest) and _d3 (angle of the nearest, or d2 if that angle is odd/flagged)
  _pickNearest(d0, d1, d2) {
    let d3 = this.secondaryAngle;
    if (d1 > d0) {
      d3 = this.primaryAngle;
      const t = d0; d0 = d1; d1 = t;
    }
    if (d3 & 1) d3 = d2;
    this._d0 = d0;
    this._d3 = d3 & 0xff;
    return d1;
  }

  // loc_10B76: single sensor result
  _singleAngle(d1, d2) {
    let d3 = this.primaryAngle;
    if (d3 & 1) d3 = d2;
    this._d3 = d3 & 0xff;
    return d1;
  }

  // Sonic_CheckFloor (uses top_solid_bit)
  _checkFloor() {
    const d5 = this.top_solid_bit;
    const x = this.x_pos, y = this.y_pos;
    const d2 = y + s8(this.y_radius);
    const d0 = this._findFloor(d2, x + s8(this.x_radius), d5, 0x10, 0, 0);
    const d1 = this._findFloor(d2, x - s8(this.x_radius), d5, 0x10, 0, 1);
    return this._pickNearest(d0, d1, 0);
  }

  // Sonic_CheckCeiling (d5 = caller's solidity bit)
  _checkCeiling(d5) {
    const x = this.x_pos, y = this.y_pos;
    const d2 = (y - s8(this.y_radius)) ^ 0xf;
    const d0 = this._findFloor(d2, x + s8(this.x_radius), d5, -0x10, 0x800, 0);
    const d1 = this._findFloor(d2, x - s8(this.x_radius), d5, -0x10, 0x800, 1);
    return this._pickNearest(d0, d1, 0x80);
  }

  // CheckRightCeilingDist
  _checkRightCeilingDist(d5) {
    const x = this.x_pos, y = this.y_pos;
    const d3 = x + s8(this.y_radius);
    const d0 = this._findWall(y - s8(this.x_radius), d3, d5, 0x10, 0, 0);
    const d1 = this._findWall(y + s8(this.x_radius), d3, d5, 0x10, 0, 1);
    return this._pickNearest(d0, d1, 0xc0);
  }

  // CheckLeftCeilingDist
  _checkLeftCeilingDist(d5) {
    const x = this.x_pos, y = this.y_pos;
    const d3 = (x - s8(this.y_radius)) ^ 0xf;
    const d0 = this._findWall(y - s8(this.x_radius), d3, d5, -0x10, 0x400, 0);
    const d1 = this._findWall(y + s8(this.x_radius), d3, d5, -0x10, 0x400, 1);
    return this._pickNearest(d0, d1, 0x40);
  }

  // CheckFloorDist_Part2 (d2 = y, d3 = x)
  _checkFloorDistPart2(d2, d3, d5) {
    const d1 = this._findFloor(d2 + 0xa, d3, d5, 0x10, 0, 0);
    return this._singleAngle(d1, 0);
  }

  // CheckCeilingDist_Part2
  _checkCeilingDistPart2(d2, d3, d5) {
    const d1 = this._findFloor((d2 - 0xa) ^ 0xf, d3, d5, -0x10, 0x800, 0);
    return this._singleAngle(d1, 0x80);
  }

  // CheckRightWallDist (loc_10DE4)
  _checkRightWallDist(d5, d2 = this.y_pos, d3 = this.x_pos) {
    const d1 = this._findWall(d2, d3 + 0xa, d5, 0x10, 0, 0);
    return this._singleAngle(d1, 0xc0);
  }

  // CheckLeftWallDist (loc_11084)
  _checkLeftWallDist(d5, d2 = this.y_pos, d3 = this.x_pos) {
    const d1 = this._findWall(d2, (d3 - 0xa) ^ 0xf, d5, -0x10, 0x400, 0);
    return this._singleAngle(d1, 0x40);
  }

  // ChkFloorEdge / ChkFloorEdge_Part2 (d3 = x)
  _chkFloorEdge(d3 = this.x_pos) {
    const d2 = this.y_pos + s8(this.y_radius);
    this.primaryAngle = 0;
    const d1 = this._findFloor(d2, d3, this.top_solid_bit, 0x10, 0, 0);
    return this._singleAngle(d1, 0);
  }

  // CalcRoomOverHead: d0 = angle perpendicular to the spine
  _calcRoomOverHead(d0) {
    const d5 = this.lrb_solid_bit;
    this.primaryAngle = d0 & 0xff;
    this.secondaryAngle = d0 & 0xff;
    const q = (d0 + 0x20) & 0xc0;
    if (q === 0x40) return this._checkLeftCeilingDist(d5);
    if (q === 0x80) return this._checkCeiling(d5);
    if (q === 0xc0) return this._checkRightCeilingDist(d5);
    return this._checkFloor(); // falls through into Sonic_CheckFloor
  }

  // sub_10980 (CalcRoomInFront): d0 = direction angle; uses next frame's position
  _calcRoomInFront(d0) {
    const d5 = this.lrb_solid_bit;
    const d3 = ((this._x + (this.x_vel << 8)) | 0) >> 16;
    let d2 = ((this._y + (this.y_vel << 8)) | 0) >> 16;
    this.primaryAngle = d0 & 0xff;
    this.secondaryAngle = d0 & 0xff;
    const q = Player._quadrant(d0 & 0xff);
    if (q === 0) return this._checkFloorDistPart2(d2, d3, d5);
    if (q === 0x80) return this._checkCeilingDistPart2(d2, d3, d5);
    if ((d0 & 0x38) === 0) d2 += 8;
    if (q === 0x40) return this._checkLeftWallDist(d5, d2, d3);
    return this._checkRightWallDist(d5, d2, d3);
  }

  // ================================================================ main loop
  update(input) {
    const h = input?.held ?? {};
    const p = input?.pressed ?? {};
    this.held = { up: !!h.up, down: !!h.down, left: !!h.left, right: !!h.right, jump: !!(h.a || h.b || h.c) };
    this.pressed = { up: !!p.up, down: !!p.down, left: !!p.left, right: !!p.right, jump: !!(p.a || p.b || p.c) };
    this.frameCounter = (this.frameCounter + 1) & 0xffff;
    switch (this.routine) {
      case 2: this._control(); break;
      case 4: this._hurtRoutine(); break;
      case 6: this._deathRoutine(); break;
      default: break; // 8: dead, waiting for the game to restart
    }
  }

  // Sonic_Control (routine 2)
  _control() {
    if (this.object_control & 1) {
      this.double_jump_flag = 0;
    } else {
      switch (this.status & 6) {
        case 0: this._mdNormal(); break;
        case 2: this._mdAir(); break;
        case 4: this._mdRoll(); break;
        case 6: this._mdJump(); break;
      }
    }
    if (this.routine !== 2) {
      // killed by the level boundary during the mode routine
      this.visible = true;
    } else {
      this._display();
    }
    this.next_tilt = this.primaryAngle;
    this.tilt = this.secondaryAngle;
    this._instaShieldTick();
    if (!(this.object_control & 2)) this._animate();
  }

  // Sonic_Display: invulnerability flashing + invincibility / speed shoes timers
  _display() {
    const t = this.invulnerable_time;
    if (t) {
      this.invulnerable_time = t - 1;
      this.visible = (t & 4) !== 0; // lsr.b #3 shifts bit 2 into carry
    } else {
      this.visible = true;
    }
    const tick = (this.frameCounter & 7) === 0;
    // Sonic_ChkInvin
    if ((this.status_secondary & STATUS2.Invincible) && this.invincibility_timer && tick) {
      if (--this.invincibility_timer === 0) this.status_secondary &= ~STATUS2.Invincible;
    }
    // Sonic_ChkShoes
    if ((this.status_secondary & STATUS2.SpeedShoes) && this.speed_shoes_timer && tick) {
      if (--this.speed_shoes_timer === 0) this.speedShoes = false;
    }
  }

  // Obj_InstaShield_Main marks the attack as over once its animation reaches
  // frame 7; approximated with a frame timer.
  _instaShieldTick() {
    if (this._instaShieldTimer > 0 && --this._instaShieldTimer === 0) {
      if (this.double_jump_flag === 1) this.double_jump_flag = 2;
      this.shield_anim = 0;
    }
  }

  // Sonic_MdNormal
  _mdNormal() {
    if (this._spindash()) return;
    if (this._jump()) return;
    this._slopeResist();
    this._move();
    this._roll();
    this._levelBound();
    if (this.routine !== 2) return;
    this._moveSprite2();
    this._anglePos();
    this._slopeRepel();
  }

  // Sonic_MdAir
  _mdAir() {
    this._jumpHeight();
    this._chgJumpDir();
    this._levelBound();
    if (this.routine !== 2) return;
    this._moveSprite();
    this._jumpAngle();
    this._doLevelCollision();
  }

  // Sonic_MdRoll
  _mdRoll() {
    if (!this.spin_dash_flag && this._jump()) return;
    this._rollRepel();
    this._rollSpeed();
    this._levelBound();
    if (this.routine !== 2) return;
    this._moveSprite2();
    this._anglePos();
    this._slopeRepel();
  }

  // Sonic_MdJump (identical to Sonic_MdAir)
  _mdJump() {
    this._mdAir();
  }

  // MoveSprite2
  _moveSprite2() {
    this._x = (this._x + (this.x_vel << 8)) | 0;
    this._y = (this._y + (this.y_vel << 8)) | 0;
  }

  // MoveSprite (with gravity $38)
  _moveSprite() {
    this._x = (this._x + (this.x_vel << 8)) | 0;
    const yv = this.y_vel;
    this.y_vel = s16(yv + 0x38);
    this._y = (this._y + (yv << 8)) | 0;
  }

  // camera bias back towards $60 (loc_12392 / loc_12636 / Sonic_Jump_ResetScr)
  _recenterCamera() {
    if (this.distance_from_top === 0x60) return;
    if (this.distance_from_top < 0x60) this.distance_from_top += 4;
    this.distance_from_top -= 2;
  }

  // ---------------------------------------------------------------- Sonic_Move
  _move() {
    const d6 = this.max_speed, d4 = this.deceleration;
    const d5 = this.acceleration;
    let lbl;
    if (this.status_secondary & 0x80) {
      lbl = 0x123d6;
    } else if (this.move_lock !== 0) {
      lbl = 0x1238c;
    } else {
      if (this.held.left) this._moveLeft(d4, d5, d6); // sub_12480
      if (this.held.right) this._moveRight(d4, d5, d6); // sub_1250C
      // Sonic_NotRight
      if (((this.angle + 0x20) & 0xc0) !== 0 || this.ground_vel !== 0) {
        lbl = 0x1238c;
      } else {
        this.status &= ~S_PUSH;
        this.anim = 5; // standing
        lbl = this._balance();
      }
    }
    if (lbl === 0x1238c) {
      this.scroll_delay_counter = 0;
      lbl = 0x12392;
    }
    if (lbl === 0x12392) {
      this._recenterCamera();
      lbl = 0x1239e;
    }
    if (lbl === 0x1239e) {
      // friction when neither left nor right is held
      if (!this.held.left && !this.held.right && this.ground_vel !== 0) {
        const gv = this.ground_vel;
        if (gv > 0) this.ground_vel = gv - d5 < 0 ? 0 : gv - d5;
        else this.ground_vel = u16(gv) + d5 > 0xffff ? 0 : gv + d5;
      }
    }
    // loc_123D6
    const sin = this._sincos(this.angle);
    this.x_vel = s16(Math.imul(this._cos, this.ground_vel) >> 8);
    this.y_vel = s16(Math.imul(sin, this.ground_vel) >> 8);
    this._wallInFront();
  }

  // Balancing on ledges / objects; returns the label to continue at
  _balance() {
    if (this.status & S_ONOBJ) {
      const o = this.interact;
      if (!o || (o.status & 0x80)) return this._lookUpDown();
      let d1 = o.width_pixels;
      let d2 = d1 * 2 - 2;
      d1 = s16(d1 + this.x_pos - o.x_pos);
      if (d1 < 2) {
        // Sonic_BalanceOnObjLeft
        this.status |= S_FACING;
        this.anim = 6;
        if (d1 < -4) this.anim = 0xc;
        return 0x1238c;
      }
      if (d1 >= d2) {
        // Sonic_BalanceOnObjRight
        this.status &= ~S_FACING;
        this.anim = 6;
        d2 += 6;
        if (d1 >= d2) this.anim = 0xc;
        return 0x1238c;
      }
      return this._lookUpDown();
    }
    // Sonic_Balance
    if (this._chkFloorEdge() < 0xc) return this._lookUpDown();
    if (this.next_tilt === 3) {
      this.status &= ~S_FACING;
      this.anim = 6;
      if (this._chkFloorEdge(this.x_pos - 6) >= 0xc) this.anim = 0xc;
      return 0x1238c;
    }
    if (this.tilt !== 3) return this._lookUpDown();
    this.status |= S_FACING;
    this.anim = 6;
    if (this._chkFloorEdge(this.x_pos + 6) >= 0xc) this.anim = 0xc;
    return 0x1238c;
  }

  // loc_12338: look up / duck
  _lookUpDown() {
    if (this.held.up) {
      this.anim = 7;
      this.scroll_delay_counter = (this.scroll_delay_counter + 1) & 0xff;
      if (this.scroll_delay_counter < 120) return 0x12392;
      this.scroll_delay_counter = 120;
      if (this.distance_from_top !== 0xc8) this.distance_from_top += 2;
      return 0x1239e;
    }
    if (this.held.down) {
      this.anim = 8;
      this.scroll_delay_counter = (this.scroll_delay_counter + 1) & 0xff;
      if (this.scroll_delay_counter < 120) return 0x12392;
      this.scroll_delay_counter = 120;
      if (this.distance_from_top !== 8) this.distance_from_top -= 2;
      return 0x1239e;
    }
    return 0x1238c;
  }

  // sub_12480: left pressed on the ground
  _moveLeft(d4, d5, d6) {
    let d0 = this.ground_vel;
    if (d0 <= 0) {
      if (!(this.status & S_FACING)) {
        this.status |= S_FACING;
        this.status &= ~S_PUSH;
        this.prev_anim = 1;
      }
      d0 = s16(d0 - d5);
      const d1 = -d6;
      if (d0 <= d1) {
        d0 = s16(d0 + d5);
        if (d0 > d1) d0 = d1;
      }
      this.ground_vel = d0;
      this.anim = 0;
      return;
    }
    // loc_124BA: braking
    d0 = u16(d0) < d4 ? -0x80 : d0 - d4;
    this.ground_vel = d0;
    if (((this.angle + 0x20) & 0xc0) !== 0) return;
    // (original bug kept: low byte of d0 was overwritten by the angle check)
    if (s16(d0 & 0xff00) < 0x400) return;
    if (this.flip_type & 0x80) return;
    this.anim = 0xd; // skid
    this.status &= ~S_FACING;
  }

  // sub_1250C: right pressed on the ground
  _moveRight(d4, d5, d6) {
    let d0 = this.ground_vel;
    if (d0 >= 0) {
      if (this.status & S_FACING) {
        this.status &= ~S_FACING;
        this.status &= ~S_PUSH;
        this.prev_anim = 1;
      }
      d0 = s16(d0 + d5);
      if (d0 >= d6) {
        d0 = s16(d0 - d5);
        if (d0 < d6) d0 = d6;
      }
      this.ground_vel = d0;
      this.anim = 0;
      return;
    }
    // loc_12540: braking
    d0 = u16(d0) + d4 > 0xffff ? 0x80 : d0 + d4;
    this.ground_vel = d0;
    if (((this.angle + 0x20) & 0xc0) !== 0) return;
    if (s16(d0 & 0xff00) > -0x400) return;
    if (this.flip_type & 0x80) return;
    this.anim = 0xd;
    this.status |= S_FACING;
  }

  // loc_123F4: stop at walls in front (uses CalcRoomInFront)
  _wallInFront() {
    if (this.object_control & 0x40) return;
    if ((this.angle + 0x40) & 0x80) return;
    if (this.ground_vel === 0) return;
    const d1 = this.ground_vel < 0 ? 0x40 : -0x40;
    const d0 = (this.angle + d1) & 0xff;
    let dist = this._calcRoomInFront(d0);
    if (dist >= 0) return;
    dist = s16(dist << 8);
    const q = (d0 + 0x20) & 0xc0;
    if (q === 0) {
      this.y_vel = s16(this.y_vel + dist);
    } else if (q === 0x40) {
      this.x_vel = s16(this.x_vel - dist);
      this.ground_vel = 0;
      if (this.status & S_FACING) this.status |= S_PUSH;
    } else if (q === 0x80) {
      this.y_vel = s16(this.y_vel - dist);
    } else {
      this.x_vel = s16(this.x_vel + dist);
      this.ground_vel = 0;
      if (!(this.status & S_FACING)) this.status |= S_PUSH;
    }
  }

  // ---------------------------------------------------------------- Sonic_RollSpeed
  _rollSpeed() {
    const d5 = this.acceleration >> 1;
    const d4 = 0x20;
    if (!(this.spin_dash_flag & 0x80) && !(this.status_secondary & 0x80)) {
      if (this.move_lock === 0) {
        if (this.held.left) {
          // sub_12678
          const gv = this.ground_vel;
          if (gv <= 0) {
            this.status |= S_FACING;
            this.anim = 2;
          } else {
            this.ground_vel = u16(gv) < d4 ? -0x80 : gv - d4;
          }
        }
        if (this.held.right) {
          // sub_1269C
          const gv = this.ground_vel;
          if (gv >= 0) {
            this.status &= ~S_FACING;
            this.anim = 2;
          } else {
            this.ground_vel = u16(gv) + d4 > 0xffff ? 0x80 : gv + d4;
          }
        }
      }
      // loc_125CE: rolling friction
      const gv = this.ground_vel;
      if (gv > 0) this.ground_vel = u16(gv) < d5 ? 0 : gv - d5;
      else if (gv < 0) this.ground_vel = u16(gv) + d5 > 0xffff ? 0 : gv + d5;
      // loc_125F0
      if (this.ground_vel === 0) {
        if (!this.spin_dash_flag) {
          this.status &= ~S_ROLL;
          const d0 = this.y_radius;
          this.y_radius = this.default_y_radius;
          this.x_radius = this.default_x_radius;
          this.anim = 5;
          this._addY(s8(d0 - this.default_y_radius));
        } else {
          this.ground_vel = this.status & S_FACING ? -0x400 : 0x400;
        }
      }
    }
    // loc_12636
    this._recenterCamera();
    const sin = this._sincos(this.angle);
    this.y_vel = s16(Math.imul(sin, this.ground_vel) >> 8);
    let d1 = s16(Math.imul(this._cos, this.ground_vel) >> 8);
    if (d1 > 0x1000) d1 = 0x1000;
    if (d1 < -0x1000) d1 = -0x1000;
    this.x_vel = d1;
    this._wallInFront();
  }

  // Sonic_ChgJumpDir: air control
  _chgJumpDir() {
    const d6 = this.max_speed;
    const d5 = this.acceleration << 1;
    if (!(this.status & S_ROLLJUMP)) {
      let d0 = this.x_vel;
      if (this.held.left) {
        this.status |= S_FACING;
        d0 = s16(d0 - d5);
        const d1 = -d6;
        if (d0 <= d1) {
          d0 = s16(d0 + d5);
          if (d0 > d1) d0 = d1;
        }
      }
      if (this.held.right) {
        this.status &= ~S_FACING;
        d0 = s16(d0 + d5);
        if (d0 >= d6) {
          d0 = s16(d0 - d5);
          if (d0 < d6) d0 = d6;
        }
      }
      this.x_vel = d0;
    }
    // Sonic_Jump_ResetScr
    this._recenterCamera();
    // Sonic_JumpPeakDecelerate: air drag while -$400 <= y_vel < 0
    if (u16(this.y_vel) < 0xfc00) return;
    const d0 = this.x_vel;
    const d1 = d0 >> 5;
    if (d1 === 0) return;
    if (d1 > 0) this.x_vel = u16(d0) < u16(d1) ? 0 : d0 - d1;
    else this.x_vel = u16(d0) < u16(d1) ? s16(d0 - d1) : 0;
  }

  // Player_LevelBound
  _levelBound() {
    const d1 = u16(((this._x + (this.x_vel << 8)) | 0) >> 16);
    let d0 = u16(this.bounds.minX + 0x10);
    let clamp = d0 > d1;
    if (!clamp) {
      d0 = u16(this.bounds.maxX + 0x128);
      clamp = d0 <= d1;
    }
    if (clamp) {
      // Player_Boundary_Sides
      this._x = (s16(d0) << 16) | 0;
      this.x_vel = 0;
      this.ground_vel = 0;
    }
    // Player_Boundary_CheckBottom
    if (s16(this.bounds.maxY + 0xe0) < this.y_pos) this.kill();
  }

  // Sonic_Roll
  _roll() {
    if (this.status_secondary & 0x80) return;
    if (u16(Math.abs(this.ground_vel)) < 0x80) return;
    if (this.held.left || this.held.right) return;
    if (!this.held.down) return;
    if (!(this.status & S_ROLL)) this._doRoll(); // Player_ChkRoll
  }

  // Player_DoRoll
  _doRoll() {
    this.status |= S_ROLL;
    this.y_radius = 0xe;
    this.x_radius = 7;
    this.anim = 2;
    this._addY(5);
    if (this.ground_vel === 0) this.ground_vel = 0x200;
  }

  // Sonic_Jump; returns true when the rest of the mode routine is skipped
  _jump() {
    if (!this.pressed.jump) return false;
    const room = this._calcRoomOverHead((this.angle + 0x80) & 0xff);
    if (room < 6) return false; // not enough room to jump
    const d2 = 0x680;
    const sin = this._sincos((this.angle - 0x40) & 0xff);
    this.x_vel = s16(this.x_vel + (Math.imul(this._cos, d2) >> 8));
    this.y_vel = s16(this.y_vel + (Math.imul(sin, d2) >> 8));
    this.status |= S_INAIR;
    this.status &= ~S_PUSH;
    this.jumping = 1;
    this.stick_to_convex = 0;
    this.y_radius = this.default_y_radius;
    this.x_radius = this.default_x_radius;
    if (this.status & S_ROLL) {
      this.status |= S_ROLLJUMP; // Sonic_RollJump
      return true;
    }
    this.y_radius = 0xe;
    this.x_radius = 7;
    this.anim = 2;
    this.status |= S_ROLL;
    this._addY(-s8(this.y_radius - this.default_y_radius));
    return true;
  }

  // Sonic_JumpHeight
  _jumpHeight() {
    if (this.jumping) {
      const d1 = -0x400;
      if (d1 > this.y_vel) {
        if (!this.held.jump) this.y_vel = d1; // let go of jump: cap jump height
        return;
      }
      this._shieldMoves();
      return;
    }
    // Sonic_UpVelCap
    if (this.spin_dash_flag) return;
    if (this.y_vel < -0xfc0) this.y_vel = -0xfc0;
  }

  // Sonic_ShieldMoves -> Sonic_InstaShield (elemental shields: velocity effects only)
  _shieldMoves() {
    if (this.double_jump_flag) return;
    if (!this.pressed.jump) return;
    this.status &= ~S_ROLLJUMP;
    const s2 = this.status_secondary;
    if (s2 & STATUS2.Invincible) return; // Sonic_FireShield
    if (s2 & STATUS2.FireShield) {
      this.shield_anim = 1;
      this.double_jump_flag = 1;
      const v = this.status & S_FACING ? -0x800 : 0x800;
      this.x_vel = v;
      this.ground_vel = v;
      this.y_vel = 0;
      return;
    }
    if (s2 & STATUS2.LtngShield) {
      this.shield_anim = 1;
      this.double_jump_flag = 1;
      this.y_vel = -0x580;
      this.jumping = 0;
      return;
    }
    if (s2 & STATUS2.BublShield) {
      this.shield_anim = 1;
      this.double_jump_flag = 1;
      this.x_vel = 0;
      this.ground_vel = 0;
      this.y_vel = 0x800;
      return;
    }
    // Sonic_InstaShield
    if (s2 & STATUS2.Shield) return;
    this.shield_anim = 1;
    this.double_jump_flag = 1;
    this._instaShieldTimer = 15;
  }

  // Sonic_Spindash; returns true when the rest of Sonic_MdNormal is skipped
  _spindash() {
    if (!this.spin_dash_flag) {
      if (this.anim !== 8) return false; // must be ducking
      if (!this.pressed.jump) return false;
      this.anim = 9;
      this.spin_dash_flag = 1;
      this.spin_dash_counter = 0;
      this.spin_revs = 0;
      this.onSound?.('spindash', 0); // sfx_Spindash
      // loc_12B6E
      this._levelBound();
      if (this.routine === 2) this._anglePos();
      return true;
    }
    // loc_12B9C
    if (!this.held.down) {
      // release
      this.y_radius = 0xe;
      this.x_radius = 7;
      this.anim = 2;
      this._addY(5);
      this.spin_dash_flag = 0;
      this.ground_vel = SPINDASH_SPEEDS[this.spin_dash_counter >> 8];
      if (this.status & S_FACING) this.ground_vel = -this.ground_vel;
      this.status |= S_ROLL;
    } else {
      // loc_12C48: charging
      if (this.spin_dash_counter !== 0) {
        this.spin_dash_counter -= this.spin_dash_counter >> 5;
      }
      if (this.pressed.jump) {
        this.anim = 9;
        this.prev_anim = 0; // restart the spindash anim
        this.onSound?.('spindash', ++this.spin_revs); // sfx_Spindash on every rev (loc_12C60)
        this.spin_dash_counter += 0x200;
        if (this.spin_dash_counter >= 0x800) this.spin_dash_counter = 0x800;
      }
    }
    // loc_12C90
    this._recenterCamera();
    this._levelBound();
    if (this.routine === 2) this._anglePos();
    return true;
  }

  // Player_SlopeResist
  _slopeResist() {
    if (((this.angle + 0x60) & 0xff) >= 0xc0) return;
    const d0 = Math.imul(this._sincos(this.angle), 0x20) >> 8;
    const gv = this.ground_vel;
    if (gv === 0) {
      if (Math.abs(d0) < 0xd) return;
    } else if (gv > 0 && d0 === 0) return;
    this.ground_vel = s16(gv + d0);
  }

  // Player_RollRepel
  _rollRepel() {
    if (((this.angle + 0x60) & 0xff) >= 0xc0) return;
    let d0 = Math.imul(this._sincos(this.angle), 0x50) >> 8;
    if (this.ground_vel >= 0) {
      if (d0 < 0) d0 >>= 2;
    } else if (d0 >= 0) d0 >>= 2;
    this.ground_vel = s16(this.ground_vel + d0);
  }

  // Player_SlopeRepel: fall off / slide down steep slopes when too slow
  _slopeRepel() {
    if (this.stick_to_convex) return;
    if (this.move_lock !== 0) {
      this.move_lock--;
      return;
    }
    if (((this.angle + 0x18) & 0xff) < 0x30) return;
    if (u16(Math.abs(this.ground_vel)) >= 0x280) return;
    this.move_lock = 30;
    const d0 = (this.angle + 0x30) & 0xff;
    if (d0 >= 0x60) {
      this.status |= S_INAIR;
      return;
    }
    this.ground_vel = s16(this.ground_vel + (d0 >= 0x30 ? 0x80 : -0x80));
  }

  // Player_JumpAngle + Player_JumpFlip
  _jumpAngle() {
    let d0 = this.angle;
    if (d0 !== 0) {
      if (d0 & 0x80) {
        d0 += 2;
        if (d0 > 0xff) d0 = 0;
      } else {
        d0 -= 2;
        if (d0 < 0) d0 = 0;
      }
      this.angle = d0;
    }
    // Player_JumpFlip
    d0 = this.flip_angle;
    if (d0 === 0) return;
    const right = () => {
      d0 += this.flip_speed;
      if (d0 > 0xff) {
        d0 &= 0xff;
        if (--this.flips_remaining < 0) {
          this.flips_remaining = 0;
          d0 = 0;
        }
      }
    };
    if (this.ground_vel >= 0 || (this.flip_type & 0x80)) right();
    else {
      d0 -= this.flip_speed;
      if (d0 < 0) {
        d0 &= 0xff;
        if (--this.flips_remaining < 0) {
          this.flips_remaining = 0;
          d0 = 0;
        }
      }
    }
    this.flip_angle = d0;
  }

  // ---------------------------------------------------------------- Sonic_DoLevelCollision
  _doLevelCollision() {
    const d5 = this.lrb_solid_bit;
    const q = (this._arctan(this.x_vel, this.y_vel) - 0x20) & 0xc0;
    if (q === 0x40) return this._hitLeftWall(d5);
    if (q === 0x80) return this._hitCeilingAndWalls(d5);
    if (q === 0xc0) return this._hitRightWall(d5);
    // moving mostly downwards
    let d1 = this._checkLeftWallDist(d5);
    if (d1 < 0) {
      this._addX(-d1);
      this.x_vel = 0;
    }
    d1 = this._checkRightWallDist(d5);
    if (d1 < 0) {
      this._addX(d1);
      this.x_vel = 0;
    }
    d1 = this._checkFloor();
    if (d1 >= 0) return;
    const d0 = this._d0, d3 = this._d3;
    const d2 = s8(-(((this.y_vel >> 8) + 8) & 0xff));
    if (!(s8(d1) >= d2) && s8(d0) < d2) return;
    // loc_12E94: landed
    this._addY(d1);
    this.angle = d3;
    if (((d3 + 0x20) & 0x40) === 0) {
      if (((d3 + 0x10) & 0x20) === 0) {
        // flat-ish floor
        this.y_vel = 0;
        this.ground_vel = this.x_vel;
        this._touchFloorCheckSpindash();
        return;
      }
      this.y_vel >>= 1; // slope: half the falling speed
    } else {
      // loc_12ECC: steep slope
      this.x_vel = 0;
      if (this.y_vel > 0xfc0) this.y_vel = 0xfc0;
    }
    // loc_12EE0
    this._touchFloorCheckSpindash();
    this.ground_vel = d3 & 0x80 ? s16(-this.y_vel) : this.y_vel;
  }

  // Player_HitLeftWall (moving left)
  _hitLeftWall(d5) {
    const d1 = this._checkLeftWallDist(d5);
    if (d1 < 0) {
      this._addX(-d1);
      this.x_vel = 0;
      this.ground_vel = this.y_vel;
    }
    this._hitCeiling(d5);
  }

  // Player_HitCeiling
  _hitCeiling(d5) {
    let d1 = this._checkCeiling(d5);
    if (d1 < 0) {
      d1 = -d1;
      if (d1 >= 0x14) {
        // loc_12F2E
        const r = this._checkRightWallDist(d5);
        if (r < 0) {
          this._addX(r);
          this.x_vel = 0;
        }
        return;
      }
      this._addY(d1);
      if (this.y_vel < 0) this.y_vel = 0;
      return;
    }
    // loc_12F42
    if (this.y_vel < 0) return;
    this._landIfFloor();
  }

  // loc_12F4E / loc_1300A
  _landIfFloor() {
    const d1 = this._checkFloor();
    if (d1 >= 0) return;
    this._addY(d1);
    this.angle = this._d3;
    this.y_vel = 0;
    this.ground_vel = this.x_vel;
    this._touchFloorCheckSpindash();
  }

  // Player_HitCeilingAndWalls (moving up)
  _hitCeilingAndWalls(d5) {
    let d1 = this._checkLeftWallDist(d5);
    if (d1 < 0) {
      this._addX(-d1);
      this.x_vel = 0;
    }
    d1 = this._checkRightWallDist(d5);
    if (d1 < 0) {
      this._addX(d1);
      this.x_vel = 0;
    }
    d1 = this._checkCeiling(d5);
    if (d1 >= 0) return;
    const d3 = this._d3;
    this._addY(-d1);
    if (((d3 + 0x20) & 0x40) === 0) {
      this.y_vel = 0; // hit a ceiling
      return;
    }
    // loc_12FB4: landed on a steep ceiling slope, keep running along it
    this.angle = d3;
    this._touchFloorCheckSpindash();
    this.ground_vel = d3 & 0x80 ? s16(-this.y_vel) : this.y_vel;
  }

  // loc_12FCC (moving right)
  _hitRightWall(d5) {
    let d1 = this._checkRightWallDist(d5);
    if (d1 < 0) {
      this._addX(d1);
      this.x_vel = 0;
      this.ground_vel = this.y_vel;
    }
    d1 = this._checkCeiling(d5);
    if (d1 < 0) {
      this._addY(-d1);
      if (this.y_vel < 0) this.y_vel = 0;
      return;
    }
    if (this.y_vel < 0) return;
    this._landIfFloor();
  }

  // Player_TouchFloor_Check_Spindash
  _touchFloorCheckSpindash() {
    if (this.spin_dash_flag) {
      this._touchFloorFlags();
      return;
    }
    this.anim = 0;
    this._touchFloor();
  }

  // Player_TouchFloor
  _touchFloor() {
    const d0 = this.y_radius;
    this.y_radius = this.default_y_radius;
    this.x_radius = this.default_x_radius;
    if (this.status & S_ROLL) {
      this.status &= ~S_ROLL;
      this.anim = 0;
      this._addY(s8(d0 - this.default_y_radius));
    }
    this._touchFloorFlags();
  }

  // loc_13070
  _touchFloorFlags() {
    this.status &= ~(S_INAIR | S_PUSH | S_ROLLJUMP);
    this.jumping = 0;
    this.flip_angle = 0;
    this.flip_type = 0;
    this.flips_remaining = 0;
    this.scroll_delay_counter = 0;
    if (this.double_jump_flag) {
      if (this.status_secondary & STATUS2.BublShield) this._bubbleShieldBounce();
      this.double_jump_flag = 0;
    }
  }

  // BubbleShield_Bounce
  _bubbleShieldBounce() {
    const d2 = 0x780;
    const sin = this._sincos((this.angle - 0x40) & 0xff);
    this.x_vel = s16(this.x_vel + (Math.imul(this._cos, d2) >> 8));
    this.y_vel = s16(this.y_vel + (Math.imul(sin, d2) >> 8));
    this.status |= S_INAIR;
    this.status &= ~S_PUSH;
    this.jumping = 1;
    this.stick_to_convex = 0;
    this.y_radius = 0xe;
    this.x_radius = 7;
    this.anim = 2;
    this.status |= S_ROLL;
    this._addY(-s8(this.y_radius - this.default_y_radius));
    this.shield_anim = 2;
  }

  // ================================================================ hurt / death
  // HurtCharacter. sourceX = x of the hazard. Returns true if Sonic got hurt.
  hurt(sourceX) {
    if (this.routine !== 2) return false;
    if (this.invulnerable_time > 0) return false;
    if (this.status_secondary & STATUS2.Invincible) return false;
    if (this.status_secondary & STATUS2.Shield) {
      this.status_secondary &= 0x8e; // lose the shield, keep the rings
    } else if (!(this.status_tertiary & 0x80)) {
      const hadRings = this.onRingLoss ? this.onRingLoss(this) : true;
      if (!hadRings) {
        this.kill();
        return true;
      }
    }
    // loc_11504
    this.routine = 4;
    this._touchFloor();
    this.status |= S_INAIR;
    this.y_vel = -0x400;
    this.x_vel = -0x200;
    if (sourceX === undefined || sourceX === null) sourceX = this.status & S_FACING ? this.x_pos - 1 : this.x_pos + 1;
    if (u16(this.x_pos) >= u16(sourceX)) this.x_vel = 0x200;
    this.ground_vel = 0;
    this.anim = 0x1a;
    this.invulnerable_time = 120;
    this.spin_dash_flag = 0;
    return true;
  }

  // Kill_Character
  kill() {
    if (this.routine >= 6) return;
    this.status_secondary = 0;
    this.status_tertiary = 0;
    this.routine = 6;
    this._touchFloor();
    this.status |= S_INAIR;
    this.y_vel = -0x700;
    this.x_vel = 0;
    this.ground_vel = 0;
    this.anim = 0x18;
    this.spin_dash_flag = 0;
    this.invulnerable_time = 0;
    this.visible = true;
    this._deathCamY = this.cameraY ?? this.y_pos - this.distance_from_top;
  }

  // loc_13142 (routine 4): knocked back after getting hurt
  _hurtRoutine() {
    this._moveSprite2();
    this.y_vel = s16(this.y_vel + 0x30);
    // sub_1319C
    if (s16(this.bounds.maxY + 0xe0) < this.y_pos) {
      this.kill();
    } else {
      this._doLevelCollision();
      if (!(this.status & S_INAIR)) {
        this.y_vel = 0;
        this.x_vel = 0;
        this.ground_vel = 0;
        this.object_control = 0;
        this.anim = 0;
        this.routine = 2;
        this.invulnerable_time = 120;
        this.spin_dash_flag = 0;
      }
    }
    if (this.routine === 4 || this.routine === 2) this._levelBound();
    this.visible = true;
    this._animate();
  }

  // loc_131FE (routine 6): falling off the screen
  _deathRoutine() {
    // sub_13230
    this.spin_dash_flag = 0;
    const camY = this.cameraY ?? this._deathCamY;
    if (s16(camY + 0x100) < this.y_pos) {
      this.routine = 8;
      this.dead = true;
    }
    this._moveSprite();
    this._animate();
  }

  // Bounce off something destroyed from above (badnik / monitor)
  bounce(newYVel) {
    this.y_vel = s16(newYVel);
    this.status |= S_INAIR;
  }

  // Springs (sub_2164A for up/down/diagonal springs, sub_21806 for horizontal)
  springLaunch(xVel, yVel) {
    if (this.routine !== 2) return;
    if (yVel) {
      this.y_vel = s16(yVel);
      if (xVel) this.x_vel = s16(xVel);
      this.status |= S_INAIR;
      this.status &= ~S_ONOBJ;
      this.jumping = 0;
      this.spin_dash_flag = 0;
      if (yVel < 0) this.anim = 0x10;
    } else {
      // horizontal spring: stays on the ground, locks controls for $F frames
      this.x_vel = s16(xVel);
      if (xVel < 0) this.status |= S_FACING;
      else this.status &= ~S_FACING;
      this.move_lock = 0xf;
      this.ground_vel = this.x_vel;
      if (!(this.status & S_ROLL)) this.anim = 0;
    }
  }

  // ================================================================ Animate_Sonic
  _animate() {
    const r = this.rom.u8;
    let d0 = this.anim;
    if (d0 !== this.prev_anim) {
      this.prev_anim = d0;
      this.anim_frame = 0;
      this.anim_frame_timer = 0;
      this.status &= ~S_PUSH;
    }
    const a1 = this.animAddrs[d0] ?? this.animAddrs[0];
    const first = r[a1];
    if (!(first & 0x80)) {
      // regular script: byte 0 = frame duration
      this.render_flags = (this.render_flags & 0xfc) | (this.status & 1);
      this.anim_frame_timer = (this.anim_frame_timer - 1) & 0xff;
      if (!(this.anim_frame_timer & 0x80)) return;
      this.anim_frame_timer = first;
      this._animStep(a1);
      return;
    }
    if (first === 0xff) return this._animWalk(); // loc_134F0
    return this._animRoll(); // loc_13786 ($FE / $FD)
  }

  // loc_134A6: advance one frame of a script, handling $FC-$FF commands
  _animStep(a1) {
    const r = this.rom.u8;
    let d1 = this.anim_frame;
    let d0 = r[a1 + 1 + d1];
    if (d0 >= 0xfc) {
      if (d0 === 0xff) {
        // restart
        this.anim_frame = 0;
        d0 = r[a1 + 1];
      } else if (d0 === 0xfe) {
        // go back n frames
        const n = r[a1 + 2 + d1];
        this.anim_frame = (this.anim_frame - n) & 0xff;
        d1 = (d1 - n) & 0xff;
        d0 = r[a1 + 1 + d1];
      } else if (d0 === 0xfd) {
        // switch to another animation
        this.anim = r[a1 + 2 + d1];
        return;
      } else {
        return; // $FC
      }
    }
    this.mapping_frame = d0;
    this.anim_frame = (this.anim_frame + 1) & 0xff;
  }

  // loc_134F0: walk/run, frame set depends on angle, speed sets frame time
  _animWalk() {
    const r = this.rom.u8;
    if ((this.flip_type & 0x80) || this.flip_angle) return this._animTumble();
    let d1 = 0;
    let d0 = this.angle;
    if (d0 !== 0 && !(d0 & 0x80)) d0 -= 1;
    const d2 = this.status & 1;
    if (!d2) d0 = ~d0;
    d0 = (d0 + 0x10) & 0xff;
    if (d0 & 0x80) d1 = 3;
    this.render_flags = (this.render_flags & 0xfc) | (d1 ^ d2);
    if (this.status & S_PUSH) return this._animPush();
    d0 = (d0 >> 4) & 6;
    let spd = u16(Math.abs(this.ground_vel));
    if (this.status_secondary & 0x80) spd = u16(spd * 2);
    let a1;
    if (spd >= 0x600) {
      a1 = this.animAddrs[1]; // AniSonic01 (run)
    } else {
      a1 = this.animAddrs[0]; // AniSonic00 (walk)
      d0 = (d0 * 2) & 0xff;
    }
    d0 = (d0 * 2) & 0xff;
    const d3 = d0;
    let f = r[a1 + 1 + this.anim_frame];
    if (f === 0xff) {
      this.anim_frame = 0;
      f = r[a1 + 1];
    }
    this.mapping_frame = (f + d3) & 0xff;
    this.anim_frame_timer = (this.anim_frame_timer - 1) & 0xff;
    if (!(this.anim_frame_timer & 0x80)) return;
    let t = s16(-spd + 0x800);
    if (t < 0) t = 0;
    this.anim_frame_timer = (t >> 8) & 0xff;
    this.anim_frame = (this.anim_frame + 1) & 0xff;
  }

  // loc_13786: rolling, frame time depends on speed
  _animRoll() {
    this.anim_frame_timer = (this.anim_frame_timer - 1) & 0xff;
    if (!(this.anim_frame_timer & 0x80)) return;
    const spd = u16(Math.abs(this.ground_vel));
    const a1 = spd >= 0x600 ? this.animAddrs[3] : this.animAddrs[2];
    let t = s16(-spd + 0x400);
    if (t < 0) t = 0;
    this.anim_frame_timer = (t >> 8) & 0xff;
    this.render_flags = (this.render_flags & 0xfc) | (this.status & 1);
    this._animStep(a1);
  }

  // loc_137CE: pushing
  _animPush() {
    this.anim_frame_timer = (this.anim_frame_timer - 1) & 0xff;
    if (!(this.anim_frame_timer & 0x80)) return;
    let t = s16(-u16(Math.abs(this.ground_vel)) + 0x800);
    if (t < 0) t = 0;
    this.anim_frame_timer = (t >> 6) & 0xff;
    this.render_flags = (this.render_flags & 0xfc) | (this.status & 1);
    this._animStep(this.animAddrs[4]);
  }

  // Anim_Tumble (flip_angle != 0, from twisting springs etc.)
  _animTumble() {
    const ft = this.flip_type & 0x7f;
    const left = this.status & 1;
    let d0 = this.flip_angle;
    const fwd = (v) => (((v + 0x0b) & 0xff) / 0x16) | 0;
    const rev = (v) => (((-v & 0xff) + 0x8f) & 0xff) / 0x16 | 0;
    let frame, rf;
    if (ft === 0) {
      if (!left) {
        if (this.flip_type & 0x80) { rf = 2; frame = rev(d0); } else { rf = 0; frame = fwd(d0); }
      } else { rf = 3; frame = rev(d0); }
      frame += 0x31;
    } else {
      const base = [0, 0x3d, 0x49, 0x49][ft] ?? 0x49;
      if (ft === 1) { rf = left ? 1 : 0; frame = (((d0 - 8) & 0xff) / 0x16 | 0) + base; }
      else if (ft === 2) {
        if (!left) { rf = 0; frame = fwd(d0) + base; } else { rf = 3; frame = rev(d0) + base; }
      } else if (!left) { rf = 2; frame = rev(d0) + base; } else { rf = 1; frame = fwd(d0) + base; }
    }
    this.render_flags = (this.render_flags & 0xfc) | rf;
    this.mapping_frame = frame & 0xff;
    this.anim_frame_timer = 0;
  }
}
