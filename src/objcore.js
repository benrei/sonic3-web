// Object core: faithful ports of the Sonic 3 object-system routines (s3.asm).
// Labels in comments are the original ones; loc_xxxxx labels are ROM addresses.
// All tables are read from the ROM. Only Player 1 is handled (no Tails / 2P).
//
// ============================================================================ API
// The game owns one `ObjCore` (game.core). Per frame the game calls, in the
// original LevelLoop order:
//   core.touchResponse()   end of Sonic_Control (Test_Ring_Collisions, ShieldTouchResponse, TouchResponse)
//   core.runObjects()      Process_Sprites for all level objects (Reserved_object_3 clears the touch list first)
//   core.afterCamera()     Load_Rings, OscillateNumDo, ChangeRingFrame, Render_Sprites on-screen flags, Load_Sprites
//   core.draw(vdp,cx,cy)   Render_Rings + every object that called display() this frame
//
// Objects extend `Obj` (constructor(game, entry)) and implement update(). Fields
// mirror the SST: x_pos/y_pos (16.16 fixed point in _x/_y, `x`/`y` are fractional
// aliases for legacy code), x_vel, y_vel, status (bit0 xflip, bit1 yflip, bit3
// P1 standing, bit5 P1 pushing, bit7 destroyed), render_flags (bit0/1 flip, bit7 on
// screen, set by Render_Sprites for objects displayed last frame), routine,
// routine_secondary, width_pixels, height_pixels, x_radius, y_radius, mapping_frame,
// anim/prev_anim/anim_frame/anim_frame_timer, art_tile, priority, mappings (frames
// from Rom.mappings), collision_flags, collision_property, shield_reaction,
// boss_hitcount2, respawn (layout index or -1).
// Useful Obj methods (original names in comments):
//   moveSprite() MoveSprite (gravity $38), moveSprite2() MoveSprite2
//   animateSprite(aniAddr) Animate_Sprite with a ROM script table
//   display() Draw_Sprite;  delete() Delete_Current_Sprite
//   addTouch() Add_SpriteToCollisionResponseList
//   spriteOnScreenTest(x?) Sprite_OnScreen_Test(2);  deleteIfNotInRange(x?) Delete_Sprite_If_Not_In_Range
//   spriteCheckDeleteTouch(x?) Sprite_CheckDeleteTouch3 (touch + display, or unload)
//   outOfRange(x?) the $280 coarse window test;  objCheckFloorDist() ObjCheckFloorDist -> d1 (sets this.floorAngle)
//   respawnByte get/set: the object's byte in Object_respawn_table
// Solid routines (return d4: 0 none, 1 side, -1 top, -2 bottom; core.d6 gets the
// "swapped" touch bits TOUCH_SIDE / TOUCH_BOTTOM / TOUCH_TOP for Player 1):
//   core.solidObjectFull(o,d1,d2,d3,d4)   SolidObjectFull (needs on-screen)
//   core.solidObjectFull2(o,d1,d2,d3,d4)  SolidObjectFull2 (always)
//   core.solidObjectCont(o,d1,d2,d3,d4)   SolidObject_cont
//   core.solidObjectTop(o,d1,d3,d4)       SolidObjectTop
//   core.solidObjectTopSloped2(o,d1,slope,d4) SolidObjectTopSloped2 (slope = byte array)
//   core.solidObjectSloped(o,d1,d2,slope,d4)  sub_1BADA (full solid with slope, diagonal springs)
// Touch types (collision_flags TT SSSSSS): 00 enemy (destroyed by Touch_EnemyNormal ->
// Obj_Explosion + score, unless boss_hitcount2), 01 special (routine := 4 when touched,
// size 6 = monitor), 10 harmful (HurtCharacter), 11 boss/special counter (collision_property++).
// An enemy may define onDestroyed() which is called right before it becomes an explosion.
// Other helpers: core.spawn(obj) AllocateObject, core.hurtCharacter(srcX), core.killCharacter(),
// core.giveRing(), core.addScore(pts/10), core.oscByte(ofs)/oscWord(ofs) (Oscillating_table),
// core.sincos(a) -> [sin,cos], core.arctan(dx,dy).

export const P1_STANDING = 0x08, P1_PUSHING = 0x20;
export const TOUCH_SIDE = 1, TOUCH_BOTTOM = 4, TOUCH_TOP = 0x10;
const S_INAIR = 2, S_ONOBJ = 8, S_PUSH = 0x20;
const SS_SHIELD = 1, SS_INVINCIBLE = 2, SS_LTNG = 0x20;

// ROM tables (label = address)
const TOUCH_SIZES = 0x1123c; // Touch_Sizes
const ENEMY_POINTS = 0x11434; // Enemy_Points
const OSC_DATA = 0x5908; // Osc_Data
const OSC_DATA2 = 0x59a0; // Osc_Data2
const SPRITE_LOC_PTRS = 0x5e0d8; // SpriteLocPtrs
const MAP_EXPLOSION = 0x1c38a;
const MAP_ENEMY_SCORE = 0x2c3c6; // Map_EnemyScore
const ANI_RING_SPARKLE = 0x190d6; // Ani_RingSparkle
const ART_EXPLOSION = 0x5a0, ART_RING = 0x6bc, ART_STARPOST = 0x5e4;

const s8 = (v) => (v << 24) >> 24;
const s16 = (v) => (v << 16) >> 16;
const u16 = (v) => v & 0xffff;

// Touch_Width / Test_Ring_Collisions axis test (exact carry semantics).
// pos = object position, d1 = half size, d2 = player's low edge, d4 = player size, d6 = 2*d1
function touchAxis(pos, d1, d2, d4, d6) {
  const a = u16(pos - d1);
  const d0 = u16(a - d2);
  if (a >= u16(d2)) return d0 <= d4; // bcc -> cmp.w d4,d0 ; bhi miss
  return d0 + d6 > 0xffff; // add.w d6,d0 ; bcs hit
}

// ============================================================================ Obj
export class Obj {
  constructor(game, d = {}) {
    this.game = game;
    this.core = game.core;
    this._x = ((d.x ?? 0) << 16) | 0;
    this._y = ((d.y ?? 0) << 16) | 0;
    this.id = d.id;
    this.subtype = d.subtype ?? 0;
    this.respawn = d.respawn ?? -1;
    const flips = (d.xflip ? 1 : 0) | (d.yflip ? 2 : 0);
    this.status = flips;
    this.render_flags = 4 | flips;
    this.routine = 0;
    this.routine_secondary = 0;
    this.x_vel = 0;
    this.y_vel = 0;
    this.x_radius = 0;
    this.y_radius = 0;
    this.width_pixels = 0;
    this.height_pixels = 0;
    this.mapping_frame = 0;
    this.anim = 0;
    this.prev_anim = 0;
    this.anim_frame = 0;
    this.anim_frame_timer = 0;
    this.art_tile = 0;
    this.priority = 0x200;
    this.mappings = null;
    this.pieces = null; // static mappings (render_flags bit 5): explicit piece list
    this.collision_flags = 0;
    this.collision_property = 0;
    this.shield_reaction = 0;
    this.boss_hitcount2 = 0;
    this.alive = true;
    this.displayed = false;
  }

  get x_pos() { return this._x >> 16; }
  set x_pos(v) { this._x = ((v << 16) | (this._x & 0xffff)) | 0; }
  get y_pos() { return this._y >> 16; }
  set y_pos(v) { this._y = ((v << 16) | (this._y & 0xffff)) | 0; }
  // fractional aliases (legacy object code)
  get x() { return this._x / 65536; }
  set x(v) { this._x = Math.floor(v * 65536) | 0; }
  get y() { return this._y / 65536; }
  set y(v) { this._y = Math.floor(v * 65536) | 0; }
  get xflip() { return (this.render_flags & 1) !== 0; }
  set xflip(v) { this.render_flags = (this.render_flags & ~1) | (v ? 1 : 0); }
  get yflip() { return (this.render_flags & 2) !== 0; }
  set yflip(v) { this.render_flags = (this.render_flags & ~2) | (v ? 2 : 0); }
  get onScreen() { return (this.render_flags & 0x80) !== 0; }
  // legacy names
  get frame() { return this.mapping_frame; }
  set frame(v) { this.mapping_frame = v; }
  get map() { return this.mappings; }
  set map(v) { this.mappings = v; }
  get art() { return this.art_tile; }
  set art(v) { this.art_tile = v; }
  get order() { return this.priority; }
  set order(v) { this.priority = v; }

  get respawnByte() { return this.respawn >= 0 ? this.core.respawnTable[this.respawn] : 0; }
  set respawnByte(v) { if (this.respawn >= 0) this.core.respawnTable[this.respawn] = v & 0xff; }

  update() {}

  // MoveSprite2
  moveSprite2() {
    this._x = (this._x + (this.x_vel << 8)) | 0;
    this._y = (this._y + (this.y_vel << 8)) | 0;
  }

  // MoveSprite
  moveSprite() {
    this._x = (this._x + (this.x_vel << 8)) | 0;
    const yv = this.y_vel;
    this.y_vel = s16(yv + 0x38);
    this._y = (this._y + (yv << 8)) | 0;
  }

  // Animate_Sprite (a1 = ROM address of the script offset table)
  animateSprite(a1) {
    const rom = this.core.rom;
    let d0 = this.anim;
    if (d0 !== this.prev_anim) {
      this.prev_anim = d0;
      this.anim_frame = 0;
      this.anim_frame_timer = 0;
    }
    this.anim_frame_timer = (this.anim_frame_timer - 1) & 0xff;
    if (this.anim_frame_timer !== 0xff) return; // bcc
    const s = a1 + rom.u16(a1 + d0 * 2);
    this.anim_frame_timer = rom.u8[s];
    let d1 = this.anim_frame;
    d0 = rom.u8[s + 1 + d1];
    if (d0 & 0x80) {
      if (d0 === 0xff) { // loop
        this.anim_frame = 0;
        d0 = rom.u8[s + 1];
      } else if (d0 === 0xfe) { // back n
        const n = rom.u8[s + 2 + d1];
        this.anim_frame = (this.anim_frame - n) & 0xff;
        d1 = (d1 - n) & 0xff;
        d0 = rom.u8[s + 1 + d1];
      } else if (d0 === 0xfd) { // new anim
        this.anim = rom.u8[s + 2 + d1];
        return;
      } else if (d0 === 0xfc) { // routine + 2
        this.routine += 2;
        this.anim_frame_timer = 0;
        this.anim_frame = (this.anim_frame + 1) & 0xff;
        return;
      } else if (d0 === 0xfb) {
        this.x_pos = 0x7f00;
        return;
      } else return;
    }
    this.mapping_frame = d0;
    this.render_flags = (this.render_flags & 0xfc) | (this.status & 3);
    this.anim_frame = (this.anim_frame + 1) & 0xff;
  }

  // Draw_Sprite
  display() { this.displayed = true; }
  // Delete_Current_Sprite
  delete() { this.alive = false; this.displayed = false; this.collision_flags = 0; }
  // Add_SpriteToCollisionResponseList
  addTouch() { this.core.addTouch(this); }

  // (x & $FF80) - Camera_X_pos_coarse_back > $280
  outOfRange(x = this.x_pos) {
    return u16((x & 0xff80) - this.core.coarseBack) > 0x280;
  }
  // Sprite_OnScreen_Test / Sprite_OnScreen_Test2
  spriteOnScreenTest(x = this.x_pos) {
    if (this.outOfRange(x)) return this.unload();
    this.display();
  }
  // Delete_Sprite_If_Not_In_Range
  deleteIfNotInRange(x = this.x_pos) {
    if (this.outOfRange(x)) { this.unload(); return true; }
    return false;
  }
  // Sprite_CheckDeleteTouch3
  spriteCheckDeleteTouch(x = this.x_pos) {
    if (this.outOfRange(x)) return this.unload();
    this.addTouch();
    this.display();
  }
  // loc_19C02: clear the "loaded" bit so the layout entry can respawn, then delete
  unload() {
    if (this.respawn >= 0) this.core.respawnTable[this.respawn] &= 0x7f;
    this.delete();
  }

  // ObjCheckFloorDist (d1 = distance, this.floorAngle = d3)
  objCheckFloorDist(x = this.x_pos) {
    const r = this.core.findFloor(s16(this.y_pos + s8(this.y_radius)), x);
    this.floorAngle = r.angle & 1 ? 0 : r.angle;
    return r.d1;
  }

  draw(vdp, cx, cy) {
    const pieces = this.pieces ?? (this.mappings && this.mappings[this.mapping_frame]);
    if (pieces) vdp.addSprite(pieces, this.x_pos - cx, this.y_pos - cy, this.art_tile, !!(this.render_flags & 1), !!(this.render_flags & 2), this.priority);
  }
}

// ============================================================================ shared objects

// Obj_Explosion (routine 0 spawns the animal / score, routine 2 = loc_1C24C)
export class Explosion extends Obj {
  constructor(game, x, y, routine = 2, scoreIndex = -1, hiPrio = 0) {
    super(game, { x, y });
    this.routine = routine;
    this.scoreIndex = scoreIndex; // $3E
    this.hiPrio = hiPrio;
  }
  update() {
    const core = this.core;
    if (this.routine === 0) {
      // loc_1C228: Obj_Animal would spawn here; it in turn spawns Obj_EnemyScore
      // (animals are not ported, the score popup is)
      this.routine = 2;
      if (this.scoreIndex >= 0) core.spawn(new EnemyScore(this.game, this.x_pos, this.y_pos, this.scoreIndex >> 1));
    }
    if (this.routine === 2) {
      // loc_1C24C
      this.routine = 4;
      this.mappings = this.game.maps(MAP_EXPLOSION);
      this.art_tile = (this.hiPrio & 0x8000) | ART_EXPLOSION;
      this.priority = 0x80;
      this.collision_flags = 0;
      this.width_pixels = 0xc;
      this.height_pixels = 0xc;
      this.anim_frame_timer = 3;
      this.mapping_frame = 0;
      this.game.sfx('destroy'); // sfx_Break
      this.display();
      return;
    }
    // loc_1C2A0
    this.anim_frame_timer = (this.anim_frame_timer - 1) & 0xff;
    if (this.anim_frame_timer & 0x80) {
      this.anim_frame_timer = 7;
      if (++this.mapping_frame === 5) return this.delete();
    }
    this.display();
  }
}

// Obj_EnemyScore
export class EnemyScore extends Obj {
  constructor(game, x, y, frame) {
    super(game, { x, y });
    this.mappings = game.maps(MAP_ENEMY_SCORE);
    this.art_tile = 0x8000 | ART_STARPOST; // make_art_tile(ArtTile_StarPost,0,1)
    this.priority = 0x80;
    this.width_pixels = 8;
    this.y_vel = -0x300;
    this.mapping_frame = frame;
  }
  // loc_2C316
  update() {
    if (this.y_vel >= 0) return this.delete();
    this.moveSprite2();
    this.y_vel = s16(this.y_vel + 0x18);
    this.display();
  }
}

// Obj_Bouncing_Ring (routine 2 = loc_18F0A, 4 = loc_18F6E, 6 = loc_18F82)
export class BouncingRing extends Obj {
  constructor(game, x, y, xv, yv, d7) {
    super(game, { x, y });
    this.routine = 2;
    this.y_radius = 8;
    this.x_radius = 8;
    this.mappings = game.maps(0x190de); // Map_Ring
    this.art_tile = ART_RING | 0x2000 | 0x8000; // make_art_tile(ArtTile_Ring,1,1)
    this.render_flags = 0x84;
    this.priority = 0x180;
    this.collision_flags = 0x47;
    this.width_pixels = 8;
    this.x_vel = xv;
    this.y_vel = yv;
    this.d7 = d7; // RunObjects slot counter, staggers the floor checks
  }
  update() {
    const core = this.core;
    if (this.routine === 2) {
      // loc_18F0A
      this.mapping_frame = core.ringSpillAnimFrame;
      this.moveSprite2();
      this.y_vel = s16(this.y_vel + 0x18);
      if (this.y_vel >= 0 && ((core.vintCount + this.d7) & 7) === 0 && this.onScreen) {
        const d1 = core.ringCheckFloorDist(this);
        if (d1 < 0) {
          this.y_pos = s16(this.y_pos + d1);
          this.y_vel = s16(this.y_vel - (this.y_vel >> 2));
          this.y_vel = s16(-this.y_vel);
        }
      }
      // loc_18F4A
      if (core.ringSpillAnimCounter === 0) return this.delete();
      if (u16(core.game.maxY + 0xe0) < u16(this.y_pos)) return this.delete();
      this.addTouch();
      this.display();
      return;
    }
    if (this.routine === 4) {
      // loc_18F6E
      this.routine = 6;
      this.collision_flags = 0;
      this.priority = 0x80;
      core.giveRing();
    }
    if (this.routine === 6) {
      // loc_18F82
      this.animateSprite(ANI_RING_SPARKLE);
      this.display();
      return;
    }
    this.delete(); // loc_18F90
  }
}

// Obj_Attracted_Ring (lightning shield)
class AttractedRing extends Obj {
  constructor(game, x, y, ringIndex) {
    super(game, { x, y });
    this.mappings = game.maps(0x190de);
    this.art_tile = ART_RING | 0x2000 | 0x8000;
    this.priority = 0x100;
    this.collision_flags = 0x47;
    this.width_pixels = 8;
    this.height_pixels = 8;
    this.y_radius = 8;
    this.x_radius = 8;
    this.ringIndex = ringIndex;
    this.state = 0;
  }
  update() {
    const core = this.core, p = core.player;
    if (this.state === 0) {
      // loc_18FD2
      if (this.routine !== 0) {
        // AttractedRing_GiveRing
        this.collision_flags = 0;
        this.priority = 0x80;
        core.giveRing();
        this.state = 1;
        this.routine = 0;
      } else {
        this.attractedRingMove(p);
        if (!(p.status_secondary & SS_LTNG)) {
          // lost the shield: becomes a bouncing ring
          const r = new BouncingRing(this.game, this.x_pos, this.y_pos, this.x_vel, this.y_vel, 0);
          r._x = this._x; r._y = this._y;
          core.ringSpillAnimCounter = 0xff;
          core.replace(this, r);
          return;
        }
        // Obj_Attracted_RingAnimate
        this.anim_frame_timer = (this.anim_frame_timer - 1) & 0xff;
        if (this.anim_frame_timer & 0x80) {
          this.anim_frame_timer = 3;
          this.mapping_frame = (this.mapping_frame + 1) & 3;
        }
        if (this.outOfRange()) return this.delete();
        this.addTouch();
        this.display();
        return;
      }
    }
    // loc_19064
    if (this.routine !== 0) return this.delete();
    this.animateSprite(ANI_RING_SPARKLE);
    this.display();
  }
  // AttractedRing_Move
  attractedRingMove(p) {
    let d1 = 0x30;
    if (u16(p.x_pos) >= u16(this.x_pos)) { if (this.x_vel < 0) d1 *= 4; }
    else { d1 = -d1; if (this.x_vel >= 0) d1 *= 4; }
    this.x_vel = s16(this.x_vel + d1);
    d1 = 0x30;
    if (u16(p.y_pos) >= u16(this.y_pos)) { if (this.y_vel < 0) d1 *= 4; }
    else { d1 = -d1; if (this.y_vel >= 0) d1 *= 4; }
    this.y_vel = s16(this.y_vel + d1);
    this.moveSprite2();
  }
}

// Generic falling projectile used by the (not yet rewritten) badniks: harmful touch
// object (collision_flags $98 like the Bloominator / MonkeyDude children).
export class Projectile extends Obj {
  constructor(game, x, y, vx, vy, map, frame, art) {
    super(game, { x, y });
    this.x_vel = vx; this.y_vel = vy;
    this.mappings = map; this.mapping_frame = frame; this.art_tile = art;
    this.priority = 0x100;
    this.collision_flags = 0x98;
    this.width_pixels = 8;
    this.height_pixels = 8;
    this.t = 0;
  }
  update() {
    this.y_vel = s16(this.y_vel + 0x20);
    this.moveSprite2();
    if (++this.t > 180) return this.delete();
    this.spriteCheckDeleteTouch();
  }
}

// ============================================================================ ObjCore
export class ObjCore {
  constructor(game, createObject) {
    game.core = this;
    this.game = game;
    this.rom = game.rom;
    this.player = game.player;
    this.level = game.level;
    this.createObject = createObject;
    const rom = this.rom;
    this.touchSizes = rom.u8.slice(TOUCH_SIZES, TOUCH_SIZES + 0x64);
    this.enemyPoints = [0, 1, 2, 3].map((i) => rom.u16(ENEMY_POINTS + i * 2));
    this.objects = [];
    this.touchList = []; // Collision_response_list
    this.d6 = 0;
    this.chainBonus = 0; // Chain_bonus_counter
    this.vintCount = 0;
    this.extraLifeFlags = 0; // Extra_life_flags
    this.lastStarPost = game.checkpoint?.starpost ?? 0; // Last_star_post_hit
    // Player_TouchFloor clears Chain_bonus_counter (loc_13070)
    const p = this.player;
    const tf = p._touchFloorFlags.bind(p);
    p._touchFloorFlags = () => { this.chainBonus = 0; tf(); };

    // OscillateNumInit
    this.osc = rom.u8.slice(OSC_DATA, OSC_DATA + 0x42);

    // ring manager (Load_Rings init, sub_F7C0)
    this.rings = game.level.rings; // sorted by x, {x, y}
    this.ringStatus = new Int32Array(this.rings.length); // Ring_status_table
    this.ringConsumption = []; // Ring_consumption_table
    this.ringStart = 0;
    this.ringEnd = 0;
    this.ringsFrame = 0;
    this.ringsFrameTimer = 0;
    this.ringSpillAnimCounter = 0;
    this.ringSpillAnimAccum = 0;
    this.ringSpillAnimFrame = 0;
    this.loadRingsWindow();

    // object layout (raw y words, bit 15 = load regardless of Y)
    this.layout = [];
    const idx = ((game.level.zoneAct >> 8) << 1) | (game.level.zoneAct & 1);
    let op = rom.u32(SPRITE_LOC_PTRS + idx * 4);
    for (let i = 0; i < 4000; i++, op += 6) {
      const x = rom.u16(op);
      if (x === 0xffff) break;
      this.layout.push({ x, yw: rom.u16(op + 2), id: rom.u8[op + 4], subtype: rom.u8[op + 5] });
    }
    this.respawnTable = new Uint8Array(this.layout.length + 1); // Object_respawn_table
    this.loadSpritesInit();
  }

  // ------------------------------------------------------------------ helpers
  sincos(a) { a &= 0xff; const p = this.player; return [p.sine[a], p.sine[a + 0x40]]; }
  arctan(x, y) { return this.player._arctan(x, y); }
  oscByte(o) { return this.osc[o]; }
  oscWord(o) { return (this.osc[o] << 8) | this.osc[o + 1]; }
  _setOscWord(o, v) { this.osc[o] = (v >> 8) & 0xff; this.osc[o + 1] = v & 0xff; }

  // AllocateObject (appended: runs this frame if spawned during the object loop)
  spawn(obj) { this.objects.push(obj); return obj; }
  // the object in `old`'s slot becomes `obj` (e.g. move.l #Obj_Explosion,(a1))
  replace(old, obj) {
    const i = this.objects.indexOf(old);
    old.alive = false;
    obj.respawn = old.respawn;
    if (this.player.interact === old) this.player.interact = obj; // same RAM slot
    if (i >= 0) this.objects[i] = obj; else this.objects.push(obj);
    return obj;
  }
  addTouch(o) { if (this.touchList.length < 0x3f) this.touchList.push(o); }

  // FindFloor (sub_105DA) on the player's current collision path -> {d1, angle}
  findFloor(d2, d3) {
    const p = this.player;
    const save = p.primaryAngle;
    p.primaryAngle = 0;
    const d1 = p._findFloor(d2, d3, 0xc, 0x10, 0, 0);
    const angle = p.primaryAngle;
    p.primaryAngle = save;
    return { d1, angle };
  }

  // RingCheckFloorDist -> Ring_FindFloor (sub_1074C)
  ringCheckFloorDist(o) {
    const d3 = o.x_pos, d2 = s16(o.y_pos + s8(o.y_radius));
    const p = this.player, lv = this.level;
    const w = lv.blockWord(d3, d2);
    const id = w & 0x3ff;
    if (id === 0 || !((w >> 0xc) & 1)) return 0x10;
    const ci = lv.collision[p._path()][id];
    if (!ci) return 0x10;
    let d1 = d3;
    if (w & 0x400) d1 = ~d1;
    let h = lv.heights[ci * 16 + (d1 & 0xf)];
    if (w & 0x800) h = -h;
    if (h === 0) return 0x10;
    if (h > 0 && h !== 0x10) return s16(0xf - ((d2 & 0xf) + h));
    if (h < 0 && (d2 & 0xf) + h >= 0) return 0x10;
    // loc_107DA
    const save = p.primaryAngle;
    const r = s16(p._findFloor2(s16(d2 - 0x10), d3, 0xc, 0, 0) - 0x10);
    p.primaryAngle = save;
    return r;
  }

  // ------------------------------------------------------------------ score / rings
  // HUD_AddToScore (d0 in units of 10 points)
  addScore(d0) {
    const g = this.game;
    g.score = Math.min(9999990, g.score + d0 * 10);
    if (g.nextExtraLife === undefined) g.nextExtraLife = 50000;
    if (g.score >= g.nextExtraLife) {
      g.nextExtraLife += 50000;
      g.lives++;
      g.sfx('1up');
    }
  }

  // GiveRing / GiveRing_1P
  giveRing() {
    const g = this.game;
    if (g.rings >= 999) return g.sfx('ring');
    g.rings++;
    if (g.rings < 100) return g.sfx('ring');
    if (!(this.extraLifeFlags & 2)) { this.extraLifeFlags |= 2; return this.extraLife(); }
    if (g.rings < 200) return g.sfx('ring');
    if (!(this.extraLifeFlags & 4)) { this.extraLifeFlags |= 4; return this.extraLife(); }
    g.sfx('ring');
  }
  extraLife() { this.game.lives++; this.game.sfx('1up'); }

  // Obj_Bouncing_Ring init (loc_18E3E): spill min(Ring_count, 32) rings
  ringLoss() {
    const g = this.game, p = this.player;
    let d5 = Math.min(g.rings, 0x20) - 1;
    let d4 = 0x288, d2 = 0, d3 = 0, n = 0;
    for (; d5 >= 0; d5--, n++) {
      if (!(d4 & 0x8000)) {
        let [sin, cos] = this.sincos(d4 & 0xff);
        const sh = (d4 >> 8) & 0xff;
        d2 = s16(sin << sh);
        d3 = s16(cos << sh);
        let lo = (d4 & 0xff) + 0x10;
        d4 = (d4 & 0xff00) | (lo & 0xff);
        if (lo > 0xff) { // addi.b carry
          d4 = d4 - 0x80;
          if (d4 < 0) d4 = 0x288; // subi.w borrow
        }
      }
      this.spawn(new BouncingRing(g, p.x_pos, p.y_pos, d2, d3, 0x60 - n));
      this.ringSpillAnimCounter = 0xff;
      d2 = s16(-d2);
      d4 = u16(-d4);
    }
    g.sfx('ringloss');
    g.rings = 0;
    this.extraLifeFlags = 0;
  }

  // HurtCharacter (via Obj_Sonic's hurt); returns true if hurt
  hurtCharacter(srcX) { return this.player.hurt(srcX); }
  // Kill_Character
  killCharacter() { this.player.kill(); return -1; }

  // ------------------------------------------------------------------ TouchResponse
  touchResponse() {
    const p = this.player;
    this.testRingCollisions();
    this.shieldTouchResponse();
    if (!(p.status_secondary & 0x73) && p.double_jump_flag === 1) {
      // insta-shield: temporarily invincible with a $30x$30 box
      const saved = p.status_secondary;
      p.status_secondary |= SS_INVINCIBLE;
      this.touchProcess(s16(p.x_pos - 0x18), s16(p.y_pos - 0x18), 0x30, 0x30);
      if (!(saved & SS_INVINCIBLE)) p.status_secondary &= ~SS_INVINCIBLE;
      return;
    }
    // Touch_NoInstaShield
    const d5 = (p.y_radius - 3) & 0xff;
    this.touchProcess(s16(p.x_pos - 8), s16(p.y_pos - d5), 0x10, d5 * 2);
  }

  // Touch_Process / Touch_Loop
  touchProcess(d2, d3, d4, d5) {
    for (const o of this.touchList) {
      if (!o.alive) continue;
      const f = o.collision_flags;
      if (!f) continue;
      const i = (f & 0x3f) * 2;
      const w = this.touchSizes[i], h = this.touchSizes[i + 1];
      if (!touchAxis(o.x_pos, w, d2, d4, w * 2)) continue;
      if (!touchAxis(o.y_pos, h, d3, d5, h * 2)) continue;
      return this.touchChkValue(o);
    }
    return 0;
  }

  // Touch_ChkValue
  touchChkValue(o) {
    const p = this.player;
    const t = o.collision_flags & 0xc0;
    if (t === 0) return this.touchEnemy(o);
    if (t === 0xc0) return this.touchSpecial(o);
    if (t & 0x80) return this.touchChkHurt(o);
    if ((o.collision_flags & 0x3f) === 6) return this.touchMonitor(o);
    if (p.invulnerable_time >= 90) return 0;
    o.routine = 4;
    return 0;
  }

  // Touch_Monitor
  touchMonitor(o) {
    const p = this.player;
    if (p.y_vel < 0) {
      if (u16(p.y_pos - 0x10) < u16(o.y_pos)) return 0;
      p.y_vel = s16(-p.y_vel);
      o.y_vel = -0x180;
      if (o.routine_secondary === 0) o.routine_secondary = 4;
      return 0;
    }
    if (p.anim !== 2) return 0;
    p.y_vel = s16(-p.y_vel);
    o.routine = 4;
    o.parent = p;
    return 0;
  }

  // Touch_Enemy
  touchEnemy(o) {
    const p = this.player;
    if (!(p.status_secondary & SS_INVINCIBLE) && p.anim !== 9 && p.anim !== 2) return this.touchChkHurt(o);
    if (o.boss_hitcount2) {
      p.x_vel = s16(-p.x_vel);
      p.y_vel = s16(-p.y_vel);
      p.ground_vel = s16(-p.ground_vel);
      o.saved_collision = o.collision_flags; // $25(a1)
      o.collision_flags = 0;
      if (--o.boss_hitcount2 === 0) o.status |= 0x80;
      return 0;
    }
    return this.touchEnemyNormal(o);
  }

  // Touch_EnemyNormal
  touchEnemyNormal(o) {
    const p = this.player;
    o.status |= 0x80;
    let d0 = this.chainBonus;
    this.chainBonus += 2;
    if (d0 >= 6) d0 = 6;
    let idx3e = d0;
    let pts = this.enemyPoints[d0 >> 1];
    if (this.chainBonus >= 32) { pts = 1000; idx3e = 0xa; }
    this.addScore(pts);
    o.onDestroyed?.();
    // move.l #Obj_Explosion,(a1) ; routine 0 (the respawn entry stays "loaded": no respawn)
    this.replace(o, new Explosion(this.game, o.x_pos, o.y_pos, 0, idx3e, o.art_tile));
    if (p.y_vel < 0) p.y_vel = s16(p.y_vel + 0x100);
    else if (u16(p.y_pos) >= u16(o.y_pos)) p.y_vel = s16(p.y_vel - 0x100);
    else p.y_vel = s16(-p.y_vel);
    return 0;
  }

  // Touch_ChkHurt
  touchChkHurt(o) {
    const p = this.player;
    const d0 = p.status_secondary & 0x73;
    let shield;
    if (d0) {
      if (d0 & o.shield_reaction) return -1;
      shield = (p.status_secondary & SS_SHIELD) !== 0;
    } else shield = p.double_jump_flag === 1;
    if (shield && (o.shield_reaction & 8)) {
      // Touch_ChkHurt_HaveShield: deflect the projectile
      this.deflect(o);
      return -1;
    }
    // Touch_ChkHurt2
    if (p.status_secondary & SS_INVINCIBLE) return -1;
    // Touch_Hurt
    if (p.invulnerable_time) return -1;
    this.hurtCharacter(o.x_pos);
    return -1;
  }

  deflect(o) {
    const p = this.player;
    const a = this.arctan(s16(p.x_pos - o.x_pos), s16(p.y_pos - o.y_pos));
    const [sin, cos] = this.sincos(a);
    o.x_vel = s16((cos * -0x800) >> 8);
    o.y_vel = s16((sin * -0x800) >> 8);
    o.collision_flags = 0;
  }

  // Touch_Special
  touchSpecial(o) {
    const d1 = o.collision_flags & 0x3f;
    if ([7, 6, 0xa, 0xc, 0x15, 0x16, 0x17, 0x18, 0x21].includes(d1)) o.collision_property = (o.collision_property + 1) & 0xff;
    return 0;
  }

  // ShieldTouchResponse
  shieldTouchResponse() {
    const p = this.player;
    if (!(p.status_secondary & 0x71)) return;
    const d2 = s16(p.x_pos - 0x18), d3 = s16(p.y_pos - 0x18);
    for (const o of this.touchList) {
      if (!o.alive || (o.collision_flags & 0xc0) !== 0x80) continue;
      const sz = o.collision_flags & 0x3f;
      if (!sz) continue;
      const w = this.touchSizes[sz * 2], h = this.touchSizes[sz * 2 + 1];
      if (!touchAxis(o.x_pos, w, d2, 0x30, w * 2)) continue;
      if (!touchAxis(o.y_pos, h, d3, 0x30, h * 2)) continue;
      if (!(o.shield_reaction & 8)) continue;
      this.deflect(o);
      return;
    }
  }

  // Test_Ring_Collisions
  testRingCollisions() {
    const p = this.player;
    if (p.invulnerable_time >= 90) return;
    if (this.ringStart === this.ringEnd) return;
    const ltng = (p.status_secondary & SS_LTNG) !== 0;
    let d2, d3, d4, d5;
    if (ltng) {
      d2 = s16(p.x_pos - 0x40); d3 = s16(p.y_pos - 0x40); d4 = 0x80; d5 = 0x80;
    } else {
      d2 = s16(p.x_pos - 8);
      d5 = (p.y_radius - 3) & 0xff;
      d3 = s16(p.y_pos - d5);
      d4 = 0x10;
      d5 *= 2;
    }
    for (let i = this.ringStart; i < this.ringEnd; i++) {
      if (this.ringStatus[i] !== 0) continue;
      const r = this.rings[i];
      if (!touchAxis(r.x, 6, d2, d4, 0xc)) continue;
      if (!touchAxis(r.y, 6, d3, d5, 0xc)) continue;
      if (ltng) {
        // Test_Ring_Collisions_AttractRing
        this.spawn(new AttractedRing(this.game, r.x, r.y, i));
        this.ringStatus[i] = -1;
        return;
      }
      // loc_F76C
      this.ringStatus[i] = 0x604;
      this.giveRing();
      this.ringConsumption.push(i);
    }
  }

  // ------------------------------------------------------------------ Load_Rings
  loadRingsWindow() {
    let d4 = s16(this.game.camX - 8);
    if (d4 <= 0) d4 = 1;
    const rings = this.rings;
    let a = 0;
    while (a < rings.length && rings[a].x < d4) a++;
    let b = a;
    const e = d4 + 0x150;
    while (b < rings.length && rings[b].x < e) b++;
    this.ringStart = a;
    this.ringEnd = b;
  }

  // loc_F642
  loadRings() {
    const st = this.ringStatus;
    this.ringConsumption = this.ringConsumption.filter((i) => {
      let t = (st[i] >> 8) & 0xff, f = st[i] & 0xff;
      t = (t - 1) & 0xff;
      if (t === 0) {
        t = 6;
        f++;
        if (f === 8) { st[i] = -1; return false; }
      }
      st[i] = (t << 8) | f;
      return true;
    });
    this.loadRingsWindow();
  }

  // OscillateNumDo
  oscillateNumDo() {
    if (this.player.routine >= 6) return;
    const rom = this.rom;
    let d3 = this.oscWord(0);
    for (let k = 0; k < 16; k++) {
      const bit = 15 - k;
      const d2 = rom.u16(OSC_DATA2 + k * 4), d4 = rom.u8[OSC_DATA2 + k * 4 + 3];
      const a1 = 2 + k * 4;
      if (!(d3 & (1 << bit))) {
        const v = u16(this.oscWord(a1 + 2) + d2);
        this._setOscWord(a1 + 2, v);
        this._setOscWord(a1, u16(this.oscWord(a1) + v));
        if (!(d4 > this.osc[a1])) d3 |= 1 << bit;
      } else {
        const v = u16(this.oscWord(a1 + 2) - d2);
        this._setOscWord(a1 + 2, v);
        this._setOscWord(a1, u16(this.oscWord(a1) + v));
        if (!(d4 <= this.osc[a1])) d3 &= ~(1 << bit);
      }
    }
    this._setOscWord(0, d3);
  }

  // ChangeRingFrame
  changeRingFrame() {
    this.ringsFrameTimer = (this.ringsFrameTimer - 1) & 0xff;
    if (this.ringsFrameTimer & 0x80) {
      this.ringsFrameTimer = 7;
      this.ringsFrame = (this.ringsFrame + 1) & 3;
    }
    if (this.ringSpillAnimCounter) {
      const d0 = u16(this.ringSpillAnimCounter + this.ringSpillAnimAccum);
      this.ringSpillAnimAccum = d0;
      this.ringSpillAnimFrame = ((d0 << 7) | (d0 >> 9)) & 3; // rol.w #7
      this.ringSpillAnimCounter--;
    }
  }

  // ------------------------------------------------------------------ Load_Sprites
  // loc_19D6C
  loadSpritesInit() {
    const L = this.layout, g = this.game;
    let d6 = s16(g.camX - 0x80);
    if (d6 < 0) d6 = 0;
    d6 &= 0xff80;
    let i = 0;
    while (i < L.length && d6 > L[i].x) i++;
    this.front = i;
    d6 -= 0x80;
    i = 0;
    if (d6 >= 0) while (i < L.length && d6 > L[i].x) i++;
    this.back = i;
    this.camXCoarse = -1;
    this.camYCoarse = g.camY & 0xff80;
    this.loadSprites();
  }

  // loc_1A062: spawn layout entry i if not loaded and inside the Y window
  _spawnEntry(i, d3, d4) {
    if (this.respawnTable[i] & 0x80) return;
    const e = this.layout[i];
    const y = e.yw & 0xfff;
    if (!(e.yw & 0x8000) && (y < d3 || y > d4)) return;
    this._create(i);
  }
  _create(i) {
    const e = this.layout[i];
    this.respawnTable[i] |= 0x80;
    const o = this.createObject(this.game, {
      x: e.x, y: e.yw & 0xfff, xflip: (e.yw >> 13) & 1, yflip: (e.yw >> 14) & 1,
      id: e.id, subtype: e.subtype, respawn: i,
    });
    if (o) this.objects.push(o);
    else this.respawnTable[i] &= 0x7f; // unported object: allow it to "load" again later
  }

  // loc_19DD0
  loadSprites() {
    const g = this.game, L = this.layout;
    const camX = g.camX | 0, camY = g.camY | 0;
    this.coarseBack = s16(camX - 0x80) & 0xff80;
    let d3 = camY & 0xff80;
    const d4 = d3 + 0x200;
    d3 -= 0x80;
    if (d3 < 0) d3 = 0;
    let d6 = camX & 0xff80;
    if (d6 !== this.camXCoarse) {
      if (d6 > this.camXCoarse) {
        // loc_19EA2: moving right
        this.camXCoarse = d6;
        d6 += 0x280;
        while (this.front < L.length && d6 > L[this.front].x) this._spawnEntry(this.front++, d3, d4);
        d6 -= 0x300;
        if (d6 >= 0) while (this.back < L.length && d6 > L[this.back].x) this.back++;
      } else {
        this.camXCoarse = d6;
        d6 -= 0x80;
        if (d6 >= 0) {
          while (this.back > 0 && d6 < L[this.back - 1].x) this._spawnEntry(--this.back, d3, d4);
        }
        d6 += 0x300;
        while (this.front > 0 && d6 <= L[this.front - 1].x) this.front--;
      }
    }
    // loc_19EEA: vertical band
    d6 = camY & 0xff80;
    if (d6 !== this.camYCoarse) {
      let b3 = d6, load = true;
      if (d6 < this.camYCoarse) { b3 = d6 - 0x80; if (b3 < 0) load = false; }
      else b3 = d6 + 0x180;
      if (load) {
        const b4 = b3 + 0x80;
        for (let i = this.back; i < this.front; i++) {
          if (this.respawnTable[i] & 0x80) continue;
          const y = L[i].yw & 0xfff;
          if (y < b3 || y > b4) continue;
          this._create(i);
        }
      }
      this.camYCoarse = d6;
    }
  }

  // ------------------------------------------------------------------ per frame
  runObjects() {
    this.vintCount = (this.vintCount + 1) & 0xff;
    this.touchList = []; // Obj_ResetCollisionResponseList
    for (const o of this.objects) o.displayed = false;
    for (let i = 0; i < this.objects.length; i++) {
      const o = this.objects[i];
      if (o.alive) o.update();
    }
    this.objects = this.objects.filter((o) => o.alive);
  }

  afterCamera() {
    this.loadRings();
    this.oscillateNumDo();
    this.changeRingFrame();
    this.renderFlags();
    this.loadSprites();
  }

  // Render_Sprites: on-screen flag for every displayed object
  renderFlags() {
    const cx = this.game.camX | 0, cy = this.game.camY | 0;
    for (const o of this.objects) {
      if (!o.displayed) continue;
      o.render_flags &= 0x7f;
      const w = o.width_pixels, h = o.height_pixels;
      const d0 = s16(o.x_pos - cx);
      if (d0 + w < 0 || d0 - w >= 320) continue;
      const d1 = u16(o.y_pos - cy + h);
      if (d1 >= h * 2 + 224) continue;
      o.render_flags |= 0x80;
    }
  }

  draw(vdp, cx, cy) {
    // Render_Rings (in front of all objects)
    const map = this.game.maps(0x190de), art = ART_RING | 0x2000;
    for (let i = this.ringStart; i < this.ringEnd; i++) {
      const st = this.ringStatus[i];
      if (st < 0) continue;
      const r = this.rings[i];
      const d1 = u16(r.y - cy + 8);
      if (d1 >= 0xf0) continue;
      const f = (st & 0xff) || this.ringsFrame;
      vdp.addSprite(map[f], r.x - cx, r.y - cy, art, false, false, 1);
    }
    for (const o of this.objects) if (o.displayed) o.draw(vdp, cx, cy);
  }

  // ------------------------------------------------------------------ solid objects
  // SolidObjectFull_1P
  solidObjectFull(o, d1, d2, d3, d4) { return this._solidFull(o, d1, d2, d3, d4, true); }
  // SolidObjectFull2_1P
  solidObjectFull2(o, d1, d2, d3, d4) { return this._solidFull(o, d1, d2, d3, d4, false); }

  _solidFull(o, d1, d2, d3, d4, needOnScreen) {
    const p = this.player;
    this.d6 = 0;
    if (o.status & P1_STANDING) {
      if (!(p.status & S_INAIR)) {
        const d0 = s16(p.x_pos - o.x_pos + d1);
        if (d0 >= 0 && d0 < d1 * 2) { this.mvSonicOnPtfm(o, d3, d4); return 0; }
      }
      this._release(o);
      return 0;
    }
    if (needOnScreen && !(o.render_flags & 0x80)) return this._solidNone(o); // loc_1BD3E
    return this.solidObjectCont(o, d1, d2, d3, d4);
  }

  _release(o) {
    const p = this.player;
    p.status &= ~S_ONOBJ;
    p.status |= S_INAIR;
    o.status &= ~P1_STANDING;
  }

  // SolidObject_cont
  solidObjectCont(o, d1, d2, d3, d4) {
    const p = this.player;
    this.d6 = 0;
    const d0 = s16(p.x_pos - o.x_pos + d1);
    if (d0 < 0 || d0 > d1 * 2) return this._solidNone(o);
    let dd4 = s8(p.default_y_radius) + d2;
    d2 += s8(p.y_radius);
    let dd3 = s16(p.y_pos - o.y_pos + 4 + d2);
    if (dd3 < 0) return this._solidNone(o);
    dd3 &= 0xfff;
    dd4 += d2;
    if (dd3 >= dd4) return this._solidNone(o);
    return this._solidResolve(o, d0, d1, d2, dd3, dd4);
  }

  // loc_1BD8A
  _solidResolve(o, d0, d1, d2, d3, d4) {
    const p = this.player;
    if (p.object_control & 0x80) return this._solidNone(o);
    if (p.routine >= 6) return 0;
    let d5 = d0;
    if (!(u16(d1) >= u16(d0))) { d0 = s16(d0 - d1 * 2); d5 = s16(-d0); }
    let e1 = d3;
    if (!(u16(d2) >= u16(d3))) { d3 = s16(d3 - 4 - d4); e1 = s16(-d3); }
    let vertical = u16(d5) > u16(e1) || u16(e1) <= 4;
    for (;;) {
      if (!vertical) {
        // side (loc_1BDC6 onwards)
        if (d0 !== 0) {
          const zero = d0 > 0 ? p.x_vel >= 0 : p.x_vel < 0;
          if (zero) {
            p.ground_vel = 0;
            p.x_vel = 0;
            if (p.status_tertiary & 0x80) p.status_tertiary |= 0x40;
          }
        }
        p.x_pos = s16(p.x_pos - d0);
        this.d6 |= TOUCH_SIDE;
        if (!(p.status & S_INAIR)) {
          o.status |= P1_PUSHING;
          p.status |= S_PUSH;
        } else {
          o.status &= ~P1_PUSHING;
          p.status &= ~S_PUSH;
        }
        return 1;
      }
      // loc_1BE58
      if (d3 >= 0) {
        if (u16(d3) < 0x10) return this._solidLand(o, d3);
        return this._solidNone(o);
      }
      // loc_1BE64: bottom
      if (p.status & S_INAIR) {
        p.ground_vel = 0;
      } else if (p.y_vel === 0) {
        // loc_1BEA2: standing on the floor under the object -> crush
        if (Math.abs(d0) < 0x10) {
          // back to loc_1BDC6 (which would loop forever if e1 <= 4: resolve as side)
          vertical = false;
          continue;
        }
        this.killCharacter();
        this.d6 |= TOUCH_BOTTOM;
        return -2;
      } else if (p.y_vel > 0) {
        if (p.status_tertiary & 0x80) p.status_tertiary |= 0x20;
        this.d6 |= TOUCH_BOTTOM;
        return -2;
      }
      // loc_1BE80
      p.y_pos = s16(p.y_pos - d3);
      p.y_vel = 0;
      if (p.status_tertiary & 0x80) p.status_tertiary |= 0x20;
      this.d6 |= TOUCH_BOTTOM;
      return -2;
    }
  }

  // loc_1BED0
  _solidLand(o, d3) {
    const p = this.player;
    d3 -= 4;
    const w = o.width_pixels;
    const dd = s16(w + p.x_pos - o.x_pos);
    if (dd < 0 || dd >= w * 2) return 0;
    p.y_pos = s16(p.y_pos - d3 - 1);
    if (p.y_vel < 0) return 0;
    this.rideObjectSetRide(o);
    this.d6 |= TOUCH_TOP;
    return -1;
  }

  // loc_1BE2E
  _solidNone(o) {
    const p = this.player;
    if (o.status & P1_PUSHING) {
      if (p.anim !== 2) { p.anim = 0; p.prev_anim = 1; } // move.w #1,anim(a1)
      o.status &= ~P1_PUSHING;
      p.status &= ~S_PUSH;
    }
    return 0;
  }

  // MvSonicOnPtfm (d3 = height above y_pos, d4 = object's x before it moved)
  mvSonicOnPtfm(o, d3, d4) {
    const p = this.player;
    if (p.object_control & 0x80) return;
    if (p.routine >= 6) return;
    p.y_pos = s16(o.y_pos - d3 - (p.y_radius & 0xff));
    p.x_pos = s16(p.x_pos - (d4 - o.x_pos));
  }

  // RideObject_SetRide
  rideObjectSetRide(o) {
    const p = this.player;
    if ((p.status & S_ONOBJ) && p.interact && p.interact.status !== undefined) p.interact.status &= ~P1_STANDING;
    p.interact = o;
    p.angle = 0;
    p.y_vel = 0;
    p.ground_vel = p.x_vel;
    p.status |= S_ONOBJ;
    o.status |= P1_STANDING;
    if (p.status & S_INAIR) {
      p.status &= ~S_INAIR;
      p._touchFloor(); // Player_TouchFloor
    }
  }

  // SolidObjectTop_1P
  solidObjectTop(o, d1, d3, d4) {
    const p = this.player;
    if (o.status & P1_STANDING) {
      if (!(p.status & S_INAIR)) {
        const d0 = s16(p.x_pos - o.x_pos + d1);
        if (d0 >= 0 && d0 < d1 * 2) { this.mvSonicOnPtfm(o, d3, d4); return 0; }
      }
      this._release(o);
      return 0;
    }
    // loc_1C0DC
    if (p.y_vel < 0) return 0;
    const d0 = s16(p.x_pos - o.x_pos + d1);
    if (d0 < 0 || d0 >= d1 * 2) return 0;
    return this._topLand(o, s16(o.y_pos - d3));
  }

  // loc_1C100
  _topLand(o, d0) {
    const p = this.player;
    const d2 = p.y_pos;
    const d1 = s16(s8(p.y_radius) + d2 + 4);
    if (u16(d0) > u16(d1)) return 0; // bhi
    const r = u16(d0 - d1);
    if (r < 0xfff0) return 0;
    if (p.object_control & 0x80) return 0;
    if (p.routine >= 6) return 0;
    p.y_pos = s16(d2 + s16(r) + 3);
    this.rideObjectSetRide(o);
    return -1;
  }

  // SolidObjectTopSloped2_1P
  solidObjectTopSloped2(o, d1, slope, d4) {
    const p = this.player;
    if (o.status & P1_STANDING) {
      if (!(p.status & S_INAIR)) {
        const d0 = s16(p.x_pos - o.x_pos + d1);
        if (d0 >= 0 && d0 < d1 * 2) { this.solidObjSloped2(o, d1, d4, slope); return 0; }
      }
      this._release(o);
      return 0;
    }
    // SolidObjCheckSloped2
    if (p.y_vel < 0) return 0;
    let d0 = s16(p.x_pos - o.x_pos + d1);
    if (d0 < 0 || d0 >= d1 * 2) return 0;
    if (o.render_flags & 1) d0 = u16(~d0 + d1 * 2);
    d0 = u16(d0) >> 1;
    return this._topLand(o, s16(o.y_pos - s8(slope[d0])));
  }

  // SolidObjSloped2
  solidObjSloped2(o, d1, d2, slope) {
    const p = this.player;
    if (!(p.status & S_ONOBJ)) return;
    let d0 = u16(p.x_pos - o.x_pos + d1) >> 1;
    if (o.render_flags & 1) d0 = u16(~d0 + d1);
    const h = s8(slope[d0] ?? 0);
    p.y_pos = s16(o.y_pos - h - (p.y_radius & 0xff));
    p.x_pos = s16(p.x_pos - (d2 - o.x_pos));
  }

  // sub_1BADA (full solid with a height table; used by diagonal springs)
  solidObjectSloped(o, d1, d2, slope, d4) {
    const p = this.player;
    this.d6 = 0;
    if (o.status & P1_STANDING) {
      if (!(p.status & S_INAIR)) {
        const d0 = s16(p.x_pos - o.x_pos + d1);
        if (d0 >= 0 && d0 < d1 * 2) {
          this.solidObjSloped2(o, d1, d4, slope);
          this.d6 |= TOUCH_TOP;
          return 0;
        }
      }
      this._release(o);
      return 0;
    }
    // loc_1BC84
    const d0 = s16(p.x_pos - o.x_pos + d1);
    if (d0 < 0 || d0 > d1 * 2) return this._solidNone(o);
    let d5 = d0;
    if (o.render_flags & 1) d5 = u16(~d5 + d1 * 2);
    d5 = u16(d5) >> 1;
    const d3a = s8(slope[d5] - slope[0]);
    const top = s16(o.y_pos - d3a);
    d2 += s8(p.y_radius);
    const d3 = s16(p.y_pos - top + 4 + d2);
    if (d3 < 0) return this._solidNone(o);
    const dd4 = d2 * 2;
    if (d3 >= dd4) return this._solidNone(o);
    return this._solidResolve(o, d0, d1, d2, d3, dd4);
  }
}
