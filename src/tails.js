// Tails' player object, ported from Obj_Tails ($143B2) of the Sonic 3 (W) 68000 code (s3.asm).
// The Tails_* routines mirror Sonic's (player.js) with Tails' radii, speeds and animations, so
// `Tails extends Player` and only overrides what differs:
//   Tails_Init / Tails_Control / Tails_Modes (Tails_Stand_Path, Tails_Stand_Freespace,
//   Tails_Spin_Path, Tails_Spin_Freespace), Tails_FlyingSwimming / Tails_Move_FlySwim /
//   Tails_Set_Flying_Animation, Tails_Test_For_Flight, Tails_InputAcceleration_Path (balance),
//   Tails_RollSpeed, Tails_Roll, Tails_Spindash, Tails_SlopeResist, Tails_SlopeRepel,
//   Tails_TouchFloor, Tails_Water, Animate_Tails (AniTails), Tails_Load_PLC (DPLC into
//   ArtTile_Player_2), the death/respawn of the CPU sidekick (sub_13230 -> sub_14B58),
//   Tails_CPU_Control (routines 0-8: init, Tails_Catch_Up_Flying, Tails_FlySwim_Unknown, follow
//   via Pos_table/Stat_table 16 frames back, spindash when stuck), Tails_Carry_Sonic and the
//   separate tails object Obj_Tails_Tail (AniTails_Tail, Tails_Tail_Load_PLC into
//   ArtTile_Player_2_Tail).
// Shared code (Player_AnglePos, the collision helpers, Tails_DoLevelCollision == Sonic's,
// Tails_JumpAngle, the hurt routine, Anim_Tumble) is inherited unchanged.
//
// Player_mode: Tails is Player_1 in "Tails alone" (cpu = false) and Player_2 (cpu = true, the
// sidekick driven by Tails_CPU_Control, or by a second controller) in "Sonic & Tails".
// Not ported: Super Tails, the competition-mode object (Obj_Tails2P), the cutscene CPU routines
// $C-$22 (Tails carrying Sonic into CNZ1 / the ending), debug mode, wind tunnels.
import { Player, STATUS2 } from './player.js';
import { R } from './ram.js';
import { registerCharacter } from './characters.js';

const A = {
  Map_Tails: 0x143488,
  PLC_Tails: 0x144456,
  ArtUnc_Tails: 0x1200e0,
  Map_Tails_Tail: 0x144bb8,
  PLC_Tails_Tail: 0x144d74,
  ArtUnc_Tails_Tail: 0x136620,
  AniTails: 0x165aa,
  AniTails_Tail: 0x16c4e,
  Obj_Tails_Tail_AniSelection: 0x16c1c,
  AniRaw_Tails_Carry: 0x15190,
};
export const ART_TILE_PLAYER_2 = 0x6a0; // ArtTile_Player_2
export const ART_TILE_PLAYER_2_TAIL = 0x6b0; // ArtTile_Player_2_Tail
const ANI_TAILS_COUNT = 0x29;

const S_FACING = 1, S_INAIR = 2, S_ROLL = 4, S_ONOBJ = 8, S_ROLLJUMP = 0x10, S_PUSH = 0x20, S_UNDERWATER = 0x40;
const NORMAL_SPEEDS = [0x600, 0xc, 0x80]; // Tails_Init / Tails_Water (Max_speed_P2 ...)
const WATER_SPEEDS = [0x300, 6, 0x40];
const SPINDASH_SPEEDS = [0x800, 0x880, 0x900, 0x980, 0xa00, 0xa80, 0xb00, 0xb80, 0xc00]; // word_15DCE
const FLIGHT_TIME = (8 * 60) / 2; // double_jump_property

const s8 = (v) => (v << 24) >> 24;
const s16 = (v) => (v << 16) >> 16;
const u16 = (v) => v & 0xffff;

// Controller words like Ctrl_1 / Ctrl_2: held byte << 8 | pressed byte
// (bits: 0 up, 1 down, 2 left, 3 right, 4 B, 5 C, 6 A, 7 start).
const BTN = { up: 1, down: 2, left: 4, right: 8, b: 0x10, c: 0x20, a: 0x40, start: 0x80 };
const BTN_ABC = 0x70;
export function padByte(o) {
  let v = 0;
  if (o) for (const k in BTN) if (o[k]) v |= BTN[k];
  return v;
}
export function padWord(input) { return (padByte(input?.held) << 8) | padByte(input?.pressed); }

export class Tails extends Player {
  // game may be null (headless physics tests); cpu = Player_2 driven by Tails_CPU_Control
  constructor(rom, level, game = null, { cpu = false } = {}) {
    super(rom, level);
    this.game = game;
    this.cpu = cpu;
    this.character_id = 1;
    this.animAddrs = [];
    for (let i = 0; i < ANI_TAILS_COUNT; i++) this.animAddrs.push(A.AniTails + rom.u16(A.AniTails + i * 2));
    this.mappings = game ? game.maps(A.Map_Tails) : rom.mappings(A.Map_Tails);
    this.artTile = ART_TILE_PLAYER_2;
    this.priority = 0x100;
    this.lastDplcFrame = -1; // Player_prev_frame_P2
    // Tails_CPU_* variables
    this.cpuRoutine = 0; // Tails_CPU_routine
    this.idleTimer = 0; // Tails_CPU_idle_timer (a 2nd controller took over)
    this.flightTimer = 0; // Tails_CPU_flight_timer
    this.autoFlyTimer = 0; // Tails_CPU_auto_fly_timer
    this.autoJump = 0; // Tails_CPU_auto_jump_flag
    this.targetX = 0; // Tails_CPU_target_X / _Y
    this.targetY = 0;
    this.cpuInteract = null; // Tails_CPU_interact (code of the object stood on)
    this.starPostFlag = !!game?.checkpoint; // Tails_CPU_star_post_flag (Last_star_post_hit)
    this.carry = 0; // Flying_carrying_Sonic_flag
    this.carryCooldown = 0; // Flying_carrying_Sonic_flag+1
    this.carryXv = 0; // _unkF744
    this.carryYv = 0; // _unkF74C
    this.ctrlRaw = 0; // Ctrl_2 (or Ctrl_1 for Player_1)
    this.ctrl = 0; // Ctrl_2_logical
    this.tail = new TailsTail(this);
    // Player_1 in "Tails alone": SpawnLevelMainSprites_SpawnPlayers adds 4 to y_pos, and in
    // CNZ1 (loc_4E86) Tails_CPU_routine $20 flies him into the level
    if (!cpu) {
      this.y_pos += 4;
      if (game?.zone?.id === 0x300 && !game.checkpoint) this.cpuRoutine = 0x20;
    }
  }

  // Tails_Init (+ Tails_Init_Continued)
  _reset(x, y) {
    super._reset(x, y);
    this.y_radius = 0xf;
    this.x_radius = 9;
    this.default_y_radius = 0xf;
    this.default_x_radius = 9;
    [this.max_speed, this.acceleration, this.deceleration] = NORMAL_SPEEDS;
    this.double_jump_property = 0;
    this.character_id = 1;
  }

  get isSidekick() { return this.cpu; }
  get levelFrame() { return this.game?.ram ? this.game.ram.uw(R.Level_frame_counter) : this.frameCounter; }
  get onScreen() { return (this.render_flags & 0x80) !== 0; }
  get carrying() { return this.carry !== 0; }

  // Render_Sprites' on-screen bit for the last frame's camera (width/height_pixels $18)
  _updateOnScreen() {
    const g = this.game;
    if (!g) { this.render_flags |= 0x80; return; }
    this.render_flags &= 0x7f;
    const dx = s16(this.x_pos - (g.camX | 0));
    if (dx + 0x18 < 0 || dx - 0x18 >= 320) return;
    if (u16(this.y_pos - (g.camY | 0) + 0x18) >= 0x18 * 2 + 224) return;
    this.render_flags |= 0x80;
  }

  // ---------------------------------------------------------------- main loop
  update(input) {
    this._updateOnScreen();
    if (this.cpu) this._syncFromGame();
    this.ctrlRaw = padWord(input);
    this.ctrl = this.ctrlRaw; // Ctrl_x_logical (Ctrl_2_locked is never set here)
    this._applyCtrl();
    this.frameCounter = (this.frameCounter + 1) & 0xffff;
    switch (this.routine) {
      case 2: this._control(); break;
      case 4: this._releaseCarry(); this._hurtRoutine(); break; // loc_1620A
      case 6: this._releaseCarry(); this._deathRoutine(); break; // loc_162C4
      case 12: this._releaseCarry(); this._drownRoutine(); break; // loc_16324
      default: break;
    }
  }

  // the sidekick shares Player_1's camera bounds / camera Y and the water state
  _syncFromGame() {
    const g = this.game, p1 = g.player;
    if (p1.bounds) this.bounds = p1.bounds;
    if (p1.cameraY !== undefined) this.cameraY = p1.cameraY;
    if (!this.water && p1.water) this.water = p1.water;
  }

  _applyCtrl() {
    const h = this.ctrl >> 8, p = this.ctrl & 0xff;
    this.held = { up: !!(h & 1), down: !!(h & 2), left: !!(h & 4), right: !!(h & 8), jump: !!(h & BTN_ABC) };
    this.pressed = { up: !!(p & 1), down: !!(p & 2), left: !!(p & 4), right: !!(p & 8), jump: !!(p & BTN_ABC) };
  }

  // Tails_Control (routine 2)
  _control() {
    // loc_1456C: Ctrl_2_logical = Ctrl_2, then Tails_CPU_Control. Player_1 only runs the CPU
    // for the scripted routines >= $1A (loc_14544).
    if (this.cpu || this.cpuRoutine >= 0x1a) {
      this._cpuControl();
      this._applyCtrl();
    }
    // loc_14582
    if (this.object_control & 1) {
      this.double_jump_flag = 0;
      this._releaseCarry();
    } else {
      switch (this.status & 6) {
        case 0: this._mdNormal(); break;
        case 2: this._mdAir(); break;
        case 4: this._mdRoll(); break;
        case 6: this._mdJump(); break;
      }
    }
    // loc_145C4: vertical wrap (the camera does it for Player_1)
    if (this.cpu && this.game?.ram && this.game.ram.w(R.Camera_min_Y_pos) === -0x100) {
      this.y_pos = s16(this.y_pos & this.game.ram.uw(R.Screen_Y_wrap_value));
    }
    if (this.routine !== 2) this.visible = true;
    else this._display(); // Tails_Display (Sonic_RecordPos is Player_1 only: camera.js)
    this._water(); // Tails_Water
    this.next_tilt = this.primaryAngle;
    this.tilt = this.secondaryAngle;
    if (!(this.object_control & 2)) this._animate(); // Animate_Tails (Tails_Load_PLC: drawSelf)
    // TouchResponse: the game calls it for Player_1, the sidekick does it here
    if (this.cpu && this.routine === 2 && !(this.object_control & 0xa0)) this.game?.core?.touchResponse(this);
  }

  // Tails_Stand_Path
  _mdNormal() {
    this._releaseCarry();
    super._mdNormal();
  }

  // Tails_Stand_Freespace
  _mdAir() {
    if (this.double_jump_flag) return this._flyingSwimming();
    super._mdAir();
  }

  // Tails_Spin_Path
  _mdRoll() {
    this._releaseCarry();
    super._mdRoll();
  }

  // Tails_Spin_Freespace (no flight check)
  _mdJump() {
    this._releaseCarry();
    Player.prototype._mdAir.call(this);
  }

  // clr.w (Flying_carrying_Sonic_flag) after letting go of Player_1
  _releaseCarry() {
    if (!this.carry) return;
    const s = this.game?.player;
    if (s) { s.object_control = 0; s.status |= S_INAIR; }
    this.carry = 0;
    this.carryCooldown = 0;
  }

  // ---------------------------------------------------------------- flight
  // Tails_FlyingSwimming
  _flyingSwimming() {
    this._moveFlySwim();
    this._chgJumpDir(); // Tails_InputAcceleration_Freespace
    this._levelBound(); // Tails_Check_Screen_Boundaries
    if (this.routine !== 2) return;
    this._moveSprite2();
    this._jumpAngle();
    this._doLevelCollision();
    // Player_mode 0 ("Sonic & Tails"): Tails can pick Sonic up
    if (this.cpu && this.game) this._carrySonic(padWord(this.game.ctrl1));
  }

  // Tails_Move_FlySwim
  _moveFlySwim() {
    if ((this.levelFrame & 1) && this.double_jump_property) this.double_jump_property--;
    if (this.double_jump_flag !== 1) {
      // flapping upwards for $1F frames
      if (this.y_vel < -0x100) this.double_jump_flag = 1;
      else {
        this.y_vel = s16(this.y_vel - 0x20);
        this.double_jump_flag = (this.double_jump_flag + 1) & 0xff;
        if (this.double_jump_flag === 0x20) this.double_jump_flag = 1;
      }
    } else {
      // loc_15478
      if (this.pressed.jump && this.y_vel >= -0x100 && this.double_jump_property &&
        (!(this.status & S_UNDERWATER) || !this.carry)) this.double_jump_flag = 2;
      this.y_vel = s16(this.y_vel + 8);
    }
    // loc_154AA: can't fly above the top of the level
    if (!(s16(this.bounds.minY + 0x10) < this.y_pos) && this.y_vel < 0) this.y_vel = 0;
    this._setFlyingAnimation();
  }

  // Tails_Set_Flying_Animation
  _setFlyingAnimation() {
    if (this.status & S_UNDERWATER) {
      let d0 = this.y_vel < 0 ? 0x26 : 0x25; // swimming
      if (this.carry) d0 = 0x27;
      if (!this.double_jump_property) d0 = 0x28;
      this.anim = d0;
      return;
    }
    let d0 = this.y_vel < 0 ? 0x21 : 0x20;
    if (this.carry) d0 += 2;
    const tick = ((this.levelFrame + 8) & 0xf) === 0 && this.onScreen;
    if (!this.double_jump_property) {
      this.anim = 0x24; // tired
      if (tick) this.onSound?.('flytired'); // sfx_FlyTired
      return;
    }
    this.anim = d0;
    if (tick) this.onSound?.('fly'); // sfx_Flying
  }

  // Tails_Test_For_Flight (reached from Tails_JumpHeight where Sonic does his shield moves)
  _shieldMoves() {
    if (this.double_jump_flag) return;
    if (!this.pressed.jump) return;
    // Player_mode 2 ("Tails alone"), or the sidekick while a 2nd controller plays him
    if (this.cpu && !this.idleTimer) return;
    if (this.status & S_ROLL) {
      this.status &= ~S_ROLL;
      const d1 = this.y_radius;
      this.y_radius = this.default_y_radius;
      this.x_radius = this.default_x_radius;
      this._addY(s8(d1 - this.default_y_radius));
    }
    this.status &= ~S_ROLLJUMP;
    this.double_jump_flag = 1;
    this.double_jump_property = FLIGHT_TIME;
    this._setFlyingAnimation();
  }

  // ---------------------------------------------------------------- ground movement
  // Tails_InputAcceleration_Path's balance check (only one balance animation, different edges)
  _balance() {
    if (this.status & S_ONOBJ) {
      const o = this.interact;
      if (!o || (o.status & 0x80)) return this._lookUpDown();
      const d2 = o.width_pixels * 2 - 4;
      const d1 = s16(o.width_pixels + this.x_pos - o.x_pos);
      if (d1 < 4) { this.status |= S_FACING; this.anim = 6; return 0x1238c; } // loc_1569C
      if (d1 >= d2) { this.status &= ~S_FACING; this.anim = 6; return 0x1238c; } // loc_1568C
      return this._lookUpDown();
    }
    if (this._chkFloorEdge() < 0xc) return this._lookUpDown();
    if (this.next_tilt === 3) { this.status &= ~S_FACING; this.anim = 6; return 0x1238c; }
    if (this.tilt !== 3) return this._lookUpDown();
    this.status |= S_FACING;
    this.anim = 6;
    return 0x1238c;
  }

  // Tails_RollSpeed (deceleration / 4 when pushing against the roll)
  _rollSpeed() {
    const d5 = this.acceleration >> 1;
    const d4 = this.deceleration >> 2;
    if (!(this.spin_dash_flag & 0x80) && !(this.status_secondary & 0x80)) {
      if (this.move_lock === 0) {
        if (this.held.left) {
          // sub_159E0
          const gv = this.ground_vel;
          if (gv <= 0) { this.status |= S_FACING; this.anim = 2; }
          else this.ground_vel = u16(gv) < d4 ? -0x80 : gv - d4;
        }
        if (this.held.right) {
          // sub_15A04
          const gv = this.ground_vel;
          if (gv >= 0) { this.status &= ~S_FACING; this.anim = 2; }
          else this.ground_vel = u16(gv) + d4 > 0xffff ? 0x80 : gv + d4;
        }
      }
      // loc_15936
      const gv = this.ground_vel;
      if (gv > 0) this.ground_vel = u16(gv) < d5 ? 0 : gv - d5;
      else if (gv < 0) this.ground_vel = u16(gv) + d5 > 0xffff ? 0 : gv + d5;
      if (this.ground_vel === 0) {
        if (!this.spin_dash_flag) {
          this.status &= ~S_ROLL;
          const d0 = this.y_radius;
          this.y_radius = this.default_y_radius;
          this.x_radius = this.default_x_radius;
          this.anim = 5;
          this._addY(s8(d0 - this.default_y_radius));
        } else {
          this.ground_vel = this.status & S_FACING ? -0x400 : 0x400; // loc_1598C
        }
      }
    }
    // loc_1599E
    this._recenterCamera();
    const sin = this._sincos(this.angle);
    this.y_vel = s16(Math.imul(sin, this.ground_vel) >> 8);
    let d1 = s16(Math.imul(this._cos, this.ground_vel) >> 8);
    if (d1 > 0x1000) d1 = 0x1000;
    if (d1 < -0x1000) d1 = -0x1000;
    this.x_vel = d1;
    this._wallInFront();
  }

  // Tails_Roll -> loc_15B44 (Tails is 1 pixel taller than his rolling radius)
  _doRoll() {
    this.status |= S_ROLL;
    this.y_radius = 0xe;
    this.x_radius = 7;
    this.anim = 2;
    this._addY(1);
    this.onSound?.('roll');
    if (this.ground_vel === 0) this.ground_vel = 0x200;
  }

  // Tails_Spindash
  _spindash() {
    if (!this.spin_dash_flag) {
      if (this.anim !== 8) return false;
      if (!this.pressed.jump) return false;
      this.anim = 9;
      this.onSound?.('spindash', 0);
      this.spin_dash_flag = 1;
      this.spin_dash_counter = 0;
      this.spin_revs = 0;
      this._levelBound();
      if (this.routine === 2) this._anglePos();
      return true;
    }
    // loc_15D50
    if (!this.held.down) {
      this.y_radius = 0xe;
      this.x_radius = 7;
      this.anim = 2;
      this._addY(1);
      this.spin_dash_flag = 0;
      this.ground_vel = SPINDASH_SPEEDS[this.spin_dash_counter >> 8];
      // H_scroll_frame_offset (Player_1) / H_scroll_frame_offset_P2 (no second camera here)
      if (!this.cpu) this.scrollDelayRequest = { offset: (0x2000 - (((this.ground_vel - 0x800) * 2) & 0x1f00)) & 0xffff, resetPosTable: false };
      if (this.status & S_FACING) this.ground_vel = -this.ground_vel;
      this.status |= S_ROLL;
      this.onSound?.('release');
    } else {
      // loc_15DE0
      if (this.spin_dash_counter !== 0) this.spin_dash_counter -= this.spin_dash_counter >> 5;
      if (this.pressed.jump) {
        this.anim = 9;
        this.prev_anim = 0;
        this.onSound?.('spindash', ++this.spin_revs);
        this.spin_dash_counter += 0x200;
        if (this.spin_dash_counter >= 0x800) this.spin_dash_counter = 0x800;
      }
    }
    // loc_15E28
    this._recenterCamera();
    this._levelBound();
    if (this.routine === 2) this._anglePos();
    return true;
  }

  // Tails_SlopeResist (no slide down from standstill)
  _slopeResist() {
    if (((this.angle + 0x60) & 0xff) >= 0xc0) return;
    const d0 = Math.imul(this._sincos(this.angle), 0x20) >> 8;
    const gv = this.ground_vel;
    if (gv === 0) return;
    if (gv > 0 && d0 === 0) return;
    this.ground_vel = s16(gv + d0);
  }

  // Tails_SlopeRepel (falls off walls / ceilings when slower than $280)
  _slopeRepel() {
    if (this.stick_to_convex) return;
    if (this.move_lock !== 0) { this.move_lock--; return; }
    if (((this.angle + 0x20) & 0xc0) === 0) return;
    if (u16(Math.abs(this.ground_vel)) >= 0x280) return;
    this.ground_vel = 0;
    this.status |= S_INAIR;
    this.move_lock = 30;
  }

  // Tails_TouchFloor (loc_161CC): no bubble-shield bounce, flight ends
  _touchFloorFlags() {
    this.status &= ~(S_INAIR | S_PUSH | S_ROLLJUMP);
    this.jumping = 0;
    if (this.game?.core) this.game.core.chainBonus = 0; // Chain_bonus_counter
    this.flip_angle = 0;
    this.flip_type = 0;
    this.flips_remaining = 0;
    this.scroll_delay_counter = 0;
    this.double_jump_flag = 0;
  }

  // ---------------------------------------------------------------- water
  // Tails_Water
  _water() {
    const w = this.water;
    if (!w || !w.flag) return;
    if (s16(w.level) >= this.y_pos) {
      if (!(this.status & S_UNDERWATER)) return;
      this.status &= ~S_UNDERWATER;
      this.resetAirTimer();
      w.onWaterChange(this, false);
      [this.max_speed, this.acceleration, this.deceleration] = NORMAL_SPEEDS;
      if (this.routine !== 4 && ((this.cpu && this.cpuRoutine === 4) || !this.object_control) && this.y_vel >= -0x400) {
        this.y_vel = s16(this.y_vel << 1);
      }
      if (this.anim === 0x1c) return;
      if (this.y_vel === 0) return;
      w.splash(this);
      if (this.y_vel <= -0x1000) this.y_vel = -0x1000;
      this.onSound?.('splash');
      return;
    }
    if (this.status & S_UNDERWATER) return;
    this.status |= S_UNDERWATER;
    this.resetAirTimer();
    w.onWaterChange(this, true); // Breathing_bubbles(_P2): Obj_AirCountdown
    [this.max_speed, this.acceleration, this.deceleration] = WATER_SPEEDS;
    if (!(this.cpu && this.cpuRoutine === 4) && this.object_control) return;
    this.x_vel >>= 1;
    this.y_vel >>= 2;
    if (this.y_vel === 0) return;
    w.splash(this);
    this.onSound?.('splash');
  }

  resetAirTimer() {
    if (this.cpu) { this.air_left = 30; return; } // the level music belongs to Player_1
    super.resetAirTimer();
  }

  // ---------------------------------------------------------------- hurt / death
  // HurtCharacter: Player_2 keeps his rings (and the shared ring count)
  hurt(sourceX) {
    if (this.cpu) {
      const save = this.onRingLoss;
      this.onRingLoss = null;
      const s2 = this.status_secondary;
      try { return super.hurt(sourceX); } finally { this.onRingLoss = save; if (this.routine === 4) this.status_secondary = s2; }
    }
    return super.hurt(sourceX);
  }

  // loc_162C4 -> sub_13230: the CPU sidekick doesn't die, he flies back in (sub_14B58)
  _deathRoutine() {
    this.spin_dash_flag = 0;
    const camY = this.cameraY ?? this._deathCamY;
    if (s16(camY + 0x100) < this.y_pos) {
      if (this.cpu) {
        this.routine = 2;
        this._cpuRespawn();
      } else {
        this.routine = 8;
        this.dead = true;
      }
    }
    this._moveSprite();
    this._animate();
  }

  // ---------------------------------------------------------------- Animate_Tails
  _animate() { animateTails(this, this.animAddrs, this); }

  // ---------------------------------------------------------------- drawing
  // Tails_Load_PLC: copy the frame's tiles from ArtUnc_Tails into ArtTile_Player_2
  loadArt(vdp, frame) {
    if (frame === this.lastDplcFrame) return;
    this.lastDplcFrame = frame;
    performDPLC(this.rom, vdp, A.PLC_Tails, A.ArtUnc_Tails, ART_TILE_PLAYER_2, frame);
  }

  // Draw_Sprite for Tails (art + priority bit) followed by his tails object
  drawSelf(vdp, cx, cy) {
    const frame = this.mapping_frame | 0;
    this.loadArt(vdp, frame);
    if (this.visible !== false || this.dying) {
      const pieces = this.mappings[frame];
      if (pieces) vdp.addSprite(pieces, this.x_pos - cx, this.y_pos - cy, ART_TILE_PLAYER_2 | (this.highPriority ? 0x8000 : 0), this.flipX, this.flipY, this.priority);
    }
    this.tail.draw(vdp, cx, cy);
  }

  // Obj_Tails_Tail runs from its own slot after the level objects
  afterObjects() { this.tail.update(); }

  // ================================================================ Tails_CPU_Control
  _cpuControl() {
    if ((this.ctrlRaw >> 8) & 0x7f) this.idleTimer = 10 * 60; // a 2nd controller plays Tails
    const s = this.game.player;
    switch (this.cpuRoutine) {
      case 0: return this._cpuInit(); // loc_14722
      case 2: return this._cpuCatchUp(s); // Tails_Catch_Up_Flying
      case 4: return this._cpuFlyIn(s); // Tails_FlySwim_Unknown
      case 6: return this._cpuFollow(s); // loc_149E8
      case 8: return this._cpuSpindash(s); // loc_14BC6
      case 0xa: // locret_14C46: waiting for a level event (AIZ1 resize / ICZ1 intro)
        // The ICZ1 snowboard intro (not ported) sets routine 2 once Sonic passes x $3880.
        if (this.game.zone.id === 0x500 && s.x_pos >= 0x3880) this.cpuRoutine = 2;
        return;
      case 0x20: return this._cpuFlyIntoLevel(); // loc_14EE2
      case 0x22: return this._cpuFlyIntoLevel2(); // loc_14F0C
      default: return; // $C-$1E: carrying / cutscene routines (not ported)
    }
  }

  // loc_14EE2: "Tails alone" CNZ1 start, flying in from the left
  _cpuFlyIntoLevel() {
    this.double_jump_flag = 1;
    this.double_jump_property = FLIGHT_TIME;
    this.status = S_INAIR;
    this.x_vel = 0x100;
    this.y_vel = 0;
    this.ground_vel = 0;
    this.cpuRoutine = 0x22;
    this._cpuFlyIntoLevel2();
  }
  // loc_14F0C: tap right every 32 frames until he lands
  _cpuFlyIntoLevel2() {
    this.idleTimer = 0;
    this.ctrl = (this.levelFrame & 0x1f) ? 0 : 0x0808;
    if (this.status & S_INAIR) return;
    this.cpuRoutine = 6;
    this.object_control = 0;
    this.anim = 0;
    this.x_vel = 0;
    this.y_vel = 0;
    this.ground_vel = 0;
    this.status = S_INAIR;
    this.move_lock = 0;
    this.highPriority = false;
  }

  // loc_14722
  _cpuInit() {
    const z = this.game.zone.id;
    if (!this.starPostFlag) {
      if (z === 0x000 || z === 0x500) {
        // AIZ1 (after the plane intro) / ICZ1: hidden until a level event calls him in
        this._cpuRespawn();
        this.cpuRoutine = 0xa;
        this.object_control = 0x83;
        return;
      }
      if (z === 0x100 || z === 0x200 || z === 0x600) return this._cpuStart(); // loc_147C6
      // ($300: Tails carries Sonic into CNZ1, routine $C - not ported: start next to him)
    }
    // loc_147A8
    this.anim = 0;
    this.x_vel = 0;
    this.y_vel = 0;
    this.ground_vel = 0;
    this.status = 0;
    this._cpuStart();
  }
  // loc_147C6
  _cpuStart() {
    this.cpuRoutine = 6;
    this.object_control = 0;
    this.flightTimer = 0;
  }

  // sub_14B58: park Tails off-level, Tails_Catch_Up_Flying brings him back
  _cpuRespawn() {
    this.idleTimer = 0;
    this.flightTimer = 0;
    this.cpuRoutine = 2;
    this.object_control = 0x81;
    this.status = S_INAIR;
    this.x_pos = 0x7f00;
    this.y_pos = 0;
    this.double_jump_flag = 0;
  }

  // Pos_table / Stat_table entry 16 frames back. Sonic_RecordPos runs at the end of
  // Player_1's code in the original (index already advanced: -$44); here the camera records it
  // after the objects, so the same entry is at -$40 from the current index.
  _history() {
    const m = this.game.ram;
    const d3 = (m.uw(R.Pos_table_index) - 0x40) & 0xff;
    return {
      x: m.uw(R.Pos_table + d3), y: m.uw(R.Pos_table + d3 + 2),
      ctrl: m.uw(R.Stat_table + d3), status: m.ub(R.Stat_table + d3 + 2),
    };
  }

  // Tails_Catch_Up_Flying
  _cpuCatchUp(s) {
    if (!((this.ctrl >> 8) & (BTN_ABC | 0x80))) {
      if (this.levelFrame & 0x3f) return;
      if (s.object_control) return;
      if (s.status & 0x92) return;
    }
    // loc_14804
    this.cpuRoutine = 4;
    this.x_pos = s.x_pos;
    this.targetX = s.x_pos;
    this.targetY = s.y_pos;
    this.y_pos = s16(s.y_pos - 0xc0);
    this.highPriority = true;
    this.priority = 0x100;
    this.x_vel = 0;
    this.y_vel = 0;
    this.ground_vel = 0;
    this.flip_type = 0;
    this.double_jump_flag = 0;
    this.status = S_INAIR;
    this.air_left = 30;
    this.object_control = 0x81;
    this.flips_remaining = 0;
    this.flip_speed = 0;
    this.move_lock = 0;
    this.invulnerable_time = 0;
    this.invincibility_timer = 0;
    this.speed_shoes_timer = 0;
    this.status_tertiary = 0;
    this.scroll_delay_counter = 0;
    this.next_tilt = 0;
    this.tilt = 0;
    this.stick_to_convex = 0;
    this.spin_dash_flag = 0;
    this.spin_dash_counter = 0;
    this.jumping = 0;
    this.obj41 = 0;
    this.double_jump_property = FLIGHT_TIME;
    this._setFlyingAnimation();
  }

  // Tails_FlySwim_Unknown: fly towards where Sonic was 16 frames ago
  _cpuFlyIn(s) {
    if (!this.onScreen) {
      this.flightTimer++;
      if (this.flightTimer >= 5 * 60) {
        this.flightTimer = 0;
        this.cpuRoutine = 2;
        this.object_control = 0x81;
        this.status = S_INAIR;
        this.x_pos = 0;
        this.y_pos = 0;
        this.double_jump_property = FLIGHT_TIME;
        this._setFlyingAnimation();
        return;
      }
    } else {
      // loc_148E4
      this.double_jump_property = FLIGHT_TIME;
      this.status |= S_INAIR;
      this._setFlyingAnimation();
      this.flightTimer = 0;
    }
    // loc_148FA
    const h = this._history();
    this.targetX = h.x;
    this.targetY = h.y;
    this._setFlyingAnimation();
    let d0 = s16(this.x_pos - this.targetX);
    if (d0 !== 0) {
      let d2 = Math.abs(d0) >> 4;
      if (d2 >= 0xc) d2 = 0xc;
      let d1 = (s.x_vel >> 8) & 0xff; // move.b x_vel(a1) (high byte), neg.b if negative
      if (d1 & 0x80) d1 = -d1 & 0xff;
      d2 = (d2 & 0xff00) | ((d2 + d1) & 0xff);
      d2 += 1;
      if (d0 >= 0) {
        this.status |= S_FACING;
        if (!(u16(d2) < u16(d0))) { d2 = d0; d0 = 0; }
        d2 = -d2;
      } else {
        this.status &= ~S_FACING;
        d0 = -d0;
        if (!(u16(d2) < u16(d0))) { d2 = (d2 & 0xff00) | (d0 & 0xff); d0 = 0; }
      }
      this.x_pos = s16(this.x_pos + d2);
    }
    // loc_1496C
    const d1 = s16(this.y_pos - this.targetY);
    if (d1 !== 0) this.y_pos = s16(this.y_pos + (d1 > 0 ? -1 : 1));
    // loc_14980: arrived and Sonic wasn't in the air then
    if (h.status & 0x92) return;
    if (d0 | d1) return;
    this.cpuRoutine = 6;
    this.object_control = 0;
    this.anim = 0;
    this.x_vel = 0;
    this.y_vel = 0;
    this.ground_vel = 0;
    this.status = (this.status & S_UNDERWATER) | S_INAIR;
    this.move_lock = 0;
    this.highPriority = !!s.highPriority;
    this.top_solid_bit = s.top_solid_bit;
    this.lrb_solid_bit = s.lrb_solid_bit;
  }

  // sub_14B8A: off screen for 5 seconds (or standing on another object) -> fly back in
  _cpuOffscreenCheck() {
    if (this.onScreen) this.flightTimer = 0;
    else {
      const code = (o) => o?.constructor ?? null; // the object's code pointer
      if ((this.status & S_ONOBJ) && code(this.interact) !== this.cpuInteract) return this._cpuRespawn();
      if (++this.flightTimer >= 5 * 60) return this._cpuRespawn();
    }
    this.cpuInteract = this.interact?.constructor ?? null;
  }

  // loc_149E8: follow Sonic, copying his input from 16 frames ago
  _cpuFollow(s) {
    if (s.routine >= 6) {
      // Sonic died: fly off
      this.cpuRoutine = 4;
      this.spin_dash_flag = 0;
      this.spin_dash_counter = 0;
      this.object_control = 0x81;
      this.status = S_INAIR;
      this.anim = 0x20;
      return;
    }
    this._cpuOffscreenCheck();
    if (this.idleTimer || (this.object_control & 0x80) || (s.status_tertiary & 0x80)) {
      if (this.idleTimer) this.idleTimer--; // loc_14B4C
      return;
    }
    if (this.move_lock && this.ground_vel === 0) this.cpuRoutine = 8;
    // loc_14A44
    const h = this._history();
    let d2 = h.x;
    if (!(s.status & S_ONOBJ) && s.ground_vel < 0x400) d2 = u16(d2 - 0x20);
    const d3 = h.y;
    let d1 = h.ctrl;
    const d4 = h.status;
    let jump = false;
    if ((this.status & S_PUSH) && !(d4 & 0x20)) jump = true; // pushing, Sonic wasn't: jump
    else {
      d2 = s16(d2 - this.x_pos);
      if (d2 === 0) {
        // loc_14ADE: face the way Sonic faced
        this.status = (this.status & ~S_FACING) | (d4 & 1);
      } else if (d2 < 0) {
        d2 = -d2;
        if (d2 >= 0x30) d1 = (d1 & 0xf3f3) | 0x0404;
        if (this.ground_vel !== 0 && (this.status & S_FACING)) this.x_pos = s16(this.x_pos - 1);
      } else {
        if (d2 >= 0x30) d1 = (d1 & 0xf3f3) | 0x0808;
        if (this.ground_vel !== 0 && !(this.status & S_FACING)) this.x_pos = s16(this.x_pos + 1);
      }
      // loc_14AF2
      if (this.autoJump) {
        d1 |= BTN_ABC << 8;
        if (this.status & S_INAIR) { this.ctrl = d1; return; }
        this.autoJump = 0;
      }
      // loc_14B0A
      if ((this.levelFrame & 0xff) !== 0 && u16(d2) >= 0x40) { this.ctrl = d1; return; }
      const dy = s16(d3 - this.y_pos);
      if (dy >= 0 || -dy < 0x20) { this.ctrl = d1; return; }
      jump = true;
    }
    // loc_14B2A
    if (jump && !(this.levelFrame & 0x3f) && this.anim !== 8) {
      d1 |= (BTN_ABC << 8) | BTN_ABC;
      this.autoJump = 1;
    }
    this.ctrl = d1;
  }

  // loc_14BC6: stuck behind something (move_lock with no speed): spindash out
  _cpuSpindash(s) {
    this._cpuOffscreenCheck();
    if (this.idleTimer || this.move_lock) return;
    const f = this.levelFrame & 0xff;
    if (this.spin_dash_flag) {
      // loc_14C1A
      this.ctrl = 0x0202;
      if (!(f & 0x7f)) { this.ctrl = 0; this.cpuRoutine = 6; return; }
      if (!(f & 0x1f)) this.ctrl |= (BTN_ABC << 8) | BTN_ABC;
      return;
    }
    if (this.ground_vel !== 0) return;
    this.status &= ~S_FACING;
    if (u16(this.x_pos) >= u16(s.x_pos)) this.status |= S_FACING;
    this.ctrl = 0x0202; // hold down
    if (!(f & 0x7f)) { this.ctrl = 0; this.cpuRoutine = 6; return; } // loc_14C2A
    if (this.anim === 8) this.ctrl = ((BTN_ABC | 2) << 8) | BTN_ABC | 2;
  }

  // ---------------------------------------------------------------- Tails_Carry_Sonic
  // d0 = Ctrl_1 (Sonic's pad)
  _carrySonic(d0) {
    const s = this.game.player;
    if (this.carry) {
      // loc_150E0 (y_vel -$100) -> loc_150E6 (jumping 0) -> loc_150EC (object_control 0) -> loc_150F0
      const drop = (stage) => {
        if (stage <= 0) s.y_vel = -0x100;
        if (stage <= 1) s.jumping = 0;
        if (stage <= 2) s.object_control = 0;
        this.carry = 0;
        this.carryCooldown = 0x3c;
      };
      if (s.routine >= 4) return drop(2);
      if (!(s.status & S_INAIR)) return drop(0);
      if (s.x_vel !== this.carryXv) return drop(0);
      if (s.y_vel !== this.carryYv) return drop(1);
      if (s.object_control & 0x80) return drop(3);
      if (d0 & BTN_ABC) {
        // Sonic jumps off
        s.object_control = 0;
        this.carry = 0;
        this.carryCooldown = 0x12;
        if (d0 & 0x0f00) this.carryCooldown = 0x3c;
        if (d0 & 0x0400) s.x_vel = -0x200;
        if (d0 & 0x0800) s.x_vel = 0x200;
        s.y_vel = -0x380;
        s.status |= S_INAIR;
        s.jumping = 1;
        s.y_radius = 0xe;
        s.x_radius = 7;
        s.anim = 2;
        s.status |= S_ROLL;
        s.status &= ~S_ROLLJUMP;
        return;
      }
      // loc_150FA: Sonic hangs below Tails
      s.x_pos = this.x_pos;
      s.y_pos = s16(this.y_pos + 0x1c);
      const f = this.status & 1;
      s.render_flags = (s.render_flags & 0xfc) | f;
      s.status = (s.status & 0xfe) | f;
      s.anim_frame_timer = (s.anim_frame_timer - 1) & 0xff;
      if (s.anim_frame_timer & 0x80) {
        s.anim_frame_timer = 0xb;
        let fr = this.rom.u8[A.AniRaw_Tails_Carry + s.anim_frame];
        s.anim_frame = (s.anim_frame + 1) & 0xff;
        if (fr === 0xff) { s.anim_frame = 0; fr = this.rom.u8[A.AniRaw_Tails_Carry]; }
        s.mapping_frame = fr;
      }
      // loc_15166
      s.x_vel = this.x_vel;
      this.carryXv = this.x_vel;
      s.y_vel = this.y_vel;
      this.carryYv = this.y_vel;
      s._doLevelCollision();
      return;
    }
    // loc_151A2
    if (this.carryCooldown) {
      this.carryCooldown--;
      if (this.carryCooldown) return;
    }
    if (u16(s.x_pos - this.x_pos + 0x10) >= 0x20) return;
    if (u16(s.y_pos - this.y_pos - 0x20) >= 0x10) return;
    if (s.object_control || s.routine >= 4 || s.spin_dash_flag) return;
    this._grabSonic(s);
    this.onSound?.('grab'); // sfx_Grab
    this.carry = 1;
  }

  // sub_15202
  _grabSonic(s) {
    s.x_vel = 0;
    s.y_vel = 0;
    s.ground_vel = 0;
    s.angle = 0;
    s.flip_angle = 0;
    s.x_pos = this.x_pos;
    s.y_pos = s16(this.y_pos + 0x1c);
    s.anim = 0x22;
    s.prev_anim = 0;
    s.anim_frame_timer = 0;
    s.anim_frame = 0;
    s.object_control = 3;
    s.status |= S_INAIR;
    s.status &= ~S_ROLLJUMP;
    s.spin_dash_flag = 0;
    const f = this.status & 1;
    s.render_flags = (s.render_flags & 0xfc) | f;
    s.status = (s.status & 0xfe) | f;
    this.carryXv = this.x_vel;
    s.x_vel = this.x_vel;
    this.carryYv = this.y_vel;
    s.y_vel = this.y_vel;
  }
}

// ============================================================================ Animate_Tails
// Animate_Tails / Animate_Tails_Part2 for Tails (o = a0) and his tails object (a2 = Tails).
// scripts: absolute ROM addresses of the animation scripts.
function animateTails(o, scripts, a2) {
  const r = o.rom.u8;
  const d0 = o.anim;
  if (d0 !== o.prev_anim) {
    o.prev_anim = d0;
    o.anim_frame = 0;
    o.anim_frame_timer = 0;
    o.status &= ~S_PUSH;
  }
  const a1 = scripts[d0] ?? scripts[0];
  const first = r[a1];
  if (!(first & 0x80)) {
    o.render_flags = (o.render_flags & 0xfc) | (o.status & 1);
    o.anim_frame_timer = (o.anim_frame_timer - 1) & 0xff;
    if (!(o.anim_frame_timer & 0x80)) return;
    o.anim_frame_timer = first;
    return animStep(o, a1);
  }
  if (first === 0xff) return animWalk(o, scripts);
  // loc_164D0
  o.anim_frame_timer = (o.anim_frame_timer - 1) & 0xff;
  if (!(o.anim_frame_timer & 0x80)) return;
  if (first === 0xfe) {
    // rolling: frame time from the speed
    const d2 = u16(Math.abs(o.ground_vel));
    const s = d2 >= 0x600 ? scripts[3] : scripts[2];
    let t = s16(0x400 - d2);
    if (t < 0) t = 0;
    o.anim_frame_timer = (t >> 8) & 0xff;
    o.render_flags = (o.render_flags & 0xfc) | (o.status & 1);
    return animStep(o, s);
  }
  // loc_16556: frame set from the direction a2 is moving in (the tails while rolling)
  let a = o._arctan ? o._arctan(a2.x_vel, a2.y_vel) : a2._arctan(a2.x_vel, a2.y_vel);
  const d2 = o.status & 1;
  a = d2 ? (a + 0x80) & 0xff : ~a & 0xff;
  a = (a + 0x10) & 0xff;
  const d1 = a & 0x80 ? 3 : 0;
  o.render_flags = (o.render_flags & 0xfc) | (d1 ^ d2);
  const d3 = (a >> 3) & 0xc;
  o.anim_frame_timer = 3;
  animStep(o, a1);
  o.mapping_frame = (o.mapping_frame + d3) & 0xff;
}

// sub_163B8: next frame of a script ($FF restart, $FE back, $FD new anim)
function animStep(o, a1) {
  const r = o.rom.u8;
  let d1 = o.anim_frame;
  let d0 = r[a1 + 1 + d1];
  if (d0 >= 0xf0) {
    if (d0 === 0xff) {
      o.anim_frame = 0;
      d0 = r[a1 + 1];
    } else if (d0 === 0xfe) {
      const n = r[a1 + 2 + d1];
      o.anim_frame = (o.anim_frame - n) & 0xff;
      d1 = (d1 - n) & 0xff;
      d0 = r[a1 + 1 + d1];
    } else {
      if (d0 === 0xfd) o.anim = r[a1 + 2 + d1];
      return;
    }
  }
  o.mapping_frame = d0;
  o.anim_frame = (o.anim_frame + 1) & 0xff;
}

// loc_16402: walking / running (AniTails00 < $600 <= AniTails01 < $700 <= AniTails1F)
function animWalk(o, scripts) {
  const r = o.rom.u8;
  if ((o.flip_type & 0x80) || o.flip_angle) return o._animTumble(); // Anim_Tumble (shared)
  let d1 = 0;
  let d0 = o.angle;
  if (d0 !== 0 && !(d0 & 0x80)) d0 -= 1;
  const d2 = o.status & 1;
  if (!d2) d0 = ~d0;
  d0 = (d0 + 0x10) & 0xff;
  if (d0 & 0x80) d1 = 3;
  o.render_flags = (o.render_flags & 0xfc) | (d1 ^ d2);
  if (o.status & S_PUSH) {
    // loc_1651C: pushing
    o.anim_frame_timer = (o.anim_frame_timer - 1) & 0xff;
    if (!(o.anim_frame_timer & 0x80)) return;
    let t = s16(0x800 - u16(Math.abs(o.ground_vel)));
    if (t < 0) t = 0;
    o.anim_frame_timer = (t >> 6) & 0xff;
    o.render_flags = (o.render_flags & 0xfc) | (o.status & 1);
    return animStep(o, scripts[4]);
  }
  d0 = (d0 >> 4) & 6;
  let spd = u16(Math.abs(o.ground_vel));
  if (o.status_secondary & 0x80) spd = u16(spd * 2);
  let a1 = scripts[0], d3 = (d0 * 4) & 0xff;
  if (spd >= 0x600) {
    a1 = scripts[1];
    d3 = (d0 * 2) & 0xff;
    if (spd >= 0x700) { a1 = scripts[0x1f]; d3 = d0; }
  }
  let f = r[a1 + 1 + o.anim_frame];
  if (f === 0xff) {
    o.anim_frame = 0;
    f = r[a1 + 1];
  }
  o.mapping_frame = (f + d3) & 0xff;
  o.anim_frame_timer = (o.anim_frame_timer - 1) & 0xff;
  if (!(o.anim_frame_timer & 0x80)) return;
  let t = s16(0x800 - spd);
  if (t < 0) t = 0;
  o.anim_frame_timer = (t >> 8) & 0xff;
  o.anim_frame = (o.anim_frame + 1) & 0xff;
}

// Tails_Load_PLC / Tails_Tail_Load_PLC entries: count-1 in the top nibble, tile in the low 12 bits
function performDPLC(rom, vdp, table, art, artTile, frame) {
  const o = table + rom.u16(table + frame * 2);
  const n = rom.u16(o);
  let v = artTile * 32;
  for (let i = 0; i < n && i < 32; i++) {
    const w = rom.u16(o + 2 + i * 2);
    const count = (w >> 12) + 1;
    const src = art + (w & 0xfff) * 32;
    vdp.writeVram(v, rom.u8.subarray(src, src + count * 32));
    v += count * 32;
  }
}

// ============================================================================ Obj_Tails_Tail
// Tails' two tails: a separate sprite that copies Tails' position / status and picks its
// animation from Tails' (Obj_Tails_Tail_AniSelection).
export class TailsTail {
  constructor(parent) {
    this.parent = parent;
    this.rom = parent.rom;
    const rom = parent.rom;
    this.scripts = [];
    for (let i = 0; i < 13; i++) this.scripts.push(A.AniTails_Tail + rom.u16(A.AniTails_Tail + i * 2));
    this.mappings = parent.game ? parent.game.maps(A.Map_Tails_Tail) : rom.mappings(A.Map_Tails_Tail);
    this.angle = 0;
    this.status = 0;
    this.render_flags = 4;
    this.x_pos = 0;
    this.y_pos = 0;
    this.priority = 0x100;
    this.highPriority = false;
    this.anim = 0;
    this.prev_anim = 0;
    this.anim_frame = 0;
    this.anim_frame_timer = 0;
    this.mapping_frame = 0;
    this.ground_vel = 0;
    this.flip_type = 0;
    this.flip_angle = 0;
    this.status_secondary = 0;
    this.parentAnim = -1; // objoff_34
    this.lastDplcFrame = -1; // Player_prev_frame_P2_tail
  }

  // Obj_Tails_Tail_Main
  update() {
    const p = this.parent, rom = this.rom;
    this.angle = p.angle;
    this.status = p.status;
    this.x_pos = p.x_pos;
    this.y_pos = p.y_pos;
    this.priority = p.priority;
    this.highPriority = !!p.highPriority;
    let d0 = p.anim;
    if (p.status & S_PUSH) d0 = 4; // (WindTunnel_flag_P2 is never set)
    if (d0 !== this.parentAnim) {
      this.parentAnim = d0;
      this.anim = rom.u8[A.Obj_Tails_Tail_AniSelection + d0];
    }
    animateTails(this, this.scripts, p);
  }
  _arctan(x, y) { return this.parent._arctan(x, y); }

  draw(vdp, cx, cy) {
    const frame = this.mapping_frame | 0;
    if (frame !== this.lastDplcFrame) {
      this.lastDplcFrame = frame;
      performDPLC(this.rom, vdp, A.PLC_Tails_Tail, A.ArtUnc_Tails_Tail, ART_TILE_PLAYER_2_TAIL, frame);
    }
    const pieces = this.mappings[frame];
    if (pieces) vdp.addSprite(pieces, this.x_pos - cx, this.y_pos - cy, ART_TILE_PLAYER_2_TAIL | (this.highPriority ? 0x8000 : 0), !!(this.render_flags & 1), !!(this.render_flags & 2), this.priority);
  }
}

// "Tails alone": Tails is Player_1; "Sonic & Tails": the CPU sidekick (Player_2)
registerCharacter('tails', (rom, level, game) => new Tails(rom, level, game));
registerCharacter('tails-cpu', (rom, level, game) => new Tails(rom, level, game, { cpu: true }));

export { STATUS2 };
