// Angel Island Zone objects: badniks (Rhinobot, Bloominator, MonkeyDude, CaterKillerJr)
// and the AIZ gimmicks, ported from the original 68000 code (s3.asm). Labels in the
// comments are the original ones; loc_xxxxx / byte_xxxxx / word_xxxxx labels are real ROM
// addresses of this ROM. Mappings, animation scripts, DPLCs and data tables are read from
// the ROM at those addresses (named labels were located by scanning the referencing code).
//
// The badniks use the S3K "object framework" (SetUp_ObjAttributes, Obj_Wait, Animate_Raw*,
// CreateChild*, Find_SonicTails, Swing_UpAndDown...), ported in FwObj below.
// Only Player 1 is handled (no Tails / 2P), like the rest of the game.
//
// Known gaps: Obj_HiddenMonitor stays buried (the end signpost isn't ported); the AIZ2
// draw bridge / burning log bridge only move when _unkFAA2/3/9 are raised by the AIZ2 end
// boss and cutscene objects, which aren't ported (the flags live in core.aiz); vines treat
// the player as always on screen; AIZ1 hollow tree: the chunk swaps of AIZ1_ScreenEvent
// are ported (zones/aiz.js) but not its gradual AIZ_TreeReveal plane-A tile drawing.
import { Obj, P1_STANDING, P1_PUSHING, TOUCH_SIDE } from './objcore.js';
import { R } from './ram.js';
import { createObject } from './objects.js';

const S_FACING = 1, S_INAIR = 2, S_ROLL = 4, S_ONOBJ = 8, S_PUSH = 0x20;
const SS_FIRE = 0x10;

const s8 = (v) => (v << 24) >> 24;
const s16 = (v) => (v << 16) >> 16;
const u16 = (v) => v & 0xffff;
const u8 = (v) => v & 0xff;

const EMPTY_MAP = [[]]; // Map_Offscreen

// ---------------------------------------------------------------------------- ROM addresses
const MAP = {
  Rhinobot: 0x1615a8, Bloominator: 0x1616c0, MonkeyDude: 0x161776, CaterKillerJr: 0x161a18,
  Monitor: 0x1b958, Explosion: 0x1c38a, PathSwap: 0x1b372,
  AIZ1Tree: 0x1c3e8, AIZ1ZiplinePeg: 0x1c42a,
  RideVine: 0x209ba, // Map_AIZRideVine
  BreakableWall: 0x1fd52, // Map_AIZBreakableWall
  DisappearingFloor: 0x294b4, DisappearingFloor2: 0x294c0,
  CorkFloor: 0x29b60, CorkFloor2: 0x29bd4,
  FlippingBridge: 0x2a310,
  CollapsingLogBridge: 0x2a738, DrawBridgeFire: 0x2a75a,
  DrawBridge: 0x2ac20,
  FallingLog2: 0x2ae20, FallingLog: 0x2ae30, FallingLogSplash2: 0x2ae40, FallingLogSplash: 0x2aeb0,
  SpikedLog: 0x2b0f0,
  StillSprites: 0x2b3aa, AnimatedStillSprites: 0x2b6d4,
  Button: 0x2bcf0,
};
const ANI = {
  AnimatedStillSprites: 0x2b6c2, // Ani_AnimatedStillSprites
  DisappearingFloor: 0x29494, // Ani_AIZDisappearingFloor
};
// make_art_tile values
const ART = {
  AIZMisc2_2: 0x42e9, AIZMisc2_3: 0x62e9, AIZMisc2_2_hi: 0xc2e9,
  Level_2: 0x4001, // make_art_tile($001,2,0)
  SwingVine: 0x041b, SlideRope: 0x4324, FallingLog: 0x43cf,
  GrayButton: 0x0456, Monitors: 0x04c4, ExplosionHi: 0x85a0,
};

// sfx names understood by audio.js (others are silently ignored)
const SFX = { Blast: 'blast', Projectile: 'projectile', MissileThrow: 'projectile', Grab: 'grab', Roll: 'roll',
  Collapse: 'destroy', BridgeCollapse: 'destroy', FlipBridge: 'flipbridge', GlideLand: 'glideland',
  WaterfallSplash: 'splash', Switch: 'tick', BubbleAttack: 'bubble', GroundSlide: 'skid' };

// ---------------------------------------------------------------------------- shared state
// Variables the original keeps in RAM that the rest of this port doesn't have yet.
function aizState(core) {
  if (!core.aiz) {
    core.aiz = {
      slotBits: new Uint8Array(16), // Slotted_object_bits
      rngSeed: 0, // RNG_seed
      unkFAA2: 0, unkFAA3: 0, unkFAA9: 0, // set by the AIZ2 end boss / cutscene button (not ported)
      vineAngle: 0, // AIZ_vine_angle (ChangeRingFrame adds $180 every frame)
    };
    // ChangeRingFrame ends with addi.w #$180,(AIZ_vine_angle).w
    const crf = core.changeRingFrame.bind(core);
    core.changeRingFrame = () => { crf(); core.aiz.vineAngle = u16(core.aiz.vineAngle + 0x180); };
  }
  return core.aiz;
}

// Random_Number
function randomNumber(core) {
  const st = aizState(core);
  let d1 = st.rngSeed | 0;
  if (!d1) d1 = 0x2a6d365a;
  const d0 = d1;
  d1 = (d1 << 2) | 0;
  d1 = (d1 + d0) | 0;
  d1 = (d1 << 3) | 0;
  d1 = (d1 + d0) | 0;
  let w = d1 & 0xffff; // move.w d1,d0
  const hi = (d1 >>> 16) & 0xffff; // swap d1
  w = (w + hi) & 0xffff; // add.w d1,d0
  d1 = ((w << 16) | hi) | 0; // move.w d0,d1 ; swap d1
  st.rngSeed = d1;
  return w;
}

const levelFrameCounter = (game) => game.frameCount & 0xffff; // Level_frame_counter
const waterLevel = (game) => game.ram.uw(R.Water_level);
const waterEnteredCounter = (game) => (R.Water_entered_counter ? game.ram.ub(R.Water_entered_counter) : (game.player.water_entered_counter ?? 0) & 0xff);
const levelTrigger = (game, i) => game.ram.ub(R.Level_trigger_array + i);
const setLevelTrigger = (game, i, v) => game.ram.setB(R.Level_trigger_array + i, v);
const playerOnScreen = (p) => !p.dead; // tst.b render_flags(a1) (the player is always on screen here)
const parentGone = (p) => !p || !p.alive || (p.status & 0x80) !== 0;

// ============================================================================ FwObj
// Object framework routines (sonic3k "SetUp_ObjAttributes" family).
class FwObj extends Obj {
  constructor(game, d) {
    super(game, d);
    this.t2e = 0; // $2E word (Obj_Wait timer)
    this.raw = 0; // $30 raw animation script (ROM address)
    this.r34 = null; // $34 callback
    this.f38 = 0; // $38 flags
    this.parent3 = null;
    this.child_dx = 0;
    this.child_dy = 0;
    this.dplcLast = -1; // $3A for Perform_DPLC
    this.pendingDelete = false; // code pointer = Delete_Current_Sprite (runs next frame)
  }
  get rom() { return this.game.rom; }

  // Obj_WaitOffscreen: returns true while the object is waiting to come on screen
  waitOffscreen() {
    if (this.woDone) return false;
    if (!this.woInit) {
      this.woInit = true;
      this.mappings = EMPTY_MAP;
      this.render_flags |= 4;
      this.width_pixels = 0x20;
      this.height_pixels = 0x20;
    }
    // loc_53FFC
    if (this.render_flags & 0x80) { this.woDone = true; return true; } // loc_5402C
    if (this.outOfRange()) { this.unload(); return true; }
    this.display();
    return true;
  }
  // SetUp_ObjAttributes / 2 / 3
  setUp(a) { this.mappings = this.game.maps(this.rom.u32(a)); this.setUp2(a + 4); }
  setUp2(a) { this.art_tile = this.rom.u16(a); this.setUp3(a + 2); }
  setUp3(a) {
    const r = this.rom;
    this.priority = r.u16(a);
    this.width_pixels = r.u8[a + 2];
    this.height_pixels = r.u8[a + 3];
    this.mapping_frame = r.u8[a + 4];
    this.collision_flags = r.u8[a + 5];
    this.render_flags |= 4;
    this.routine = u8(this.routine + 2);
  }
  // SetUp_ObjAttributesSlotted; returns false (object destroyed) when no slot is free
  setUpSlotted(a) {
    const r = this.rom, st = aizState(this.core);
    let d1 = r.u16(a), d3 = r.u16(a + 2);
    const d4 = r.u16(a + 4), idx = r.u16(a + 6);
    let d5 = st.slotBits[idx], d0 = 0;
    if (d5) {
      for (;;) {
        const c = d5 & 1;
        d5 >>= 1;
        if (!c) break;
        d0++;
        d3 = u16(d3 + d4);
        if (--d1 < 0) { this.delete(); return false; } // no open slot: the object is cleared
      }
    }
    st.slotBits[idx] |= 1 << d0;
    this.rosBit = d0;
    this.rosAddr = idx;
    this.art_tile = d3;
    this.mappings = this.game.maps(r.u32(a + 8));
    this.priority = r.u16(a + 12);
    this.width_pixels = r.u8[a + 14];
    this.height_pixels = r.u8[a + 15];
    this.mapping_frame = r.u8[a + 16];
    this.collision_flags = r.u8[a + 17];
    this.status |= 4;
    this.dplcLast = -1;
    this.render_flags |= 4;
    this.routine = u8(this.routine + 2);
    return true;
  }
  // Remove_From_TrackingSlot
  removeFromSlot() {
    if (this.rosAddr === undefined) return;
    aizState(this.core).slotBits[this.rosAddr] &= ~(1 << this.rosBit);
  }
  // Touch_EnemyNormal frees the slot of "remember sprite state" objects
  onDestroyed() { if (this.status & 4) this.removeFromSlot(); }

  // Perform_DPLC (a2 = pointer pair: art, DPLC script)
  performDPLC(ptr) {
    const d0 = this.mapping_frame;
    if (d0 === this.dplcLast) return;
    this.dplcLast = d0;
    this.game.objectDPLC(this.rom.u32(ptr), this.rom.u32(ptr + 4), d0, this.art_tile);
  }
  // Obj_Wait
  objWait() {
    this.t2e = s16(this.t2e - 1);
    if (this.t2e < 0) this.r34();
  }
  // Animate_Raw / Animate_RawNoSST
  animateRaw(a1 = this.raw) {
    const m = this.rom.u8;
    this.anim_frame_timer = u8(this.anim_frame_timer - 1);
    if (!(this.anim_frame_timer & 0x80)) return;
    const d0 = u8(this.anim_frame + 1);
    this.anim_frame = d0;
    const d1 = m[a1 + 1 + d0];
    if (!(d1 & 0x80)) {
      this.anim_frame_timer = m[a1];
      this.mapping_frame = d1;
      return;
    }
    const cmd = u8(-d1); // 4 = $FC restart, 8 = $F8 jump, $C = $F4 custom code
    if (cmd === 8) { a1 += s8(m[a1 + 2 + d0]); this.raw = a1; }
    if (cmd === 4 || cmd === 8) {
      this.mapping_frame = m[a1 + 1];
      this.anim_frame_timer = m[a1];
    } else if (cmd === 0xc) {
      this.anim_frame_timer = 0;
      this.r34();
    }
    this.anim_frame = 0;
  }
  // Animate_RawMultiDelay / Animate_RawNoSSTMultiDelay: returns d2 (0 no change,
  // 1 new frame, -1 custom code ran); this.animCmd = a command byte was processed (Z set)
  animateRawMulti(a1 = this.raw) {
    const m = this.rom.u8;
    this.animCmd = false;
    this.anim_frame_timer = u8(this.anim_frame_timer - 1);
    if (!(this.anim_frame_timer & 0x80)) return 0;
    const d0 = u8(this.anim_frame + 2);
    this.anim_frame = d0;
    const d1 = m[a1 + d0];
    if (!(d1 & 0x80)) {
      this.mapping_frame = d1;
      this.anim_frame_timer = m[a1 + d0 + 1];
      return 1;
    }
    this.animCmd = true;
    const cmd = u8(-d1);
    let d2;
    if (cmd === 8) { a1 += s8(m[a1 + d0 + 1]); this.raw = a1; }
    if (cmd === 4 || cmd === 8) {
      this.mapping_frame = m[a1];
      this.anim_frame_timer = m[a1 + 1];
      d2 = 1;
    } else {
      this.anim_frame_timer = 0;
      this.r34();
      d2 = -1;
    }
    this.anim_frame = 0;
    return d2;
  }
  // Refresh_ChildPositionAdjusted
  refreshChildPositionAdjusted() {
    const a1 = this.parent3;
    let d1 = s8(this.child_dx);
    this.render_flags &= ~1;
    if (a1.render_flags & 1) { d1 = -d1; this.render_flags |= 1; }
    this.x_pos = s16(a1.x_pos + d1);
    let d2 = s8(this.child_dy);
    this.render_flags &= ~2;
    if (a1.render_flags & 2) { d2 = -d2; this.render_flags |= 2; }
    this.y_pos = s16(a1.y_pos + d2);
  }
  // Find_SonicTails (Player 1 only): d0 = 2 if the player is right of the object,
  // d1 = 2 if below, d2 = |dx|, d3 = |dy|
  findSonic() {
    const p = this.game.player;
    let d0 = 0, d1 = 0;
    let d2 = s16(this.x_pos - p.x_pos);
    if (d2 < 0) { d2 = -d2; d0 = 2; }
    let d3 = s16(this.y_pos - p.y_pos);
    if (d3 < 0) { d3 = -d3; d1 = 2; }
    return { d0, d1, d2: u16(d2), d3: u16(d3) };
  }
  // Go_Delete_Sprite: deleted next frame, children see status bit 7
  goDelete() { this.status |= 0x80; this.pendingDelete = true; }
  // Sprite_CheckDeleteTouch (loc_5371C sets status bit 7 for the children)
  checkDeleteTouch() {
    if (this.outOfRange()) { this.status |= 0x80; return this.unload(); }
    this.addTouch();
    this.display();
  }
  // Sprite_CheckDeleteTouchXY
  checkDeleteTouchXY() {
    if (this.outOfRange() || u16(this.y_pos - (this.game.camY | 0) + 0x80) > 0x200) { this.status |= 0x80; return this.delete(); }
    this.addTouch();
    this.display();
  }
  // Child_Draw_Sprite / Child_DrawTouch_Sprite
  childDraw(touch = false) {
    if (parentGone(this.parent3)) return this.goDelete();
    if (touch) this.addTouch();
    this.display();
  }
  // MoveSprite_LightGravity
  moveSpriteLightGravity() {
    this._x = (this._x + (this.x_vel << 8)) | 0;
    const yv = this.y_vel;
    this.y_vel = s16(yv + 0x20);
    this._y = (this._y + (yv << 8)) | 0;
  }
}

// Swing_UpAndDown ($40 acceleration, $3E maximum speed, $38 bit 0 direction); returns d3
function swingUpAndDown(o) {
  let d0 = o.v40, d1 = o.y_vel, d2 = o.v3e, d3 = 0;
  let down = (o.f38 & 1) !== 0;
  if (!down) {
    d0 = -d0;
    d1 = s16(d1 + d0);
    d2 = -d2;
    if (d1 > d2) { o.y_vel = d1; return 0; }
    o.f38 |= 1;
    d0 = -d0;
    d2 = -d2;
    d3 = 1;
  }
  // loc_52F90
  d1 = s16(d1 + d0);
  if (d1 < d2) { o.y_vel = d1; return d3; }
  o.f38 &= ~1;
  d0 = -d0;
  d1 = s16(d1 + d0);
  o.y_vel = d1;
  return 1;
}
// Swing_UpAndDown_Count: true when $39 runs out
function swingUpAndDownCount(o) {
  if (!swingUpAndDown(o)) return false;
  o.c39 = u8(o.c39 - 1);
  return (o.c39 & 0x80) !== 0;
}

// loc_54B46: projectile created with CreateChild2_Complex (object data in $3E, mover in $34)
class FwProjectile extends FwObj {
  constructor(game, parent, objDat, mover, dx, dy, xv, yv) {
    super(game, { x: s16(parent.x_pos + dx), y: s16(parent.y_pos + dy) });
    this.parent3 = parent;
    this.mappings = parent.mappings;
    this.art_tile = parent.art_tile;
    this.objDat = objDat;
    this.mover = mover;
    this.x_vel = xv;
    this.y_vel = yv;
    this.started = false;
  }
  update() {
    if (this.pendingDelete) return this.delete();
    if (!this.started) {
      // loc_54B46
      this.setUp(this.objDat);
      this.started = true;
      this.shield_reaction |= 8;
      return;
    }
    // loc_54B5A
    this.mover();
    this.checkDeleteTouchXY();
  }
}

// ============================================================================ Bloominator
const BLOOM = { ObjDat: 0x54c0e, ObjDat3: 0x54c1a, Anim: 0x54c3e };
class Bloominator extends FwObj {
  update() {
    if (this.pendingDelete) return this.delete();
    if (this.waitOffscreen()) return;
    switch (this.routine) {
      case 0: // loc_54B86
        this.setUp(BLOOM.ObjDat);
        this.t2e = 0x1f;
        this.r34 = () => this.loc_54BAA();
        break;
      case 2: // loc_54B9E
        if (this.render_flags & 0x80) this.objWait();
        break;
      default: this.loc_54BC2(); break;
    }
    this.checkDeleteTouch();
  }
  loc_54BAA() {
    this.routine = 4;
    this.raw = BLOOM.Anim;
    this.r34 = () => this.loc_54BF8();
  }
  loc_54BF8() {
    this.routine = 2;
    this.t2e = 2 * 60;
    this.r34 = () => this.loc_54BAA();
  }
  loc_54BC2() {
    const d2 = this.animateRawMulti();
    if (!d2 || this.animCmd) return;
    const d0 = this.anim_frame;
    if (d0 !== 6 && d0 !== 0xe) return;
    // loc_54BD4: fire a spike ball (ChildObjDat_54C26)
    this.game.sfx(SFX.Projectile);
    const c = new FwProjectile(this.game, this, BLOOM.ObjDat3, null, 0, -0x10, 0x100, -0x500);
    c.mover = () => c.moveSprite();
    this.core.spawn(c);
    this.c39 = u8((this.c39 ?? 0) + 1);
    if (this.c39 & 1) c.x_vel = s16(-c.x_vel);
  }
}

// ============================================================================ Rhinobot
const RHINO = { Slot: 0x54efa, SlotDust: 0x54f0c, DPLCPtr: 0x54f2e, Dust1: 0x54f36, Dust2: 0x54f46 };
class Rhinobot extends FwObj {
  update() {
    if (this.pendingDelete) { this.delete(); return this.removeFromSlot(); }
    if (this.waitOffscreen()) return;
    switch (this.routine) {
      case 0: if (!this.loc_54C7A()) return; break;
      case 2: this.loc_54CC0(); break;
      case 4: this.objWait(); break;
      case 6: this.loc_54CEA(); break;
    }
    this.performDPLC(RHINO.DPLCPtr);
    // Sprite_CheckDeleteTouchSlotted
    if (this.status & 0x80) { this.delete(); return this.removeFromSlot(); }
    if (this.outOfRange()) { this.status |= 0x80; this.unload(); return this.removeFromSlot(); }
    this.addTouch();
    this.display();
  }
  loc_54C7A() {
    if (!this.setUpSlotted(RHINO.Slot)) return false;
    this.x_radius = 8;
    this.y_radius = 0x10;
    let d0 = -0x10, d1 = -0x300;
    if (this.render_flags & 1) {
      d0 = -d0;
      d1 = -d1;
      this.f38 |= 8 | 4;
    }
    this.v40 = d0;
    this.v3e = d1;
    this.r34 = () => this.loc_54D3C();
    return true;
  }
  loc_54CC0() {
    if (this.sub_54EA0(() => this.loc_54D8E())) return;
    if (this.sub_54EC6(() => this.loc_54D70())) return;
    this.x_vel = s16(this.x_vel + this.v40);
    this.moveSprite2();
    this.sub_54DF4();
    this.loc_54E18();
  }
  loc_54CEA() {
    if (this.sub_54EC6(() => this.loc_54DE4())) return;
    this.moveSprite2();
  }
  loc_54D3C() {
    this.f38 ^= 4;
    this.r34 = () => this.loc_54D54();
    this.v40 = s16(-this.v40);
    this.v3e = s16(-this.v3e);
  }
  loc_54D54() {
    this.f38 ^= 8;
    this.render_flags ^= 1;
    this.f38 &= ~2;
    this.r34 = () => this.loc_54D3C();
  }
  loc_54D70() {
    this.f38 &= ~4;
    if (!(this.f38 & 8)) this.f38 |= 4;
    this.x_vel = 0;
    this.y_vel = 0;
    this.loc_54D54();
  }
  // charge at the player
  loc_54D8E() {
    this.routine = 4;
    this.mapping_frame = 0;
    this.t2e = 0x20;
    this.r34 = () => this.loc_54DCA();
    this.f38 |= 2;
    this.game.sfx(SFX.Blast);
    this.core.spawn(new RhinobotDust(this.game, this, 0x10, 8, RHINO.Dust2)); // ChildObjDat_54F26
  }
  loc_54DCA() {
    this.routine = 6;
    this.x_vel = this.f38 & 8 ? 0x400 : -0x400;
  }
  loc_54DE4() {
    this.routine = 2;
    this.mapping_frame = 0;
    this.loc_54D70();
  }
  sub_54DF4() {
    const d0 = this.x_vel;
    if (d0 !== 0) {
      if (this.f38 & 4) { if (d0 < this.v3e) return; } else if (d0 > this.v3e) return;
    }
    this.r34();
  }
  loc_54E18() {
    let d1 = 0;
    const xv = this.x_vel;
    let dust = false;
    if (this.f38 & 8) {
      if (this.f38 & 4) {
        if (!(xv > 0x80)) d1 = 1;
      } else {
        d1 = 1;
        if (!(xv > 0x280)) { d1 = 2; dust = !(this.f38 & 2); this.f38 |= 2; }
      }
    } else if (!(this.f38 & 4)) {
      if (!(xv <= -0x80)) d1 = 1;
    } else {
      d1 = 1;
      if (!(xv <= -0x280)) { d1 = 2; dust = !(this.f38 & 2); this.f38 |= 2; }
    }
    this.mapping_frame = d1;
    if (dust) { // loc_54E80
      this.game.sfx(SFX.Blast);
      this.core.spawn(new RhinobotDust(this.game, this, 0xc, 8, RHINO.Dust1)); // ChildObjDat_54F1E
    }
  }
  // sub_54EA0: player within $60 x $20 in front -> a3, abort the routine
  sub_54EA0(a3) {
    const { d0, d2, d3 } = this.findSonic();
    if (d3 > 0x20 || d2 > 0x60) return false;
    let e = d0;
    if (!(this.f38 & 8)) e -= 2;
    if (e === 0) return false;
    a3();
    return true;
  }
  // sub_54EC6: follow the floor 4 px ahead; a3 on a ledge or wall
  sub_54EC6(a3) {
    const d0 = this.f38 & 8 ? 4 : -4;
    const d1 = this.objCheckFloorDist(s16(this.x_pos + d0));
    if (d1 < -1 || d1 >= 0xc) { a3(); return true; }
    this.y_pos = s16(this.y_pos + d1);
    return false;
  }
}

// loc_54CF8: Rhinobot dust cloud (only in act 1)
class RhinobotDust extends FwObj {
  constructor(game, parent, dx, dy, raw) {
    super(game, { x: s16(parent.x_pos + dx), y: s16(parent.y_pos + dy) });
    this.parent3 = parent;
    this.mappings = parent.mappings;
    this.art_tile = parent.art_tile;
    this.child_dx = dx;
    this.child_dy = dy;
    this.raw = raw; // move.l #byte_54F36,$30(a1)
  }
  update() {
    if (this.pendingDelete) return this.delete();
    if (this.game.zone.id === 0x001) return this.delete(); // loc_54D22
    this.refreshChildPositionAdjusted();
    if (this.routine === 0) {
      if (!this.setUpSlotted(RHINO.SlotDust)) return;
      this.r34 = () => { this.pendingDelete = true; this.removeFromSlot(); }; // Go_Delete_SpriteSlotted3
    }
    this.animateRaw();
    this.performDPLC(RHINO.DPLCPtr);
    // Child_Remember_Draw_Sprite
    if (parentGone(this.parent3)) { this.removeFromSlot(); return this.goDelete(); }
    this.display();
  }
}

// ============================================================================ MonkeyDude
const MONKEY = { ObjDat: 0x55456, Arm: 0x55462, Coconut: 0x55470, Anim1: 0x554b0, Anim2: 0x554b4 };
class MonkeyDude extends FwObj {
  update() {
    if (this.pendingDelete) return this.delete();
    if (this.waitOffscreen()) return;
    switch (this.routine) {
      case 0: this.loc_54F6E(); break;
      case 2: this.animateRaw(); this.objWait(); break; // loc_53CD6
      default: this.loc_54FD6(); break;
    }
    this.checkDeleteTouch();
  }
  loc_54F6E() {
    this.setUp(MONKEY.ObjDat);
    const d0 = this.subtype >> 2;
    this.subtype = u8(d0);
    this.c39 = u8(d0 >> 1);
    this.raw = MONKEY.Anim1;
    this.t2e = 60 - 1;
    this.r34 = () => this.loc_54FBE();
    // CreateChild4_LinkListRepeated: 5 linked arm parts (loc_5504A, or loc_55044 when flipped)
    const flipped = (this.render_flags & 1) !== 0;
    let prev = this;
    for (let i = 0; i < 5; i++) {
      const c = new MonkeyArm(this.game, this, prev, i * 2, flipped);
      this.core.spawn(c);
      prev = c;
    }
  }
  loc_54FBE() {
    this.routine = 4;
    this.anim_frame = 0;
    this.anim_frame_timer = 0;
    this.raw = MONKEY.Anim2;
  }
  // climb up / down the tree
  loc_54FD6() {
    const d2 = this.animateRawMulti();
    if (!d2) return;
    if (this.f38 & 4) {
      if (this.mapping_frame !== 2) return;
      this.c39 = u8(this.c39 - 1);
      if (this.c39 === 0) return this.loc_55014();
      this.y_pos = s16(this.y_pos - 8);
      return;
    }
    if (this.mapping_frame !== 0) return;
    this.y_pos = s16(this.y_pos + 8);
    this.c39 = u8(this.c39 - 1);
    if (this.c39 === 1) this.loc_55014();
  }
  loc_55014() {
    this.routine = 2;
    this.c39 = this.subtype;
    this.f38 ^= 4;
    this.t2e = 60 - 1;
    this.raw = MONKEY.Anim1;
    this.mapping_frame = 0;
    this.anim_frame = 0;
    this.anim_frame_timer = 0;
  }
}

// loc_5504A / loc_55044: arm parts (subtype 0 = shoulder, 2..6 = arm, 8 = hand)
class MonkeyArm extends FwObj {
  constructor(game, monkey, parent, sub, flipped) {
    super(game, { x: monkey.x_pos, y: monkey.y_pos });
    this.parent3 = parent;
    this.subtype = sub;
    this.mappings = monkey.mappings;
    this.art_tile = monkey.art_tile;
    if (flipped) this.f38 |= 8;
    this.a3c = 0; // $3C angle
    this.code = 0;
  }
  update() {
    if (this.pendingDelete) return this.delete();
    switch (this.code) {
      case 0: return this.loc_5504A();
      case 1: return this.loc_550C8();
      case 2: return this.loc_55218();
      default: return this.loc_55248();
    }
  }
  loc_5504A() {
    this.setUp3(MONKEY.Arm);
    this.routine = 0;
    this.c3b = this.c3a = u8(this.subtype * 2);
    if (this.subtype === 0) {
      this.code = 1;
      const d0 = this.f38 & 8 ? 0xe : -0xe;
      this.x_pos = s16(this.x_pos + d0);
      this.y_pos = s16(this.y_pos - 2);
      this.c3e = this.y_pos;
    } else if (this.subtype !== 8) {
      this.code = 2;
    } else {
      this.code = 3;
      this.mapping_frame = 6;
      const a1 = this.parent3.parent3;
      this.p3e = a1;
      this.p44 = a1.parent3.parent3;
    }
    this.childDraw();
  }
  // shoulder: drives the arm angle
  loc_550C8() {
    // sub_552FC
    const m = this.parent3;
    let d0 = s16(m.y_pos - 2);
    if (m.mapping_frame) d0 = s16(d0 - 2);
    this.y_pos = d0;
    switch (this.routine) {
      case 0: this.loc_550EA(); break;
      case 2: this.loc_55126(); break;
      case 4: this.loc_5517E(); break;
      case 6: this.loc_551B0(); break;
      case 8: this.loc_551E6(); break;
      default: this.loc_5512C(); break;
    }
    this.childDraw();
  }
  loc_550EA() {
    let d0 = this.a3c;
    if (this.f38 & 8) {
      d0 = u8(d0 + 4);
      if (d0 >= 0x80) return this.loc_55112();
    } else {
      d0 = u8(d0 - 4);
      if (d0 <= 0x80) return this.loc_55112();
    }
    this.a3c = d0;
  }
  loc_55112() { this.routine = 2; this.loc_55118(); }
  loc_55118() { this.sub_55434(); this.r34 = () => this.sub_55434(); }
  loc_55126() {
    // sub_55320
    const { d0, d2 } = this.findSonic();
    if (d2 < 0x80) {
      let e = d0;
      if (this.f38 & 8) e -= 2;
      if (e === 0) { this.routine = 4; this.f38 |= 2; return; } // loc_55170
    }
    this.loc_5512C();
  }
  // idle: wave the arm randomly
  loc_5512C() {
    const d1 = s8(this.v40 & 0xff); // $41
    let d0 = this.addAngle(d1);
    let flip;
    if (this.f38 & 8) flip = u8(d0 - 0x20) >= 0x60;
    else flip = !(u8(d0 - 0x80) < 0x60);
    if (flip) {
      this.v40 = s16(-this.v40);
      this.addAngle(s8(this.v40 & 0xff));
    }
    this.objWait();
  }
  loc_5517E() {
    if (this.f38 & 8) {
      if (this.addAngle(4) >= 0xc0) this.loc_551A2();
    } else if (this.addAngle(-4) <= 0x40) this.loc_551A2();
  }
  loc_551A2() { this.routine = 6; this.f38 |= 4; }
  loc_551B0() {
    if (this.f38 & 8) {
      if (this.addAngle(-8) <= 0x60) this.loc_551D4(0x60);
    } else if (this.addAngle(8) >= 0xa0) this.loc_551D4(0xa0);
  }
  loc_551D4(d1) { this.routine = 8; this.a3c = d1; this.f38 &= ~2; }
  loc_551E6() {
    if (!(this.f38 & 8)) {
      if (this.addAngle(-2) <= 0x80) this.loc_5520A();
    } else if (this.addAngle(2) >= 0x80) this.loc_5520A();
  }
  loc_5520A() { this.routine = 0xa; this.a3c = 0x80; this.loc_55118(); }
  // sub_5533C
  addAngle(d1) { this.a3c = u8(this.a3c + d1); return this.a3c; }
  // sub_55434
  sub_55434() {
    const d0 = randomNumber(this.core);
    this.v40 = d0 & 1 ? -1 : 1;
    this.t2e = d0 & 0x3c;
  }
  // arm segments
  loc_55218() {
    this.priority = this.parent3.priority; // sub_55314
    switch (this.routine) {
      case 0: this.sub_55366(2); break;
      case 2: this.sub_5538E(4); break;
      default: break;
    }
    this.loc_55348();
    this.childDraw();
  }
  // hand
  loc_55248() {
    this.priority = this.parent3.priority;
    switch (this.routine) {
      case 0: this.sub_55366(2); break;
      case 2: this.sub_553B0(); this.sub_5538E(4); break;
      default: break;
    }
    this.loc_55348();
    this.childDraw();
  }
  loc_55348() {
    this.c3b = u8(this.c3b - 1);
    if (this.c3b === 0) {
      this.c3b = this.c3a;
      this.a3c = this.parent3.a3c;
    }
    // MoveSprite_CircularSimple (d2 = 5)
    const [sin, cos] = this.core.sincos(this.a3c);
    this.x_pos = s16(this.parent3.x_pos + (sin >> 5));
    this.y_pos = s16(this.parent3.y_pos + (cos >> 5));
  }
  sub_55366(d1) {
    if (!(this.parent3.f38 & 2)) return;
    this.routine = d1;
    this.f38 |= 2;
    this.c3a = u8(this.c3a >> 1);
    this.c3b = 1;
  }
  sub_5538E(d1) {
    if (this.parent3.f38 & 2) return;
    this.routine = d1;
    this.c3a = u8(this.c3a * 2);
    this.c3b = 1;
  }
  // throw a coconut when the arm swings forward
  sub_553B0() {
    if (this.f38 & 1) return;
    if (!(this.p44.f38 & 4)) return;
    if (this.f38 & 8) {
      if (!(this.p3e.a3c < 0x84)) return;
    } else {
      if (this.p3e.a3c < 0x7c) return;
      this.art_tile = 0x2548; // make_art_tile(ArtTile_MonkeyDude,1,0)
    }
    // loc_55406
    this.f38 |= 1;
    this.mapping_frame = 4;
    this.game.sfx(SFX.MissileThrow);
    const c = new FwProjectile(this.game, this, MONKEY.Coconut, null, 0, 0, -0x200, -0x400); // ChildObjDat_55498
    c.mover = () => c.moveSpriteLightGravity();
    this.core.spawn(c);
    if (this.f38 & 8) c.x_vel = s16(-c.x_vel);
  }
}

// ============================================================================ CaterKillerJr
const CATER = {
  ObjDat: 0x5565e, Body: [0x5566a, 0x5566a, 0x5566a, 0x55676, 0x55682, 0x55682],
  Delays: 0x555ce, Spark: 0x5568e, SparkAnim: 0x556a4, VelocityIndex: 0x53a1e,
};
// shared movement routines of the head and the body (loc_55524 / loc_55554 / loc_55576)
function caterMove(o) {
  switch (o.routine) {
    case 2: case 4: // loc_55524
      if (swingUpAndDownCount(o)) {
        // loc_55534
        o.routine = 6;
        o.v3e = o.y_vel = 0x100;
        o.v40 = 8;
        o.f38 &= ~1;
        return;
      }
      o.moveSprite2();
      return o.loc_5563A();
    case 6: // loc_55554
      if (swingUpAndDown(o)) {
        o.routine = 8;
        o.x_vel = s16(-o.x_vel);
        o.render_flags ^= 1;
      }
      o.moveSprite2();
      return o.loc_5563A();
    case 8: // loc_55576
      if (swingUpAndDown(o)) return caterLoc_554FE(o);
      o.moveSprite2();
      return o.loc_5563A();
    default: return undefined;
  }
}
// loc_554FE
function caterLoc_554FE(o) {
  o.routine = 4;
  o.c39 = 3;
  o.v3e = o.y_vel = 0x80;
  o.v40 = 8;
  o.f38 &= ~1;
}

class CaterKillerJr extends FwObj {
  update() {
    if (this.pendingDelete) return this.delete();
    if (this.waitOffscreen()) return;
    if (this.routine === 0) {
      // loc_554E8
      this.setUp(CATER.ObjDat);
      this.x_vel = -0x100;
      for (let i = 0; i < 6; i++) this.core.spawn(new CaterKillerBody(this.game, this, i * 2)); // CreateChild3_NormalRepeated
      caterLoc_554FE(this);
    } else caterMove(this);
    this.checkDeleteTouch();
  }
  loc_5563A() {}
}

// loc_55588: body segments (follow the head with a delay; the first three throw sparks)
class CaterKillerBody extends FwObj {
  constructor(game, parent, sub) {
    super(game, { x: parent.x_pos, y: parent.y_pos });
    this.parent3 = parent;
    this.subtype = sub;
    this.mappings = parent.mappings;
    this.art_tile = parent.art_tile;
    this.flicker = false;
  }
  update() {
    if (this.pendingDelete) return this.delete();
    if (this.flicker) return this.flickerMove();
    switch (this.routine) {
      case 0: { // loc_555A8
        const d0 = this.subtype;
        this.t2e = this.rom.u8[CATER.Delays + (d0 >> 1)]; // move.b ..,$2F(a0)
        this.setUp(CATER.Body[d0 >> 1]);
        break;
      }
      case 2: // loc_555D4
        this.t2e = s16(this.t2e - 1);
        if (this.t2e < 0) {
          this.routine = 4;
          this.t2e = 0x40 - (this.subtype + 2) * 4;
          this.r34 = () => this.loc_55650();
          this.x_vel = -0x100;
          caterLoc_554FE(this);
        }
        break;
      default: caterMove(this); break;
    }
    // Child_DrawTouch_Sprite_FlickerMove
    if (parentGone(this.parent3)) {
      this.status |= 0x80;
      this.flicker = true;
      this.collision_flags = 0;
      // Set_IndexedVelocity (d0 = 0)
      const a = CATER.VelocityIndex + this.subtype * 2;
      this.x_vel = this.rom.s16(a);
      this.y_vel = this.rom.s16(a + 2);
      if (this.render_flags & 1) this.x_vel = s16(-this.x_vel);
      return this.display();
    }
    this.addTouch();
    this.display();
  }
  loc_5563A() { if (this.subtype < 6) this.objWait(); }
  loc_55650() {
    this.t2e = 0x1a;
    this.core.spawn(new CaterKillerSpark(this.game, this)); // ChildObjDat_5569C
  }
  // Obj_FlickerMove
  flickerMove() {
    this.moveSprite();
    if (this.outOfRange() || u16(this.y_pos - (this.game.camY | 0) + 0x80) > 0x200) return this.delete();
    if (this.core.vintCount & 1) this.display();
  }
}

// loc_55606: spark thrown off a body segment
class CaterKillerSpark extends FwObj {
  constructor(game, parent) {
    super(game, { x: parent.x_pos, y: parent.y_pos });
    this.parent3 = parent;
    this.mappings = parent.mappings;
    this.art_tile = parent.art_tile;
    this.started = false;
  }
  update() {
    if (this.pendingDelete) return this.delete();
    if (!this.started) {
      this.started = true;
      this.setUp3(CATER.Spark);
      this.r34 = () => this.goDelete();
      this.shield_reaction |= 0x10;
      return this.childDraw();
    }
    // loc_55628
    this.refreshChildPositionAdjusted();
    this.animateRawMulti(CATER.SparkAnim);
    this.childDraw();
  }
}

// ============================================================================ simple sprites
// Obj_AIZ1Tree
class AIZ1Tree extends Obj {
  constructor(game, d) {
    super(game, d);
    this.mappings = game.maps(MAP.AIZ1Tree);
    this.priority = 0x180;
    this.width_pixels = 8;
    this.render_flags = 4;
    this.art_tile = ART.Level_2;
  }
  update() { this.spriteOnScreenTest(); }
}

// Obj_AIZ1ZiplinePeg
class AIZ1ZiplinePeg extends Obj {
  constructor(game, d) {
    super(game, d);
    this.mappings = game.maps(MAP.AIZ1ZiplinePeg);
    this.priority = 0x380;
    this.width_pixels = 0x20;
    this.render_flags = 4;
    this.art_tile = ART.SlideRope;
  }
  update() { this.spriteOnScreenTest(); }
}

// Obj_StillSprite (attributes from word_2B31A)
class StillSprite extends Obj {
  constructor(game, d) {
    super(game, d);
    const r = game.rom;
    this.mappings = game.maps(MAP.StillSprites);
    this.render_flags |= 4;
    this.mapping_frame = this.subtype;
    const a = 0x2b31a + this.subtype * 6;
    this.art_tile = r.u16(a);
    this.priority = r.u16(a + 2);
    this.width_pixels = r.u8[a + 4];
    this.height_pixels = r.u8[a + 5];
  }
  update() { this.spriteOnScreenTest(); }
}

// Obj_AnimatedStillSprite (attributes from word_2B6B6)
class AnimatedStillSprite extends Obj {
  constructor(game, d) {
    super(game, d);
    const r = game.rom;
    this.mappings = game.maps(MAP.AnimatedStillSprites);
    this.render_flags |= 4;
    this.anim = this.subtype;
    const a = 0x2b6b6 + this.subtype * 6;
    this.art_tile = r.u16(a);
    this.priority = r.u16(a + 2);
    this.width_pixels = r.u8[a + 4];
    this.height_pixels = r.u8[a + 5];
  }
  update() {
    this.animateSprite(ANI.AnimatedStillSprites); // loc_2B6A4
    this.spriteOnScreenTest();
  }
}

// Obj_HiddenMonitor: buried monitor, pops out when the end signpost lands next to it
class HiddenMonitor extends FwObj {
  constructor(game, d) {
    super(game, d);
    this.setUp(0x5239a); // ObjDat_HiddenMonitor
    this.y_radius = 0xf;
    this.x_radius = 0xf;
    this.collision_flags = 0x46;
    this.anim = this.subtype;
    this.idle = false;
  }
  update() {
    // Obj_HiddenMonitorMain (Signpost_addr: the end signpost isn't ported, so it stays hidden)
    const sp = this.game.signpost;
    if (!this.idle && sp && sp.alive && (sp.f38 & 1)) {
      const dx = u16(sp.x_pos - u16(this.x_pos - 0xe)), dy = u16(sp.y_pos - u16(this.y_pos - 0x80));
      if (dx < 0x1c && dy < 0xc0) {
        sp.f38 &= ~1;
        this.game.sfx(SFX.BubbleAttack);
        const m = createObject(this.game, { x: this.x_pos, y: this.y_pos, id: 1, subtype: this.subtype, respawn: this.respawn });
        if (m) { m.routine = 2; m.routine_secondary = 4; m.y_vel = -0x500; this.core.replace(this, m); m.spriteOnScreenTest(); return; }
      }
      this.game.sfx(SFX.GroundSlide);
      this.idle = true;
    }
    this.spriteOnScreenTest();
  }
}

// ============================================================================ AutoSpin
// Obj_AutoSpin: invisible line that makes the player roll (pinball mode) when crossed
const AUTOSPIN_SIZES = [0x20, 0x40, 0x80, 0x100]; // word_1C4B2
class AutoSpin extends Obj {
  constructor(game, d) {
    super(game, d);
    const p = game.player;
    this.mappings = game.maps(MAP.PathSwap);
    this.art_tile = 0x6bc;
    this.render_flags |= 4;
    this.width_pixels = 0x80;
    this.height_pixels = 0x80;
    this.priority = 0x280;
    const d0 = this.subtype;
    this.horizontal = (d0 & 4) !== 0; // loc_1C5FA: line crossed vertically
    if (this.horizontal) {
      this.mapping_frame = d0 & 7;
      this.size = AUTOSPIN_SIZES[d0 & 3];
      this.side = u16(this.y_pos) >= u16(p.y_pos) ? 0 : 1;
    } else {
      this.mapping_frame = d0 & 3;
      this.size = AUTOSPIN_SIZES[d0 & 3];
      this.side = u16(this.x_pos) >= u16(p.x_pos) ? 0 : 1;
    }
  }
  update() {
    const p = this.game.player;
    if (this.horizontal) this.sub_1C61E(p); else this.sub_1C518(p);
    this.deleteIfNotInRange();
  }
  inRange(v, c) { return u16(v) >= u16(c - this.size) && u16(v) < u16(c + this.size); }
  setSpin(p) { p.spin_dash_flag = this.subtype & 0x80 ? 0x81 : 1; }
  // sub_1C518 (vertical line)
  sub_1C518(p) {
    const d1 = u16(this.x_pos);
    if (!this.side) {
      if (d1 > u16(p.x_pos)) return;
      this.side = 1;
      if (!this.inRange(p.y_pos, this.y_pos)) return;
      if (this.render_flags & 1) { p.spin_dash_flag = 0; return; }
      p.ground_vel = 0x580;
      this.setSpin(p);
      return this.loc_1C5CA(p);
    }
    if (d1 <= u16(p.x_pos)) return;
    this.side = 0;
    if (!this.inRange(p.y_pos, this.y_pos)) return;
    if (!(this.render_flags & 1)) { p.spin_dash_flag = 0; return; }
    p.ground_vel = -0x580;
    this.setSpin(p);
    this.loc_1C5CA(p);
  }
  // sub_1C61E (horizontal line)
  sub_1C61E(p) {
    const d1 = u16(this.y_pos);
    if (!this.side) {
      if (d1 > u16(p.y_pos)) return;
      this.side = 1;
      if (!this.inRange(p.x_pos, this.x_pos)) return;
      if (this.render_flags & 1) { p.spin_dash_flag = 0; return; }
      this.setSpin(p);
      if (this.subtype & 0x40) {
        p.status &= ~S_INAIR;
        p.angle = 0x40;
        p.ground_vel = p.y_vel;
        p.x_vel = 0;
      }
      return this.loc_1C5CA(p);
    }
    if (d1 <= u16(p.y_pos)) return;
    this.side = 0;
    if (!this.inRange(p.x_pos, this.x_pos)) return;
    if (!(this.render_flags & 1)) { p.spin_dash_flag = 0; return; }
    this.setSpin(p);
    if (this.subtype & 0x40) {
      p.status &= ~S_INAIR;
      p.angle = 0x40;
    }
    this.loc_1C5CA(p);
  }
  loc_1C5CA(p) {
    if (p.status & S_ROLL) return;
    p.status |= S_ROLL;
    p.y_radius = 0xe;
    p.x_radius = 7;
    p.anim = 2;
    p.y_pos = s16(p.y_pos + 5);
    this.game.sfx(SFX.Roll);
  }
}

// ============================================================================ TwistedRamp
// Obj_TwistedRamp: launches the player into a corkscrew flip when run over fast enough
class TwistedRamp extends Obj {
  update() {
    this.sub_23CA2(this.game.player);
    if (this.outOfRange()) this.unload();
  }
  sub_23CA2(p) {
    if (p.status & S_INAIR) return;
    const a = u16(p.x_pos + 0x10);
    if (a < u16(this.x_pos)) return;
    if (s16(a - this.x_pos) >= 0x20) return;
    const dy = s16(p.y_pos - this.y_pos);
    if (dy < -0x14 || dy > 0x20) return;
    if (p.x_vel < 0x400) return;
    if (p.object_control) return;
    p.y_vel = -0x700;
    p.x_vel = s16(p.x_vel + 0x400);
    p.status |= S_INAIR;
    p.routine = 2;
    p.ground_vel = 1;
    p.flip_angle = 1;
    p.anim = 0;
    p.flips_remaining = 0;
    p.flip_speed = 4;
    if (p.status & S_FACING) {
      p.flip_angle = 0xff;
      p.ground_vel = -1;
    }
  }
}

// ============================================================================ breakable objects
// static-mapping fragment created by BreakObjectToPieces
class Fragment extends Obj {
  constructor(game, gravity) {
    super(game, {});
    this.gravity = gravity;
  }
  // loc_1F96E (gravity $70) / loc_29838 (gravity $18)
  update() {
    this.moveSprite2();
    this.y_vel = s16(this.y_vel + this.gravity);
    if (this.render_flags & 0x80) this.display();
    else this.delete();
  }
}

// BreakObjectToPieces: every piece of the current frame becomes an object (the first one
// replaces `o`); a4 = ROM table of x/y velocities. Returns the first fragment.
function breakObjectToPieces(o, a4, gravity) {
  const g = o.game, rom = g.rom, core = o.core;
  const pieces = o.mappings[o.mapping_frame] ?? [];
  let first = null;
  for (let k = 0; k < pieces.length; k++) {
    const f = new Fragment(g, gravity);
    f.pieces = [pieces[k]];
    f.render_flags = o.render_flags | 0x20;
    f._x = o._x & ~0xffff;
    f._y = o._y & ~0xffff;
    f.x_pos = o.x_pos;
    f.y_pos = o.y_pos;
    f.art_tile = o.art_tile | 0x8000;
    // move.b priority(a0),priority(a1): only the high byte is copied
    f.priority = k === 0 ? o.priority : o.priority & 0xff00;
    f.width_pixels = o.width_pixels;
    f.height_pixels = o.height_pixels;
    f.x_vel = rom.s16(a4 + k * 4);
    f.y_vel = rom.s16(a4 + k * 4 + 2);
    if (k === 0) { f._x = o._x; f._y = o._y; core.replace(o, f); first = f; } else core.spawn(f);
  }
  g.sfx(SFX.Collapse);
  return first;
}

// Obj_BreakableWall (AIZ variant): smashed by rolling into it at speed $480+ (or with the
// fire shield); subtype bit 7: removed by Level_trigger_array+0 instead
class BreakableWall extends Obj {
  constructor(game, d) {
    super(game, d);
    this.render_flags = 4;
    this.priority = 0x280;
    this.mapping_frame = this.subtype & 0xf;
    this.mappings = game.maps(MAP.BreakableWall);
    this.art_tile = ART.Level_2;
    this.width_pixels = 0x10;
    this.height_pixels = 0x28;
    this.t34 = 0x1fbe2; // word_1FBE2
    this.t38 = 0x1fc0a; // word_1FC0A
    this.init = true;
  }
  update() {
    const g = this.game, p = g.player, core = this.core;
    if (this.init) {
      this.init = false;
      if ((this.subtype & 0x80) && levelTrigger(g, 0)) return this.delete();
    }
    // loc_1F844
    const savedXv = p.x_vel; // $30
    const h = this.height_pixels;
    core.solidObjectFull(this, this.width_pixels + 0xb, h, h + 1, this.x_pos);
    if (this.subtype & 0x80) {
      if (levelTrigger(g, 0)) return this.delete();
      return this.spriteOnScreenTest();
    }
    const d6 = core.d6 & 3;
    if (d6 & TOUCH_SIDE) {
      const fire = (p.status_secondary & SS_FIRE) !== 0;
      if ((fire || (this.status & P1_PUSHING)) && p.anim === 2 && Math.abs(savedXv) >= 0x480) {
        // loc_1F8D0 -> sub_1F936
        this.status &= ~P1_PUSHING;
        p.x_vel = savedXv;
        p.x_pos = s16(p.x_pos + 4);
        let a4 = this.t34;
        if (!(u16(this.x_pos) < u16(p.x_pos))) {
          p.x_pos = s16(p.x_pos - 8);
          a4 = this.t38;
        }
        p.ground_vel = p.x_vel;
        p.status &= ~S_PUSH;
        this.mapping_frame++;
        const f = breakObjectToPieces(this, a4, 0x70);
        f?.update(); // loc_1F96E runs right away
        return;
      }
    }
    this.spriteOnScreenTest();
  }
}

// Obj_CorkFloor (AIZ variant): subtype 0 breaks when hit from below, otherwise when
// the player rolls onto it
class CorkFloor extends Obj {
  constructor(game, d) {
    super(game, d);
    this.render_flags = 4;
    this.priority = 0x280;
    this.mappings = game.maps(MAP.CorkFloor);
    this.art_tile = ART.Level_2;
    this.width_pixels = 0x10;
    this.height_pixels = 0x28;
    this.t3c = 0x29af0; // word_29AF0
    if (game.zone.id === 0x001) {
      this.mappings = game.maps(MAP.CorkFloor2);
      this.height_pixels = 0x2c;
    }
  }
  update() {
    return this.subtype ? this.loc_29742() : this.loc_29858();
  }
  solid() {
    const h = this.height_pixels;
    this.core.solidObjectFull(this, this.width_pixels + 0xb, h, h + 1, this.x_pos);
  }
  loc_29742() {
    const core = this.core, p = this.game.player;
    const chain = core.chainBonus; // $38
    const savedAnim = p.anim; // $34
    this.solid();
    if (!(this.status & P1_STANDING) || savedAnim !== 2) return this.spriteOnScreenTest();
    // sub_297CE
    p.status |= S_ROLL;
    p.y_radius = 0xe;
    p.x_radius = 7;
    p.anim = 2;
    p.y_vel = -0x300;
    p.status |= S_INAIR;
    p.status &= ~S_ONOBJ;
    p.routine = 2;
    // loc_29818
    core.chainBonus = chain;
    this.status &= 0xe7;
    this.smash();
  }
  loc_29858() {
    const core = this.core, p = this.game.player;
    const savedYv = p.y_vel; // $30
    this.solid();
    if (!(core.d6 & 4)) return this.spriteOnScreenTest();
    p.y_vel = savedYv;
    // loc_298CC
    if (this.status & P1_STANDING) {
      p.status |= S_INAIR;
      p.status &= ~S_ONOBJ;
    }
    this.smash();
  }
  smash() {
    this.mapping_frame++;
    const f = breakObjectToPieces(this, this.t3c, 0x18);
    f?.update(); // loc_29838
  }
}

// ============================================================================ AIZDisappearingFloor
// Obj_AIZDisappearingFloor: a water-wheel cover that opens/closes on a global timer;
// while it's fully open (frame 5) a solid child (loc_29450) is present
class AIZDisappearingFloor extends Obj {
  constructor(game, d) {
    super(game, d);
    const r = game.rom;
    const d1 = this.subtype;
    const d0 = d1 & 0xf;
    this.m32 = r.u16(0x29316 + d0 * 2); // word_29316
    let d2 = d0 - 3;
    if (d2 < 0) d2 = 0;
    this.m34 = u16(((d1 >> 4) & 0xf) << d2);
    this.mappings = game.maps(MAP.DisappearingFloor);
    this.art_tile = ART.Level_2;
    this.width_pixels = 0x20;
    this.height_pixels = 0x18;
    this.render_flags = 4;
    this.priority = 0x280;
    this.f36 = 0;
    let t = u16(levelFrameCounter(game) + this.m34) & this.m32;
    if (t !== 0 && t < 0xc8) {
      this.anim_frame_timer = u8(0xc8 - t);
      this.anim_frame = 0;
      this.anim = 2;
      this.prev_anim = 2;
      this.mapping_frame = 5;
    }
  }
  update() {
    // loc_293BA
    if ((u16(levelFrameCounter(this.game) + this.m34) & this.m32) === 0) {
      this.anim = 1;
      this.prev_anim = 0;
      this.f36 = 0;
      if (this.render_flags & 0x80) this.game.sfx(SFX.WaterfallSplash);
    }
    animateIrregular(this, ANI.DisappearingFloor);
    if (this.mapping_frame === 5 && !this.f36) {
      this.f36 = 1;
      const c = new DisappearingFloorSolid(this.game, this);
      this.core.spawn(c);
    }
    this.spriteOnScreenTest();
  }
}
// loc_29450
class DisappearingFloorSolid extends Obj {
  constructor(game, parent) {
    super(game, { x: parent.x_pos, y: parent.y_pos });
    this.mappings = game.maps(MAP.DisappearingFloor2);
    this.art_tile = ART.AIZMisc2_3;
    this.width_pixels = 0x28;
    this.height_pixels = 0x20;
    this.render_flags = 4;
    this.priority = 0x200;
    this.parent = parent;
  }
  update() {
    if (this.parent.mapping_frame === 3) this.x_pos = 0x7ff0;
    this.anim_frame_timer = u8(this.anim_frame_timer - 1);
    if (this.anim_frame_timer & 0x80) {
      this.anim_frame_timer = 3;
      this.mapping_frame = (this.mapping_frame + 1) & 3;
    }
    this.core.solidObjectFull(this, 0x2b, 0x18, 0x19, this.x_pos);
    this.spriteOnScreenTest();
  }
}

// Animate_SpriteIrregularDelay (per-frame delays)
function animateIrregular(o, a1) {
  const m = o.game.rom.u8, rom = o.game.rom;
  let d0 = o.anim;
  if (d0 !== o.prev_anim) {
    o.prev_anim = d0;
    o.anim_frame = 0;
    o.anim_frame_timer = 0;
  }
  const old = o.anim_frame_timer;
  o.anim_frame_timer = u8(old - 1);
  if (old !== 0) return;
  const s = a1 + rom.u16(a1 + d0 * 2);
  let d1 = o.anim_frame * 2;
  d0 = m[s + d1];
  if (d0 & 0x80) {
    if (d0 === 0xff) {
      o.anim_frame = 0;
      d0 = m[s];
    } else if (d0 === 0xfe) {
      const n = m[s + d1 + 1];
      o.anim_frame = u8(o.anim_frame - n);
      d1 = u8(d1 - n * 2);
      d0 = m[s + d1];
    } else if (d0 === 0xfd) {
      o.anim = m[s + d1 + 1];
      return;
    } else if (d0 === 0xfc) {
      o.routine = u8(o.routine + 2);
      o.anim_frame_timer = 0;
      o.anim_frame = u8(o.anim_frame + 1);
      return;
    } else return;
  }
  o.anim_frame_timer = m[s + d1 + 1];
  o.mapping_frame = d0;
  o.render_flags = (o.render_flags & 0xfc) | (o.status & 3);
  o.anim_frame = u8(o.anim_frame + 1);
}

// ============================================================================ multi-sprite objects
// render_flags bit 6: the main frame (if non-zero) plus mainspr_childsprites sub-sprites
class MultiSprite extends Obj {
  constructor(game, x, y) {
    super(game, { x, y });
    this.subs = []; // {x, y, frame}
  }
  update() { this.spriteOnScreenTest(); }
  draw(vdp, cx, cy) {
    const fx = !!(this.render_flags & 1), fy = !!(this.render_flags & 2);
    if (!(this.render_flags & 0x40)) return super.draw(vdp, cx, cy);
    if (this.mapping_frame) {
      const pc = this.mappings[this.mapping_frame];
      if (pc) vdp.addSprite(pc, this.x_pos - cx, this.y_pos - cy, this.art_tile, fx, fy, this.priority);
    }
    for (const s of this.subs) {
      const pc = this.mappings[s.frame & 0xff];
      if (pc) vdp.addSprite(pc, s.x - cx, s.y - cy, this.art_tile, fx, fy, this.priority);
    }
  }
}

// ============================================================================ AIZFlippingBridge
// Obj_AIZFlippingBridge: 8 planks rotating in a wave; only flat planks (frame >= 5) are solid
class AIZFlippingBridge extends Obj {
  constructor(game, d) {
    super(game, d);
    this.mappings = game.maps(MAP.FlippingBridge);
    this.art_tile = ART.AIZMisc2_2;
    this.width_pixels = 0x80;
    this.height_pixels = 4;
    this.render_flags = 4;
    this.priority = 0x200;
    this.y30 = this.y_pos;
    this.slope = this.subtype & 0x80 ? 0x2a1a6 : 0x2a126; // word_2A1A6 / word_2A126
    this.c37 = (this.subtype & 0xf) + 0x10;
    this.c25 = (this.subtype >> 4) & 7;
    let d1 = 1;
    if (this.status & 1) { d1 = -1; this.c37--; }
    this.c36 = d1;
    const c = new MultiSprite(game, this.x_pos, this.y_pos);
    c.mappings = this.mappings;
    c.art_tile = ART.AIZMisc2_2;
    c.render_flags = 4 | 0x40;
    c.width_pixels = 0x80;
    c.height_pixels = 0x40;
    c.priority = 0x200;
    let d2 = s16(this.y_pos + 0x20), d3 = s16(this.x_pos - 0x70), d4 = 8;
    if (this.subtype & 0x80) { d2 = s16(d2 - 0x10); d4 = 4; }
    let f = 0;
    for (let i = 0; i < 8; i++) {
      c.subs.push({ x: d3, y: d2, frame: f });
      f = (f + 2) & 0xf;
      d3 += 0x20;
      d2 -= d4;
    }
    this.child = c;
    game.core.spawn(c);
  }
  update() {
    this.sub_2A0B2(this.child);
    this.sub_2A23C(this.child);
    if (this.deleteIfNotInRange()) this.child.delete();
  }
  sub_2A0B2(a3) {
    this.anim_frame_timer = u8(this.anim_frame_timer - 1);
    if (!(this.anim_frame_timer & 0x80)) return;
    this.anim_frame_timer = this.c25;
    const d2 = this.c37, d1 = this.c36;
    for (const s of a3.subs) {
      if (d1 > 0) {
        s.frame = u8(s.frame + d1);
        if (!(d2 > s.frame)) s.frame = 0;
      } else {
        const c = s.frame + 0xff > 0xff;
        s.frame = u8(s.frame + 0xff);
        if (!c) s.frame = d2;
      }
    }
    if ((a3.render_flags & 0x80) && ((levelFrameCounter(this.game) + 3) & 7) === 0) this.game.sfx(SFX.GlideLand);
  }
  // sub_2A23C (d1 = width, a2 = slope, d4 = x)
  sub_2A23C(a3) {
    const p = this.game.player, core = this.core;
    const d1 = this.width_pixels;
    const frameAt = (d0) => a3.subs[(d0 >> 5) & 7].frame;
    if (this.status & P1_STANDING) {
      const d0 = s16(p.x_pos - this.x_pos + d1);
      if (!(p.status & S_INAIR) && d0 >= 0 && d0 < d1 * 2 && frameAt(d0) >= 5) {
        core.solidObjSloped2(this, d1, this.x_pos, this.game.rom.u8.subarray(this.slope, this.slope + 0x80));
        return;
      }
      // loc_2A25E
      p.status &= ~S_ONOBJ;
      p.status |= S_INAIR;
      this.status &= ~P1_STANDING;
      return;
    }
    // loc_2A292
    if (p.y_vel < 0) return;
    let d0 = s16(p.x_pos - this.x_pos + d1);
    if (d0 < 0 || d0 >= d1 * 2) return;
    if (this.render_flags & 1) d0 = u16(~d0 + d1 * 2);
    const d4 = d0;
    const d3 = this.game.rom.s8(this.slope + (d0 >> 1));
    const d2 = p.y_pos;
    const top = u16(this.y_pos - d3), bot = u16(d2 + s8(p.y_radius) + 4);
    if (top > bot) return; // bhi
    const e = s16(top - bot);
    if (u16(e) < 0xfff0) return;
    if (p.object_control) return;
    if (p.routine >= 6) return;
    if (frameAt(d4) < 5) return;
    p.y_pos = s16(d2 + e + 3);
    core.rideObjectSetRide(this);
  }
}

// ============================================================================ AIZCollapsingLogBridge
// Obj_AIZCollapsingLogBridge: the logs fall one after another once the player stands on it
// (subtype bit 7: the burning bridge, collapsed by the AIZ2 end boss via _unkFAA2)
class AIZCollapsingLogBridge extends Obj {
  constructor(game, d) {
    super(game, d);
    const fire = (this.subtype & 0x80) !== 0;
    this.fire = fire;
    this.c36 = this.subtype & 0x7f;
    this.c35 = u8(this.c36 + 0x30);
    this.c37 = 8;
    this.mappings = game.maps(fire ? MAP.DrawBridgeFire : MAP.CollapsingLogBridge);
    this.art_tile = fire ? ART.AIZMisc2_2_hi : ART.AIZMisc2_2;
    this.width_pixels = fire ? 0x60 : 0x5a;
    this.height_pixels = 8;
    this.render_flags = 4;
    this.priority = 0x200;
    const c = new MultiSprite(game, this.x_pos, this.y_pos);
    c.mappings = this.mappings;
    c.art_tile = this.art_tile;
    c.render_flags = 4 | 0x40;
    c.width_pixels = this.width_pixels;
    c.height_pixels = 8;
    c.priority = 0x200;
    let d3 = s16(this.x_pos - (fire ? 0x50 : 0x4b));
    for (let i = 0; i < 6; i++) {
      c.subs.push({ x: d3, y: this.y_pos, frame: i === 0 ? 1 : i === 5 ? 2 : 0 });
      d3 += fire ? 0x20 : 0x1e;
    }
    this.child = c;
    game.core.spawn(c);
    this.collapsing = false;
  }
  update() {
    if (this.collapsing) return this.loc_2A638();
    const start = this.fire ? aizState(this.core).unkFAA2 : (this.status & P1_STANDING);
    if (start) {
      this.c34 = this.c35;
      this.collapsing = true;
      this.sub_2A6C6(this.fire);
    }
    this.core.solidObjectTop(this, this.width_pixels, this.height_pixels, this.x_pos);
    if (this.deleteIfNotInRange()) this.child?.delete();
  }
  // sub_2A6C6: the multi-sprite becomes 6 falling logs (the first one in its own slot)
  sub_2A6C6(fire) {
    const a3 = this.child, g = this.game;
    let d2 = this.c36;
    a3.render_flags &= ~0x40;
    a3.subs.forEach((s, k) => {
      const l = new FallingBridgeLog(g);
      Object.assign(l, { mappings: a3.mappings, render_flags: a3.render_flags, art_tile: a3.art_tile, priority: a3.priority,
        width_pixels: a3.width_pixels, height_pixels: a3.height_pixels, mapping_frame: s.frame & 0xff, c34: u8(d2), fire });
      l.x_pos = s.x;
      l.y_pos = s.y;
      d2 += this.c37;
      if (k === 0) { this.core.replace(a3, l); this.child = l; } else this.core.spawn(l);
    });
    g.sfx(SFX.Collapse);
  }
  // loc_2A638
  loc_2A638() {
    this.c34 = u8(this.c34 - 1);
    if (this.c34 === 0) return this.loc_2AB1A();
    const d3 = this.c34, d1 = this.width_pixels, p = this.game.player;
    // sub_2A664
    if (this.status & P1_STANDING) {
      let release = true;
      const d2 = d1 * 2;
      let d0 = s16(p.x_pos - this.x_pos + d1);
      if (!(p.status & S_INAIR) && d0 >= 0 && d0 < d2) {
        if (this.status & 1) d0 = -d0 + d2;
        const seg = u8(((d0 >> 5) << 3) + this.c36);
        if (d3 > u8(this.c35 - seg)) release = false;
      }
      if (release) {
        this.status &= ~P1_STANDING;
        p.status &= ~(S_ONOBJ | S_PUSH);
        p.status |= S_INAIR;
        p.prev_anim = 1;
      }
    }
    this.deleteIfNotInRange();
  }
  // loc_2AB1A
  loc_2AB1A() {
    const p = this.game.player;
    if (this.status & P1_STANDING) {
      this.status &= ~P1_STANDING;
      p.status &= ~S_ONOBJ;
      p.status |= S_INAIR;
      p.anim = 0x1b;
    }
    this.delete();
  }
}

// loc_2A582 / loc_2A5EA: one falling log (burning variant animates frames 3..7)
class FallingBridgeLog extends Obj {
  update() {
    if (this.c34) {
      this.c34 = u8(this.c34 - 1);
      if (this.fire && this.c34 === 0) this.mapping_frame = 3;
      return this.display();
    }
    if (this.fire) {
      this.anim_frame_timer = u8(this.anim_frame_timer - 1);
      if (this.anim_frame_timer & 0x80) {
        this.anim_frame_timer = 3;
        this.mapping_frame++;
        if (this.mapping_frame >= 8) this.mapping_frame = 3;
      }
    }
    this.moveSprite();
    if (this.render_flags & 0x80) this.display();
    else this.delete();
  }
}

// ============================================================================ AIZDrawBridge
// Obj_AIZDrawBridge: raised bridge (a wall); lowered by _unkFAA3 (AIZ2 end boss), burnt by
// _unkFAA9. The two chain/plank multi-sprites follow the bridge angle ($38).
class AIZDrawBridge extends Obj {
  constructor(game, d) {
    super(game, d);
    this.mappings = game.maps(MAP.DrawBridge);
    this.art_tile = ART.AIZMisc2_2_hi;
    this.render_flags = 4;
    this.priority = 0x280;
    this.width_pixels = 8;
    this.height_pixels = 0x60;
    this.status |= 0x80;
    this.x30 = this.x_pos;
    this.y32 = this.y_pos;
    this.y_pos = s16(this.y_pos - 0x68);
    this.a38 = 0xc0;
    let d4 = -0x10;
    if (this.status & 2) {
      this.y_pos = s16(this.y_pos + 0xd0);
      this.a38 = 0x40;
      d4 = 0x10;
    }
    this.v34 = this.status & 1 ? -0x200 : 0x200;
    this.f36 = 0;
    const mk = (n) => {
      const c = new MultiSprite(game, 0, 0);
      c.mappings = this.mappings;
      c.art_tile = this.art_tile;
      c.priority = this.priority;
      c.render_flags = 4 | 0x40;
      c.width_pixels = 0x40;
      c.height_pixels = 0x40;
      for (let i = 0; i < n; i++) c.subs.push({ x: 0, y: 0, frame: 1 });
      c.update = () => c.display(); // loc_2AA48
      return c;
    };
    let d3 = this.y32;
    const c1 = mk(8);
    for (const s of c1.subs) { d3 += d4; s.x = this.x30; s.y = d3; }
    c1.x_pos = c1.subs[4].x; // $30(a1) = sub6_x_pos
    c1.y_pos = c1.subs[4].y;
    const c2 = mk(4);
    for (const s of c2.subs) { d3 += d4; s.x = this.x30; s.y = d3; }
    c2.x_pos = c2.subs[0].x;
    c2.y_pos = c2.subs[0].y;
    this.c3c = c1;
    this.c3e = c2;
    game.core.spawn(c1);
    game.core.spawn(c2);
    this.mode = 0;
  }
  update() {
    const st = aizState(this.core);
    if (this.mode === 0) {
      // loc_2A934
      if (st.unkFAA3 && !this.f36) {
        this.f36 = 1;
        this.game.sfx(SFX.FlipBridge);
        this.x_pos = s16(this.x30 + (this.status & 1 ? -0x68 : 0x68));
        this.y_pos = this.y32;
        this.width_pixels = 0x60;
        this.height_pixels = 8;
      }
      if (this.f36) {
        if (this.a38 === 0 || this.a38 === 0x80) {
          this.f36 = 0;
          this.game.sfx(SFX.FlipBridge);
          this.mode = 1;
        } else this.a38 = u8(this.a38 + (this.v34 >> 8));
      }
      this.sub_2AA4E();
    } else if (this.mode === 1) {
      // loc_2A9B0
      if (st.unkFAA9) {
        this.mode = 2;
        this.c34 = 0xe;
        return this.loc_2AB60();
      }
    } else return this.loc_2AB1A();
    this.loc_2A9CC();
  }
  loc_2A9CC() {
    let d1 = 0x13, d2 = 0x60, d3 = 0x61;
    const d0 = this.a38;
    if (!(d0 === 0x40 || d0 === 0xc0)) { d1 = 0x6b; d2 = 8; d3 = 8; }
    this.core.solidObjectFull2(this, d1, d2, d3, this.x_pos);
    if (this.outOfRange(this.x30)) {
      this.c3c?.delete();
      this.c3e?.delete();
      return this.unload();
    }
    this.display();
  }
  // sub_2AA4E: lay the planks along the bridge angle
  sub_2AA4E() {
    if (!this.f36) return;
    const [sin, cos] = this.core.sincos(this.a38);
    const d0 = (sin << 16) >> 4, d1 = (cos << 16) >> 4;
    let d4 = d0, d5 = d1;
    const d2 = this.y32, d3 = this.x30;
    for (const c of [this.c3c, this.c3e]) {
      for (const s of c.subs) {
        s.x = s16((d5 >> 16) + d3);
        s.y = s16((d4 >> 16) + d2);
        d4 = (d4 + d0) | 0;
        d5 = (d5 + d1) | 0;
      }
    }
    this.c3c.x_pos = this.c3c.subs[4].x; this.c3c.y_pos = this.c3c.subs[4].y;
    this.c3e.x_pos = this.c3e.subs[0].x; this.c3e.y_pos = this.c3e.subs[0].y;
  }
  // loc_2AB60 / sub_2AB76: the planks fall with explosions
  loc_2AB60() {
    const g = this.game;
    for (const a3 of [this.c3c, this.c3e]) {
      if (!a3) continue;
      a3.render_flags &= ~0x40;
      const subs = a3.subs;
      subs.forEach((s, i) => {
        const delay = g.rom.u8[0x2ac10 + i]; // byte_2AC10 (a4 restarts for each chain)
        const l = new FallingBridgeLog(g);
        Object.assign(l, { mappings: a3.mappings, render_flags: a3.render_flags, art_tile: a3.art_tile, priority: a3.priority,
          width_pixels: a3.width_pixels, height_pixels: a3.height_pixels, mapping_frame: s.frame, c34: delay, fire: false });
        l.x_pos = s.x;
        l.y_pos = s.y;
        if (i === 0) this.core.replace(a3, l); else this.core.spawn(l);
        this.core.spawn(new DelayedExplosion(g, s.x, s.y, delay)); // loc_1C31E
      });
    }
    g.sfx(SFX.BridgeCollapse);
  }
  loc_2AB1A() {
    if (this.c34) { this.c34 = u8(this.c34 - 1); return; }
    const p = this.game.player;
    if (this.status & P1_STANDING) {
      this.status &= ~P1_STANDING;
      p.status &= ~S_ONOBJ;
      p.status |= S_INAIR;
      p.anim = 0x1b;
    }
    this.delete();
  }
}

// loc_1C31E: explosion puff that starts after a delay
class DelayedExplosion extends Obj {
  constructor(game, x, y, delay) {
    super(game, { x, y });
    this.mappings = game.maps(MAP.Explosion);
    this.art_tile = ART.ExplosionHi;
    this.render_flags = 4;
    this.priority = 0x100;
    this.width_pixels = 0xc;
    this.height_pixels = 0xc;
    this.anim_frame_timer = delay;
    this.started = false;
  }
  update() {
    if (!this.started) {
      this.anim_frame_timer = u8(this.anim_frame_timer - 1);
      if (!(this.anim_frame_timer & 0x80)) return;
      this.anim_frame_timer = 3;
      this.started = true;
    }
    this.moveSprite2();
    this.anim_frame_timer = u8(this.anim_frame_timer - 1);
    if (this.anim_frame_timer & 0x80) {
      this.anim_frame_timer = 7;
      if (++this.mapping_frame === 5) return this.delete();
    }
    this.display();
  }
}

// ============================================================================ AIZFallingLog
// Obj_AIZFallingLog: invisible spawner dropping logs down a waterfall every ($32+1) frames
class AIZFallingLog extends Obj {
  constructor(game, d) {
    super(game, d);
    this.killed = (this.x_pos === 0x26b0 || this.x_pos === 0x2700) && levelTrigger(game, 0);
    const d1 = this.subtype, d0 = d1 & 0xf;
    this.m32 = game.rom.u16(0x2ac2e + d0 * 2); // word_2AC2E
    let d2 = d0 - 3;
    if (d2 < 0) d2 = 0;
    this.m34 = u16(((d1 >> 4) & 0xf) << d2);
    this.render_flags = 4;
  }
  update() {
    if (this.killed) return this.delete();
    const g = this.game;
    if ((u16(levelFrameCounter(g) + this.m34) & this.m32) === 0) {
      const act1 = g.zone.act === 1;
      const log = new FallingLogPiece(g, this.x_pos, this.y_pos);
      log.mappings = g.maps(act1 ? MAP.FallingLog : MAP.FallingLog2);
      log.art_tile = act1 ? ART.FallingLog : ART.AIZMisc2_2;
      log.width_pixels = 0x18;
      log.height_pixels = 8;
      log.render_flags = 4;
      log.priority = 0x280;
      const sp = new FallingLogSplash(g, log);
      sp.mappings = g.maps(act1 ? MAP.FallingLogSplash : MAP.FallingLogSplash2);
      sp.art_tile = act1 ? ART.FallingLog : ART.AIZMisc2_3;
      log.splash = sp;
      this.core.spawn(log);
      this.core.spawn(sp);
    }
    this.deleteIfNotInRange();
  }
}
// loc_2AD68 / loc_2AD84
class FallingLogPiece extends Obj {
  constructor(game, x, y) { super(game, { x, y }); this.sinking = false; this.f36 = 0; }
  update() {
    if (!this.sinking) {
      this.y_pos = s16(this.y_pos + 1);
      if (!(u16(this.y_pos) < waterLevel(this.game))) {
        this.sinking = true;
        this.anim_frame_timer = 60 - 1;
      }
    } else {
      this.anim_frame_timer = u8(this.anim_frame_timer - 1);
      if (this.anim_frame_timer & 0x80) this.x_pos = 0x7ff0;
      if (!(this.anim_frame_timer & 3)) this.f36 ^= 1;
    }
    // loc_2ADA0
    this.core.solidObjectTop(this, this.width_pixels, 8, this.x_pos);
    if (this.outOfRange()) {
      this.splash?.delete();
      return this.unload();
    }
    if (!this.f36) this.display();
  }
}
// loc_2ADF4
class FallingLogSplash extends Obj {
  constructor(game, log) {
    super(game, { x: log.x_pos, y: log.y_pos });
    this.log = log;
    this.width_pixels = 0x20;
    this.height_pixels = 0x10;
    this.render_flags = 4;
    this.priority = 0x200;
  }
  update() {
    this.x_pos = this.log.x_pos;
    this.y_pos = this.log.y_pos;
    this.anim_frame_timer = u8(this.anim_frame_timer - 1);
    if (this.anim_frame_timer & 0x80) {
      this.anim_frame_timer = 3;
      this.mapping_frame = (this.mapping_frame + 1) & 3;
    }
    this.display();
  }
}

// ============================================================================ AIZSpikedLog
// Obj_AIZSpikedLog: floating log that spins (spikes up) while stood on / when splashed
class AIZSpikedLog extends Obj {
  constructor(game, d) {
    super(game, d);
    this.mappings = game.maps(MAP.SpikedLog);
    this.art_tile = ART.AIZMisc2_2;
    this.width_pixels = 0x18;
    this.height_pixels = 8;
    this.render_flags = 4;
    this.priority = 0x200;
    this.y30 = this.y_pos;
    this.c36 = waterEnteredCounter(game);
    this.c32 = 0;
    this.c34 = 0;
    this.c35 = 0;
    this.spikes = new SpikedLogSpikes(game, this);
    game.core.spawn(this.spikes);
  }
  update() {
    const g = this.game, rom = g.rom;
    let rise = false;
    if (this.c34 & 0x80) rise = true;
    else {
      const wec = waterEnteredCounter(g);
      if (this.c36 !== wec) {
        this.c36 = wec;
        this.c34 = 0x81;
        rise = true;
      } else if (this.status & P1_STANDING) rise = true;
      else if (this.c32) this.c32 = u8(this.c32 - 4);
    }
    if (rise) {
      // loc_2AFB0
      if (!this.c34) {
        this.c35 = this.anim_frame;
        this.anim_frame = 0;
        this.anim_frame_timer = 0;
        this.c34 = 1;
      }
      if (this.c32 === 0x40) this.c34 &= 0x7f;
      else this.c32 = u8(this.c32 + 4);
    }
    // loc_2AFE2: bob
    const [sin] = this.core.sincos(this.c32);
    this.y_pos = s16((sin >> 5) + this.y30);
    if (this.c34) {
      // rolling: frames go down 15..0 then back to idle
      this.anim_frame_timer = u8(this.anim_frame_timer - 1);
      if (this.anim_frame_timer & 0x80) {
        this.anim_frame_timer = 3;
        this.mapping_frame = (this.mapping_frame - 1) & 0xf;
        this.anim_frame = u8(this.anim_frame + 1);
        if (this.anim_frame >= 0x10) {
          this.anim_frame = this.c35;
          this.c34 = 0;
        }
      }
    } else {
      // loc_2B02C: idle wobble (byte_2B056)
      this.anim_frame_timer = u8(this.anim_frame_timer - 1);
      if (this.anim_frame_timer & 0x80) {
        this.anim_frame_timer = 0x17;
        const d0 = this.anim_frame;
        this.anim_frame = u8(this.anim_frame + 1);
        this.mapping_frame = rom.u8[0x2b056 + d0];
        if (rom.u8[0x2b056 + d0 + 1] & 0x80) this.anim_frame = 0;
      }
    }
    // loc_2B05E
    const h = this.height_pixels;
    this.core.solidObjectFull(this, this.width_pixels + 0xb, h, h + 1, this.x_pos);
    if (this.outOfRange()) {
      this.spikes.delete();
      return this.unload();
    }
    this.display();
  }
}
// loc_2B0B6: the harmful spikes (only touchable when they point up or down)
class SpikedLogSpikes extends Obj {
  constructor(game, log) {
    super(game, { x: log.x_pos, y: log.y_pos });
    this.log = log;
    this.render_flags = 4;
    this.collision_flags = 0x9c;
  }
  update() {
    const a1 = this.log;
    this.x_pos = a1.x_pos;
    this.y_pos = a1.y_pos;
    const d0 = this.game.rom.s8(0x2b0e0 + (a1.mapping_frame & 0xf)); // byte_2B0E0
    if (!d0) return;
    this.y_pos = s16(this.y_pos + d0);
    this.addTouch();
  }
}

// ============================================================================ Button
// Obj_Button: sets Level_trigger_array+(subtype & $F) while stood on
class Button extends Obj {
  constructor(game, d) {
    super(game, d);
    this.mappings = game.maps(MAP.Button);
    this.art_tile = ART.GrayButton;
    this.render_flags = 4;
    this.width_pixels = 0x10;
    this.priority = 0x200;
    this.y_pos = s16(this.y_pos + 4);
    this.topOnly = (this.subtype & 0x20) !== 0;
  }
  update() {
    const g = this.game;
    if (!(this.render_flags & 0x80)) return this.spriteOnScreenTest();
    if (this.topOnly) this.core.solidObjectTop(this, 0x10, 6, this.x_pos); // loc_2BBFE
    else this.core.solidObjectFull(this, 0x1b, 4, 5, this.x_pos); // loc_2BB90
    this.mapping_frame = 0;
    const i = this.subtype & 0xf;
    const bit = this.subtype & 0x40 ? 0x80 : 1;
    if (!(this.status & P1_STANDING)) {
      if (!(this.subtype & 0x10)) setLevelTrigger(g, i, levelTrigger(g, i) & ~bit);
    } else {
      if (!levelTrigger(g, i)) g.sfx(SFX.Switch);
      setLevelTrigger(g, i, levelTrigger(g, i) | bit);
      this.mapping_frame = 1;
    }
    this.spriteOnScreenTest();
  }
}

// ============================================================================ vines
// sub_20140 / sub_20804: common vine piece attributes
function vineInit(o) {
  o.render_flags = 4;
  o.width_pixels = 8;
  o.height_pixels = 8;
  o.priority = 0x200;
  o.mappings = o.game.maps(MAP.RideVine);
  o.art_tile = ART.SwingVine;
  o.ang = 0; // angle (word)
  o.v3a = 0; // $3A
}
const vineFrame = (o) => u8(((o.ang >> 8) & 0xff) + 4) >> 3;

// sub_20480 / sub_20934: hang 16 px below the previous piece, along its angle
function vineFollow(o, a1) {
  const [sin, cos] = o.core.sincos(u8(((a1.ang >> 8) & 0xff) + 4) & 0xf8);
  o.x_pos = s16(a1.x_pos + (s16(-sin + 8) >> 4));
  o.y_pos = s16(a1.y_pos + (s16(cos + 8) >> 4));
}

// loc_20454 / loc_20908: middle pieces
class VinePiece extends Obj {
  constructor(game, x, y, prev) {
    super(game, { x, y });
    vineInit(this);
    this.prev = prev; // $3C
  }
  update() {
    const a1 = this.prev;
    this.v3a = a1.v3a;
    this.ang = u16(a1.ang + this.v3a);
    this.mapping_frame = vineFrame(this);
    vineFollow(this, a1);
    this.display();
  }
}

// Obj_AIZRideVineHandle / loc_20968: the handle the player hangs from
class VineHandle extends Obj {
  constructor(game, x, y, prev) {
    super(game, { x, y });
    vineInit(this);
    this.prev = prev;
    this.mapping_frame = 0x20;
    this.grab = 0; // $32 (Player 1)
    this.regrab = 0; // $34
    this.mode = 0; // $30: 0 hanging, 1 riding the zipline, 2 swinging after the ride
    this.h42 = this.x_pos;
    this.h44 = this.y_pos;
  }
  update() {
    const d4 = this.x_pos, d5 = this.y_pos;
    vineFollow(this, this.prev);
    if (this.x_pos !== d4) this.h42 = d4;
    if (this.y_pos !== d5) this.h44 = d5;
    this.sub_20502(this.game.player);
    if (this.grab && this.mode) return; // the player's hands cover the handle
    this.display();
  }
  sub_20502(p) {
    if (this.grab === 0) return this.loc_206DE(p);
    if (this.grab & 0x80) {
      // loc_205BC: thrown off at the end of a breaking zipline
      p.x_vel = 0x300;
      p.y_vel = 0x200;
      p.status |= S_INAIR;
      return this.loc_205CE(p);
    }
    if (!playerOnScreen(p) || p.routine >= 4) return this.loc_205CE(p);
    if (p.pressed?.jump) {
      p.object_control = 0;
      this.grab = 0;
      if (this.mode === 1) {
        // loc_2059A: jump off along the rope direction
        this.regrab = 0x3c;
        const [sin, cos] = this.core.sincos((this.prev.ang >> 8) & 0xff);
        p.x_vel = s16(cos << 3);
        p.y_vel = s16(sin << 3);
      } else {
        p.x_vel = s16((this.x_pos - this.h42) << 7);
        p.y_vel = s16((this.y_pos - this.h44) << 7);
        this.regrab = 0x3c;
        if (p.held?.left) p.x_vel = -0x200;
        if (p.held?.right) p.x_vel = 0x200;
        p.y_vel = s16(p.y_vel - 0x380);
      }
      // loc_20574
      p.status |= S_INAIR;
      p.jumping = 1;
      p.y_radius = 0xe;
      p.x_radius = 7;
      p.anim = 2;
      p.status |= S_ROLL;
      return;
    }
    this.loc_205DC(p);
  }
  loc_205CE(p) {
    p.object_control = 0;
    this.grab = 0;
    this.regrab = 0x3c;
  }
  // hold the player
  loc_205DC(p) {
    const rom = this.game.rom;
    const a3 = this.prev;
    let a = (a3.ang >> 8) & 0xff;
    if (p.status & S_FACING) a = u8(-a);
    if (this.mode === 0) {
      p.x_pos = this.x_pos;
      p.y_pos = s16(this.y_pos + 0x14);
      p.mapping_frame = rom.u8[0x20624 + (u8(a + 8) >> 4)]; // byte_20624
      return;
    }
    // loc_20634
    const d0 = (u8(a + 0x10) >> 5) * 2;
    p.mapping_frame = rom.u8[0x206be + d0]; // byte_206BE
    p.anim = 0;
    let d2 = rom.s8(0x206ce + d0); // byte_206CE
    const d3 = rom.s8(0x206ce + d0 + 1);
    if (p.status & S_FACING) d2 = -d2;
    const [sin, cos] = this.core.sincos(u8(((a3.ang >> 8) & 0xff) + 4) & 0xf8);
    p.x_pos = s16(a3.x_pos + (s16(-sin + 8) >> 4) + d2);
    p.y_pos = s16(a3.y_pos + (s16(cos + 8) >> 4) + d3);
  }
  // loc_206DE: grab the handle
  loc_206DE(p) {
    if (this.regrab) {
      this.regrab = u8(this.regrab - 1);
      if (this.regrab) return;
    }
    if (u16(p.x_pos - this.x_pos + 0x10) >= 0x20) return;
    if (u16(p.y_pos - this.y_pos) >= 0x18) return;
    if (p.object_control) return;
    if (p.routine >= 4) return;
    p.x_vel = 0;
    p.y_vel = 0;
    p.ground_vel = 0;
    p.x_pos = this.x_pos;
    p.y_pos = s16(this.y_pos + 0x14);
    p.anim = 0x14;
    p.spin_dash_flag = 0;
    p.object_control = 3;
    p.render_flags &= ~2;
    this.grab = 1;
    this.game.sfx(SFX.Grab);
  }
}

// deletes the whole chain (loc_20392 / loc_20846)
function vineCheckDelete(o) {
  if (!o.outOfRange()) return o.display();
  for (const c of o.chain) c.delete();
  o.unload();
}

// Obj_AIZRideVine: zipline pulley with a swinging vine (AIZ1 / AIZ2)
class AIZRideVine extends Obj {
  constructor(game, d) {
    super(game, d);
    vineInit(this);
    this.mapping_frame = 0x21;
    this.x46 = u16(this.x_pos + (this.subtype & 0x7f) * 16);
    this.chain = [];
    let d3 = this.y_pos;
    let prev = this;
    for (let i = 0; i < 5; i++) {
      let c;
      if (i === 0) c = new VineTop(game, this.x_pos, d3, this);
      else if (i === 4) c = new VineHandle(game, this.x_pos, d3, prev);
      else c = new VinePiece(game, this.x_pos, d3, prev);
      d3 += 0x10;
      this.chain.push(c);
      game.core.spawn(c);
      prev = c;
    }
    this.s1 = this.chain[0]; // $3E
    this.handle = this.chain[4]; // $40
    this.mode = 0;
    this.t2e = 0;
    this.v38 = 0;
    this.v42 = 0;
    this.v44 = 0;
  }
  update() {
    switch (this.mode) {
      case 0: // loc_20168: wait for the player to grab the handle
        if (this.handle.grab) {
          this.mode = 1;
          this.s1.t2e = 1;
          this.s1.v38 = 0;
        }
        break;
      case 1: this.loc_2018C(); break;
      case 2: this.loc_20232(); break;
      case 3: this.loc_20254(); break;
      case 4: this.loc_202AC(); break;
      default: this.loc_2034A(); break;
    }
    vineCheckDelete(this);
  }
  // slide down the rope
  loc_2018C() {
    this._x = (this._x + 0x80000) | 0;
    this._y = (this._y + 0x20000) | 0;
    if (u16(this.x_pos) < this.x46) return;
    if (this.subtype & 0x80) {
      // the pulley breaks off and falls (it becomes an animated still sprite)
      this.mode = 2;
      this.x_vel = 0x800;
      this.y_vel = 0x200;
      this.mappings = this.game.maps(MAP.AnimatedStillSprites);
      this.art_tile = ART.AIZMisc2_3;
      this.width_pixels = 8;
      this.height_pixels = 0xc;
      this.mapping_frame = 0;
      this.anim = 0;
      this.prev_anim = 1;
      if (this.handle.grab) this.handle.grab = 0x81;
      return;
    }
    this.mode = 3;
    this.s1.post = true; // loc_20428
    this.s1.v3a = 0;
    this.handle.mode = 1;
    this.ang = 0;
    this.v3a = 0x400;
  }
  loc_20232() {
    this.moveSprite();
    if (!(this.render_flags & 0x80)) this.x_pos = 0x7ff0;
    this.animateSprite(ANI.AnimatedStillSprites);
  }
  // swing at the end of the rope while the player hangs on
  loc_20254() {
    let d1 = s8((this.ang >> 8) & 0xff);
    if (d1 < 0) d1 = -d1;
    const d0 = s16(this.v3a - d1 * 2);
    this.ang = u16(this.ang - d0);
    if (this.handle.grab) return;
    if (u8(((this.ang >> 8) & 0xff) + 8) >= 0x10) return;
    // the player let go: free swing
    this.mode = 4;
    this.v42 = 0;
    this.v44 = -0x300;
    this.v38 = 0x1000;
    this.t2e = 0;
    this.handle.mode = 2;
  }
  loc_202AC() {
    const d2 = (this.v38 >> 8) & 0xff;
    let d0 = this.v44;
    const turn = () => {
      d0 >>= 4;
      this.v44 = s16(this.v44 - d0);
      this.t2e ^= 1;
      if (this.v38 === 0xc00) {
        // loc_202EC
        this.mode = 5;
        this.v38 = 0;
        this.handle.mode = 0;
      } else this.v38 = u16(this.v38 - 0x40);
    };
    if (this.t2e === 0) {
      d0 = s16(d0 + d2);
      this.v44 = d0;
      this.v42 = u16(this.v42 + d0);
      if (!(0 > s8(this.v42 >> 8))) turn();
    } else {
      d0 = s16(d0 - d2);
      this.v44 = d0;
      this.v42 = u16(this.v42 + d0);
      if (!(0 <= s8(this.v42 >> 8))) turn();
    }
    // loc_2032E
    this.ang = this.v42;
    this.v3a = s16(this.v42) >> 3;
    this.s1.v3a = this.v3a;
  }
  // idle sway
  loc_2034A() {
    const a = (this.v38 >> 8) & 0xff;
    this.v38 = u16(this.v38 + 0x200);
    let d0 = s16(this.core.sincos(a)[0] << 2);
    if (d0 === 0x400) d0 = 0x3ff;
    this.ang = u16(d0);
    this.v3a = d0;
    this.s1.v3a = this.v3a;
  }
}

// loc_203C0 / loc_20428: first rope piece (sways until the ride, then follows the pulley)
class VineTop extends Obj {
  constructor(game, x, y, parent) {
    super(game, { x, y });
    vineInit(this);
    this.parent = parent; // $3C
    this.t2e = 0;
    this.v38 = 0;
    this.post = false;
  }
  update() {
    const a1 = this.parent;
    if (this.post) {
      this.ang = a1.ang;
    } else {
      let d0;
      const a = (this.v38 >> 8) & 0xff;
      if (this.t2e === 0) {
        this.v38 = u16(this.v38 + 0x200);
        d0 = s16(this.core.sincos(a)[0] << 2);
        if (d0 === 0x400) d0 = 0x3ff;
      } else {
        this.v38 = u16(this.v38 + 0x100);
        d0 = s16(this.core.sincos(a)[0] << 3);
      }
      this.v3a = d0;
      this.ang = u16(this.v3a);
    }
    this.mapping_frame = vineFrame(this);
    this.x_pos = a1.x_pos;
    this.y_pos = a1.y_pos;
    this.display();
  }
}

// Obj_AIZGiantRideVine: long vine swinging with the global AIZ_vine_angle
class AIZGiantRideVine extends Obj {
  constructor(game, d) {
    super(game, d);
    vineInit(this);
    aizState(game.core);
    this.mapping_frame = 0x21;
    const n = this.subtype & 0xf;
    this.chain = [];
    let d3 = this.y_pos;
    let prev = null;
    for (let i = 0; i <= n; i++) {
      let c;
      if (i === n) c = new VineHandle(game, this.x_pos, d3, prev ?? this);
      else if (i === 0) c = new GiantVineTop(game, this.x_pos, d3, this.subtype & 0xf0);
      else c = new VinePiece(game, this.x_pos, d3, prev);
      d3 += 0x10;
      this.chain.push(c);
      game.core.spawn(c);
      prev = c;
    }
  }
  update() { vineCheckDelete(this); } // loc_2082C
}
// loc_20874
class GiantVineTop extends Obj {
  constructor(game, x, y, phase) {
    super(game, { x, y });
    vineInit(this);
    this.s42 = phase;
  }
  update() {
    const d0 = u8(((aizState(this.core).vineAngle >> 8) & 0xff) + this.s42);
    const sin = this.core.sincos(d0)[0];
    this.ang = u16(sin * 0x2c);
    this.v3a = s16(this.ang) >> 3;
    this.mapping_frame = vineFrame(this);
    this.display();
  }
}

// ============================================================================ AIZHollowTree
const TREE_FRAMES = 0x1d618; // AIZTree_PlayerFrames
// Obj_AIZHollowTree: running fast into the hollow tree spirals the player up inside it
class AIZHollowTree extends Obj {
  constructor(game, d) {
    super(game, d);
    this.width_pixels = 0xd0;
    this.p30 = 0; // $30 progress (long)
    this.t38 = 0;
  }
  update() {
    const m = this.game.ram, p = this.game.player;
    this.sub_1D44C(p);
    if (!(this.status & P1_STANDING) && this.t38) {
      this.t38--;
      if (this.t38 === 0) {
        m.setW(R.Camera_min_X_pos, 0x1300);
        m.setW(R.Camera_max_X_pos, 0x4000);
      } else {
        // loc_1D3F8: ease the camera bounds back
        if (m.uw(R.Camera_min_X_pos) !== 0x1300) {
          if (u16(p.x_pos) >= 0x2d00) m.setW(R.Camera_min_X_pos, 0x1300);
          else m.addW(R.Camera_min_X_pos, -4);
        }
        if (m.uw(R.Camera_max_X_pos) !== 0x4000) {
          if (u16(p.x_pos) < 0x2d00) m.setW(R.Camera_max_X_pos, 0x4000);
          else m.addW(R.Camera_max_X_pos, 4);
        }
      }
    }
    this.deleteIfNotInRange();
  }
  sub_1D44C(p) {
    if (this.status & P1_STANDING) return this.riding(p);
    if (p.status & S_INAIR) return;
    const a = u16(p.x_pos + 0x10);
    if (a < u16(this.x_pos)) return;
    if (s16(a - this.x_pos) >= 0x40) return;
    const dy = s16(p.y_pos - this.y_pos);
    if (dy < -0x5a || dy > 0xa0) return;
    if (p.x_vel < 0x600) return;
    if (p.object_control) return;
    this.core.rideObjectSetRide(this);
    this.p30 = 0;
    p.object_control |= 0x40 | 2;
    p.anim = 0;
    this.core.spawn(new AIZ1TreeRevealControl(this.game));
    const m = this.game.ram;
    m.setW(R.Camera_min_X_pos, 0x2c60);
    m.setW(R.Camera_max_X_pos, 0x2c60);
    this.t38 = 0x3c;
  }
  // loc_1D4DA
  riding(p) {
    const d0 = u16(Math.abs(p.ground_vel));
    if (d0 < 0x600) {
      // loc_1D57C
      if (((this.p30 >>> 16) & 0xffff) >= 0x400) return this.fallOff(p);
      this.setPlayerPos(p);
      return this.fallOff(p);
    }
    if (p.status & S_INAIR) {
      // loc_1D50A
      if (u16(p.x_pos) < 0x2c99) {
        p.x_pos = 0x2c99;
        p.x_vel = 0x400;
      }
      if (u16(p.x_pos) >= 0x2d66) {
        p.x_pos = 0x2d66;
        p.x_vel = -0x400;
      }
      return this.fallOff(p);
    }
    const d = s16(p.y_pos - this.y_pos + 0x90);
    if (d < 0 || d > 0x130) return this.fallOff(p);
    this.setPlayerPos(p);
  }
  // AIZTree_FallOff
  fallOff(p) {
    p.status |= S_INAIR;
    p.status &= ~S_ROLL;
    p.y_radius = 0x13;
    p.x_radius = 9;
    p.anim = 0;
    p.prev_anim = 1;
    p.status &= ~S_ONOBJ;
    this.status &= ~P1_STANDING;
    p.flips_remaining = 0;
    p.flip_speed = 4;
    p.object_control &= ~(0x40 | 2);
    p.x_vel = p.x_vel >> 1;
    p.y_vel = p.y_vel >> 1;
  }
  // AIZTree_SetPlayerPos
  setPlayerPos(p) {
    if (!(p.status & S_ONOBJ)) return;
    this.p30 = (this.p30 + (p.ground_vel << 8)) | 0;
    if (this.p30 < 0) return this.fallOff(p);
    const w = (this.p30 >>> 16) & 0xffff;
    if (w >= 0x400) {
      this.game.ram.setW(R.Camera_min_X_pos, 0x1300);
      this.game.ram.setW(R.Camera_max_X_pos, 0x4000);
    }
    const d2 = p.x_pos;
    const sin = this.core.sincos((w >> 1) & 0xff)[0];
    const nx = s16(((sin * 0x7000) >> 16) + this.x_pos);
    p.x_pos = nx;
    p.x_vel = s16((nx - d2) << 8);
    const e2 = p.y_pos;
    const ny = s16(-(w >> 2) + 0x90 + this.y_pos);
    p.y_pos = ny;
    p.y_vel = s16((ny - e2) << 8);
    p.mapping_frame = this.game.rom.u8[TREE_FRAMES + Math.floor((w >> 1) / 0xb)];
  }
}

// Obj_AIZ1TreeRevealControl: counts Events_fg_4 up for AIZ1_ScreenEvent's tree reveal
class AIZ1TreeRevealControl extends Obj {
  constructor(game) { super(game, {}); this.t2e = 0; }
  update() {
    const m = this.game.ram;
    if (this.t2e && !m.uw(R.Events_fg_4)) return this.delete();
    this.t2e = u16(this.t2e - 1);
    const d0 = u16((u16(0x480 - this.game.player.y_pos) >> 3) + 3);
    if (d0 >= m.uw(R.Events_fg_4) || (this.t2e & 1)) m.setW(R.Events_fg_4, m.uw(R.Events_fg_4) + 1);
  }
}

// ============================================================================ registration
// object id -> class (registered in objects.js TYPES)
export const AIZ_TYPES = {
  3: AIZHollowTree, 6: AIZRideVine, 9: AIZ1Tree, 10: AIZ1ZiplinePeg, 12: AIZGiantRideVine,
  13: BreakableWall, 14: TwistedRamp, 38: AutoSpin, 41: AIZDisappearingFloor, 42: CorkFloor,
  43: AIZFlippingBridge, 44: AIZCollapsingLogBridge, 45: AIZFallingLog, 46: AIZSpikedLog,
  47: StillSprite, 48: AnimatedStillSprite, 50: AIZDrawBridge, 51: Button,
  129: Bloominator, 130: Rhinobot, 131: MonkeyDude, 159: CaterKillerJr, 197: HiddenMonitor,
};
