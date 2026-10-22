// Level objects: ports of the original object code (s3.asm) on top of objcore.js.
// Labels in comments are the original ones; loc_xxxxx labels are ROM addresses.
// Art, mappings, animation scripts and data tables are read from the ROM.
import { Obj, Explosion, Projectile, P1_STANDING, P1_PUSHING, P2_STANDING, P2_PUSHING, TOUCH_SIDE, TOUCH_BOTTOM } from './objcore.js';
import { AIZ_TYPES } from './objects-aiz.js';
import { Bubbler } from './water.js';

const S_FACING = 1, S_INAIR = 2, S_ROLL = 4, S_ONOBJ = 8, S_PUSH = 0x20;
const SS_INVINCIBLE = 2, SS_FIRE = 0x10;

const s8 = (v) => (v << 24) >> 24;
const s16 = (v) => (v << 16) >> 16;
const u16 = (v) => v & 0xffff;

export const MAP = {
  PathSwap: 0x1b372,
  Monitor: 0x1b958,
  Spring: 0x21dea,
  Spring2: 0x21f92,
  Spikes: 0x22a5c,
  Rock: 0x1dcdc,
  Rock2: 0x1dd64,
  StarPost: 0x2c7be,
  FloatingPlatform: 0x24598,
  HCZFloatingPlatform: 0x2457e,
  MGZFloatingPlatform: 0x2454a,
  CollapsingPlatform: 0x1e6c8,
  CollapsingPlatform2: 0x1e7ac,
  ICZCollapsingBridge: 0x1f2f2,
  Plant: 0x2b8ec,
};

const ANI = {
  Monitor: 0x1b8f0, // Ani_Monitor
  Spring: 0x21db0, // Ani_Spring
  Starpost: 0x2c7ae, // Ani_Starpost
};

const TBL = {
  SpikeSizes: 0x22602, // byte_22602
  RockSizes: 0x1d64e, // byte_1D64E
  RockDebrisPos: 0x1dbea, // off_1DBEA
  RockDebrisVel: 0x1dc28, // off_1DC28
  RockDebrisSideL: 0x1dc30, // word_1DC30
  RockDebrisSideR: 0x1dc50, // word_1DC50
  DiagUpSlope: 0x21d78, // byte_21D78
  DiagDownSlope: 0x21d94, // byte_21D94
  PlatformSizes: 0x243f0, // byte_243F0
  CollapseTimers: 0x1e49c, // byte_1E49C
  CollapseSlope: 0x1e658, // byte_1E658
  ICZCollapseTimers: 0x1e4ba, // byte_1E4BA
  ICZCollapseSlope: 0x1e698, // byte_1E698
};

function romBytes(game, addr, n) { return game.rom.u8.subarray(addr, addr + n); }

// Spring / spike helper: player bits shared by the spring launch routines
// (flip/twirl subtypes and the path selection bits 2-3 of the subtype)
function springFlipAndPath(p, d0, speed, remainingIfNotBit1, remainingIfBit1) {
  if (d0 & 1) {
    p.ground_vel = 1;
    p.flip_angle = 1;
    p.anim = 0;
    p.flips_remaining = remainingIfBit1;
    p.flip_speed = speed;
    if (!(d0 & 2)) p.flips_remaining = remainingIfNotBit1;
    if (p.status & S_FACING) {
      p.flip_angle = 0xff;
      p.ground_vel = -1;
    }
  }
  const path = d0 & 0xc;
  if (path === 4) { p.top_solid_bit = 0xc; p.lrb_solid_bit = 0xd; }
  if (path === 8) { p.top_solid_bit = 0xe; p.lrb_solid_bit = 0xf; }
}

// sub_228EC: hurt the player (spikes, Eggman monitor) after undoing his last y move
function hurtFromSpikes(game, srcX, p = game.player) {
  if (p.status_secondary & SS_INVINCIBLE) return;
  if (p.invulnerable_time) return;
  if (p.routine >= 4) return;
  p._y = (p._y - (p.y_vel << 8)) | 0;
  p.hurt(srcX); // HurtCharacter (a0 = that player)
}

// =============================================================================
// Obj_PathSwap ($1AFC2): invisible collision-layer / sprite-priority switcher.
class PathSwap extends Obj {
  constructor(game, d) {
    super(game, d);
    this.mappings = game.maps(MAP.PathSwap);
    this.art_tile = 0x26bc;
    this.width_pixels = 0x40;
    this.height_pixels = 0x40;
    this.priority = 0x280;
    const s = this.subtype;
    this.vertical = (s & 4) !== 0; // horizontal line: player crosses it moving up/down
    this.mapping_frame = this.vertical ? s & 7 : s & 3;
    this.size = [0x20, 0x40, 0x80, 0x100][s & 3]; // word_1B048 ($32)
    // $34 / $35: which side Player 1 / Player 2 is on (an empty Player_2 slot is at 0, 0)
    const side = (p) => (this.vertical ? u16(this.y_pos) >= u16(p?.y_pos ?? 0) : u16(this.x_pos) >= u16(p?.x_pos ?? 0)) ? 0 : 1;
    this.sides = [side(game.player), side(game.sidekick)];
  }
  update() {
    // loc_1B09E / loc_1B208: Player_1, then Player_2
    this.core.players().forEach((p, i) => (this.vertical ? this.sub_1B25A(p, i) : this.sub_1B0F0(p, i)));
    this.deleteIfNotInRange();
  }
  // sub_1B0F0 (vertical line, crossed horizontally)
  sub_1B0F0(p, i) {
    const d1 = this.x_pos;
    if (!this.sides[i]) {
      if (u16(d1) > u16(p.x_pos)) return;
      this.sides[i] = 1;
      this.apply(p, p.y_pos, this.y_pos, p.x_pos - d1, 8, 0x20);
    } else {
      if (u16(d1) <= u16(p.x_pos)) return;
      this.sides[i] = 0;
      this.apply(p, p.y_pos, this.y_pos, p.x_pos - d1, 0x10, 0x40);
    }
  }
  // sub_1B25A (horizontal line, crossed vertically)
  sub_1B25A(p, i) {
    const d1 = this.y_pos;
    if (!this.sides[i]) {
      if (u16(d1) > u16(p.y_pos)) return;
      this.sides[i] = 1;
      this.apply(p, p.x_pos, this.x_pos, p.y_pos - d1, 8, 0x20);
    } else {
      if (u16(d1) <= u16(p.y_pos)) return;
      this.sides[i] = 0;
      this.apply(p, p.x_pos, this.x_pos, p.y_pos - d1, 0x10, 0x40);
    }
  }
  apply(p, cross, centre, along, pathBit, prioBit) {
    const d0 = this.subtype;
    if (cross < centre - this.size || cross >= centre + this.size) return;
    if ((d0 & 0x80) && (p.status & S_INAIR)) return;
    if (Math.abs(s16(along)) >= 0x40) return;
    if (!(this.render_flags & 1)) {
      p.top_solid_bit = 0xc;
      p.lrb_solid_bit = 0xd;
      if (d0 & pathBit) { p.top_solid_bit = 0xe; p.lrb_solid_bit = 0xf; }
    }
    p.highPriority = (d0 & prioBit) !== 0;
  }
}

// =============================================================================
// Obj_Monitor
class Monitor extends Obj {
  constructor(game, d) {
    super(game, d);
    // Obj_MonitorInit
    this.routine = 2;
    this.y_radius = 0xf;
    this.x_radius = 0xf;
    this.mappings = game.maps(MAP.Monitor);
    this.art_tile = 0x4c4;
    this.priority = 0x180;
    this.width_pixels = 0xe;
    this.height_pixels = 0x10;
    if (this.respawnByte & 1) {
      this.routine = 8;
      this.mapping_frame = 0xb;
      return;
    }
    this.collision_flags = 0x46;
    this.anim = this.subtype;
  }
  update() {
    switch (this.routine) {
      case 2: return this.main();
      case 4: return this.monitorBreak();
      case 6: this.animateSprite(ANI.Monitor); return this.spriteOnScreenTest();
      default: return this.spriteOnScreenTest(); // loc_1B504
    }
  }
  // Obj_MonitorMain
  main() {
    const core = this.core, p = this.game.player;
    if (this.routine_secondary) {
      // knocked up from below: fall back onto the floor
      this.moveSprite();
      if (this.y_vel >= 0) {
        const d1 = this.objCheckFloorDist();
        if (d1 < 0) {
          this.y_pos = s16(this.y_pos + d1);
          this.y_vel = 0;
          this.routine_secondary = 0;
        }
      }
    }
    // loc_1B4C8: SolidObject_Monitor_Sonic (Player_1), SolidObject_Monitor_Tails (Player_2:
    // always solid outside competition mode, only Player_1 breaks monitors)
    const d1 = 0x19, d2 = 0x10, d3 = 0x11, d4 = this.x_pos;
    core.players().forEach((pl, i) => core.asPlayer(i, () => {
      const stand = core.standBit;
      if (this.status & stand) {
        // Monitor_ChkOverEdge
        const d0 = s16(pl.x_pos - this.x_pos + d1);
        if (!(pl.status & S_INAIR) && d0 >= 0 && d0 < d1 * 2) core.mvSonicOnPtfm(this, d3, d4);
        else {
          pl.status &= ~S_ONOBJ;
          pl.status |= S_INAIR;
          this.status &= ~stand;
        }
      } else if (i === 1 || (pl.anim !== 2 && !knuxAttacking(pl))) {
        core.solidObjectCont(this, d1, d2, d3, d4);
      }
    }));
    this.addTouch();
    // Obj_MonitorAnimate
    this.animateSprite(ANI.Monitor);
    this.spriteOnScreenTest();
  }
  // Obj_MonitorBreak
  monitorBreak() {
    const g = this.game, p = g.player, p2 = g.sidekick;
    if (this.status & (P1_STANDING | P1_PUSHING)) {
      p.status &= 0xd7;
      p.status |= S_INAIR;
    }
    if (p2 && (this.status & (P2_STANDING | P2_PUSHING))) {
      p2.status &= 0xd7;
      p2.status |= S_INAIR;
    }
    // Obj_MonitorSpawnIcon
    this.status = 0;
    this.routine = 6;
    this.collision_flags = 0;
    this.core.spawn(new MonitorContents(g, this.x_pos, this.y_pos, this.anim));
    this.core.spawn(new Explosion(g, this.x_pos, this.y_pos, 2));
    this.respawnByte = this.respawnByte | 1;
    this.anim = 0xa;
    this.display();
  }
}

// SolidObject_Monitor_SonicKnux: a gliding (double_jump_flag 1) or sliding (3) Knuckles
// passes into monitors (and breaks them in Touch_Monitor)
function knuxAttacking(pl) {
  return pl.character_id === 2 && (pl.double_jump_flag === 1 || pl.double_jump_flag === 3);
}

// Obj_MonitorContents: the icon rises, then the power-up is given
class MonitorContents extends Obj {
  constructor(game, x, y, anim) {
    super(game, { x, y });
    this.anim = anim;
  }
  update() {
    if (this.routine === 0) {
      // loc_1B616
      this.routine = 2;
      this.art_tile = 0x84c4; // make_art_tile(ArtTile_Monitors,0,1)
      this.render_flags = 0x24;
      this.priority = 0x180;
      this.width_pixels = 8;
      this.y_vel = -0x300;
      this.mapping_frame = this.anim + 1;
      const frame = this.game.maps(MAP.Monitor)[this.mapping_frame];
      this.pieces = frame ? frame.slice(0, 1) : null; // static mappings: first piece only
    }
    if (this.routine === 2) {
      // sub_1B65C
      if (this.y_vel < 0) {
        this.moveSprite2();
        this.y_vel = s16(this.y_vel + 0x18);
      } else {
        this.routine = 4;
        this.anim_frame_timer = 30 - 1;
        this.game.monitorReward(this.anim, this);
      }
      return this.display();
    }
    // loc_1B8E4
    if (--this.anim_frame_timer < 0) return this.delete();
    this.display();
  }
}

// =============================================================================
// Obj_Spring
class Spring extends Obj {
  constructor(game, d) {
    super(game, d);
    this.mappings = game.maps(MAP.Spring);
    this.art_tile = 0x4a4; // make_art_tile(ArtTile_SpikesSprings+$10,0,0)
    this.width_pixels = 0x10;
    this.height_pixels = 0x10;
    this.priority = 0x200;
    this.homeX = this.x_pos; // $32
    this.homeY = this.y_pos; // $34
    this.kind = (this.subtype >> 4) & 7; // Spring_Index
    if (this.kind > 4) this.kind = 0;
    switch (this.kind) {
      case 1: // Spring_Horizontal
        this.anim = 2;
        this.mapping_frame = 3;
        this.art_tile = 0x4b4;
        this.width_pixels = 8;
        break;
      case 2: // Spring_Down
        this.mapping_frame = 6;
        this.status |= 2;
        break;
      case 3: // Spring_UpDiag
        this.anim = 4;
        this.mapping_frame = 7;
        this.art_tile = (game.zone.id >> 8) === 2 ? 0x478 : 0x43a;
        this.slope = romBytes(game, TBL.DiagUpSlope, 28);
        break;
      case 4: // Spring_DownDiag
        this.anim = 4;
        this.mapping_frame = 0xa;
        this.art_tile = (game.zone.id >> 8) === 2 ? 0x478 : 0x43a;
        this.status |= 2;
        this.slope = romBytes(game, TBL.DiagDownSlope, 28);
        break;
    }
    // Spring_Common (word_215A2)
    this.power = this.subtype & 2 ? -0xa00 : -0x1000; // $30
    if (this.subtype & 2) this.mappings = game.maps(MAP.Spring2);
  }
  // Each spring runs the _1P solid routine for Player_1 (p1_standing_bit) and then for
  // Player_2 (p2_standing_bit) and launches whoever is on it.
  update() {
    const core = this.core, players = core.players();
    switch (this.kind) {
      case 0: // Obj_Spring_Up
        players.forEach((p, i) => {
          core.solidObjectFull2_1P(this, 0x1b, 8, 0x10, this.x_pos, i);
          if (this.status & (i ? P2_STANDING : P1_STANDING)) this.launchUp(p);
        });
        this.animateSprite(ANI.Spring);
        return this.spriteOnScreenTest();
      case 1: // Obj_Spring_Horizontal
        players.forEach((p, i) => {
          core.solidObjectFull2_1P(this, 0x13, 0xe, 0xf, this.x_pos, i);
          if (core.d6 & (TOUCH_SIDE << i)) {
            let d1 = this.status;
            if (u16(this.x_pos) >= u16(p.x_pos)) d1 ^= 1;
            if (!(d1 & 1)) this.launchHorizontal(8, p);
          }
        });
        this.sub_2190C();
        this.animateSprite(ANI.Spring);
        return this.spriteOnScreenTest(this.homeX);
      case 2: // Obj_Spring_Down
        players.forEach((p, i) => {
          if (core.solidObjectFull2_1P(this, 0x1b, 8, 9, this.x_pos, i) === -2) this.launchDown(p);
        });
        this.animateSprite(ANI.Spring);
        return this.spriteOnScreenTest();
      case 3: // Obj_Spring_UpDiag
        players.forEach((p, i) => {
          core.solidObjectSloped_1P(this, 0x1b, 0x10, this.slope, this.x_pos, i);
          if (this.status & (i ? P2_STANDING : P1_STANDING)) this.sub_21B74(p);
        });
        this.animateSprite(ANI.Spring);
        return this.spriteOnScreenTest(this.homeX);
      case 4: // Obj_Spring_DownDiag
        players.forEach((p, i) => {
          if (core.solidObjectSloped_1P(this, 0x1b, 0x10, this.slope, this.x_pos, i) === -2) this.launchDownDiag(p);
        });
        this.animateSprite(ANI.Spring);
        return this.spriteOnScreenTest(this.homeX);
    }
  }
  // sub_2164A
  launchUp(p = this.game.player) {
    this.anim = 1; this.prev_anim = 0;
    p.y_pos = s16(p.y_pos + 8);
    p.y_vel = this.power;
    p.status |= S_INAIR;
    p.status &= ~S_ONOBJ;
    p.jumping = 0;
    p.spin_dash_flag = 0;
    p.anim = 0x10;
    p.routine = 2;
    const d0 = this.subtype;
    if (d0 & 0x80) p.x_vel = 0;
    springFlipAndPath(p, d0, 4, 1, 0);
    this.game.sfx('spring');
  }
  // sub_21836 (d = 8; the 2P variant sub_21806 uses 4)
  launchHorizontal(d, p = this.game.player) {
    this.anim = 3; this.prev_anim = 0;
    p.x_vel = this.power;
    p.x_pos = s16(p.x_pos + d);
    p.status |= S_FACING;
    if (!(this.status & 1)) {
      p.status &= ~S_FACING;
      p.x_pos = s16(p.x_pos - 2 * d);
      p.x_vel = s16(-p.x_vel);
    }
    // loc_21864
    p.move_lock = 0xf;
    p.ground_vel = p.x_vel;
    if (!(p.status & S_ROLL)) p.anim = 0;
    const d0 = this.subtype;
    if (d0 & 0x80) p.y_vel = 0;
    springFlipAndPath(p, d0, 8, 3, 1);
    this.status &= ~(P1_PUSHING | P2_PUSHING);
    p.status &= ~S_PUSH;
    this.game.sfx('spring');
  }
  // sub_2190C: launch a player standing in front of the spring's face (Player_1, Player_2)
  sub_2190C() {
    if (this.anim === 3) return;
    let d0 = this.x_pos, d1 = d0 + 0x28;
    if (this.status & 1) { d1 = d0; d0 -= 0x28; }
    const d2 = this.y_pos - 0x18, d3 = this.y_pos + 0x18;
    for (const p of this.core.players()) {
      if (p.status & S_INAIR) continue;
      let d4 = p.ground_vel;
      if (this.status & 1) d4 = s16(-d4);
      if (d4 < 0) continue;
      if (u16(p.x_pos) < u16(d0) || u16(p.x_pos) >= u16(d1)) continue;
      if (u16(p.y_pos) < u16(d2) || u16(p.y_pos) >= u16(d3)) continue;
      this.launchHorizontal(8, p);
    }
  }
  // sub_21A6A
  launchDown(p = this.game.player) {
    p.y_pos = s16(p.y_pos - 8);
    this.anim = 1; this.prev_anim = 0;
    p.y_vel = s16(-this.power);
    if (p.y_vel === 0x1000) p.y_vel = 0xd00;
    const d0 = this.subtype;
    if (d0 & 0x80) p.x_vel = 0;
    springFlipAndPath(p, d0, 4, 1, 0);
    p.status |= S_INAIR;
    p.status &= ~S_ONOBJ;
    p.jumping = 0;
    p.routine = 2;
    this.game.sfx('spring');
  }
  // sub_21B74
  sub_21B74(p = this.game.player) {
    if (!(this.status & 1)) { if (!(u16(this.x_pos - 4) < u16(p.x_pos))) return; }
    else if (!(u16(this.x_pos + 4) >= u16(p.x_pos))) return;
    // loc_21B98
    this.anim = 5; this.prev_anim = 0;
    p.y_vel = this.power;
    p.x_vel = this.power;
    p.y_pos = s16(p.y_pos + 6);
    p.x_pos = s16(p.x_pos + 6);
    p.status |= S_FACING;
    if (!(this.status & 1)) {
      p.status &= ~S_FACING;
      p.x_pos = s16(p.x_pos - 12);
      p.x_vel = s16(-p.x_vel);
    }
    p.status |= S_INAIR;
    p.status &= ~S_ONOBJ;
    p.jumping = 0;
    p.anim = 0x10;
    p.routine = 2;
    springFlipAndPath(p, this.subtype, 8, 3, 1);
    this.game.sfx('spring');
  }
  // sub_21CB2
  launchDownDiag(p = this.game.player) {
    this.anim = 5; this.prev_anim = 0;
    p.y_vel = s16(-this.power);
    p.x_vel = this.power;
    p.y_pos = s16(p.y_pos - 6);
    p.x_pos = s16(p.x_pos + 6);
    p.status |= S_FACING;
    if (!(this.status & 1)) {
      p.status &= ~S_FACING;
      p.x_pos = s16(p.x_pos - 12);
      p.x_vel = s16(-p.x_vel);
    }
    p.status |= S_INAIR;
    p.status &= ~S_ONOBJ;
    p.jumping = 0;
    p.routine = 2;
    springFlipAndPath(p, this.subtype, 8, 3, 1);
    this.game.sfx('spring');
  }
}

// =============================================================================
// Obj_Spikes
class Spikes extends Obj {
  constructor(game, d) {
    super(game, d);
    this.priority = 0x200;
    const d0 = (this.subtype & 0xf0) >> 3;
    const t = romBytes(game, TBL.SpikeSizes, 16);
    this.width_pixels = t[d0];
    this.height_pixels = t[d0 + 1];
    this.mappings = game.maps(MAP.Spikes);
    this.art_tile = 0x49c; // make_art_tile(ArtTile_SpikesSprings+$8,0,0)
    this.mapping_frame = d0 >> 1;
    this.mode = 0; // loc_226FC: pointing up
    if (this.mapping_frame >= 4) { this.mode = 1; this.art_tile = 0x494; } // loc_2274E: sideways
    if (this.status & 2) this.mode = 2; // loc_227AA: pointing down
    this.homeX = this.x_pos; // $30
    this.homeY = this.y_pos; // $32
    this.move = (this.subtype & 0xf) * 2;
    this.offset = 0; // $34
    this.dir = 0; // $36
    this.wait = 0; // $38
  }
  update() {
    const core = this.core, g = this.game;
    this.sub_22922();
    core.solidObjectFull(this, this.width_pixels + 0xb, this.height_pixels, this.height_pixels + 1, this.x_pos);
    const d6 = core.d6;
    core.players().forEach((p, i) => {
      if (this.mode === 0) { // loc_226FC
        if (this.status & (i ? P2_STANDING : P1_STANDING)) hurtFromSpikes(g, this.x_pos, p);
      } else if (this.mode === 1) { // loc_2274E
        if (d6 & (TOUCH_SIDE << i)) {
          hurtFromSpikes(g, this.x_pos, p);
          this.status &= ~(i ? P2_PUSHING : P1_PUSHING);
        }
      } else if (d6 & (TOUCH_BOTTOM << i)) hurtFromSpikes(g, this.x_pos, p); // loc_227AA
    });
    this.spriteOnScreenTest(this.homeX);
  }
  // sub_22922: moving spikes (subtype 1 = vertical, 2 = horizontal)
  sub_22922() {
    if (this.move !== 2 && this.move !== 4) return;
    this.sub_22960();
    if (this.move === 2) this.y_pos = this.homeY + (this.offset >> 8);
    else this.x_pos = this.homeX + (this.offset >> 8);
  }
  // sub_22960
  sub_22960() {
    if (this.wait) {
      if (--this.wait === 0 && this.onScreen) this.game.sfx('spikemove');
      return;
    }
    if (this.dir) {
      const n = this.offset - 0x800;
      if (n < 0) { this.offset = 0; this.dir = 0; this.wait = 60; } else this.offset = n;
    } else {
      this.offset += 0x800;
      if (this.offset >= 0x2000) { this.offset = 0x2000; this.dir = 1; this.wait = 60; }
    }
  }
}

// =============================================================================
// Obj_InvisibleBlock: solid box sized by subtype (only visible in debug mode).
class InvisibleBlock extends Obj {
  constructor(game, d) {
    super(game, d);
    this.priority = 0x200;
    this.width_pixels = ((this.subtype & 0xf0) + 0x10) >> 1;
    this.height_pixels = ((this.subtype & 0xf) + 1) << 3;
  }
  // loc_1C834
  update() {
    this.core.solidObjectFull2(this, this.width_pixels + 0xb, this.height_pixels, this.height_pixels + 1, this.x_pos);
    this.deleteIfNotInRange();
  }
}

// =============================================================================
// Obj_AIZLRZEMZRock
class Rock extends Obj {
  constructor(game, d) {
    super(game, d);
    const f = (this.subtype >> 4) & 7;
    this.mapping_frame = f;
    const t = romBytes(game, TBL.RockSizes, 8);
    this.width_pixels = t[(f & 3) * 2];
    this.height_pixels = t[(f & 3) * 2 + 1];
    this.y_radius = this.height_pixels;
    this.mappings = game.maps(MAP.Rock);
    this.art_tile = 0x2333; // make_art_tile(ArtTile_AIZMisc1,1,0)
    if (game.zone.id === 0x001) {
      this.mappings = game.maps(MAP.Rock2);
      this.art_tile = 0x42e9; // make_art_tile(ArtTile_AIZMisc2,2,0)
    }
    this.priority = 0x200;
    this.homeX = this.x_pos; // $2E
    this.pushLeft = 0x40; // child_dx ($42 word)
    this.pushTimer = 0; // $40
    this.sideMode = (this.subtype & 4) !== 0; // loc_1D8E0
    // S3&K loc_1FA8C: subtype low nibble $F = breaks when Knuckles stands on it (loc_20002)
    this.knuxStand = (this.subtype & 0xf) === 0xf;
    if (this.knuxStand) this.sideMode = false;
    else if (!this.sideMode) {
      // loc_1D6EA: restore how far the rock was pushed
      const d0 = this.respawnByte & 0x7f;
      if (d0) {
        this.x_pos = this.x_pos - d0;
        this.pushLeft = 0x40 - d0;
        this.y_pos = s16(this.y_pos + this.objCheckFloorDist());
      }
    }
  }
  update() {
    if (this.knuxStand) return this.knuxStandUpdate();
    return this.sideMode ? this.sideUpdate() : this.topUpdate();
  }
  // S3&K loc_20002: only Knuckles (character_id 2) standing on it breaks it; he is bounced
  // up rolling (sub_20056)
  knuxStandUpdate() {
    const core = this.core, p1 = this.game.player, p2 = this.game.sidekick;
    const chain = core.chainBonus; // $38
    core.solidObjectFull(this, this.width_pixels + 0xb, this.height_pixels, this.height_pixels + 1, this.x_pos);
    if (!(this.status & P1_STANDING) || p1.character_id !== 2) return this.spriteOnScreenTest();
    this.sub_1D7CE(p1);
    if (p2 && (this.status & P2_STANDING)) this.sub_1D7CE(p2);
    // loc_20088
    core.chainBonus = chain;
    this.status &= 0xe7;
    const f = this.mapping_frame;
    return this.smash(f * 2, TBL.RockDebrisVel + this.game.rom.u16(TBL.RockDebrisVel + f * 2));
  }
  // loc_1D712
  topUpdate() {
    const core = this.core, g = this.game, p1 = g.player, p2 = g.sidekick;
    const chain = core.chainBonus; // $38
    const anim = [p1.anim, p2?.anim]; // $32 / $33
    const savedStatus = [p1.status, p2?.status ?? 0]; // $3A / $3B
    core.solidObjectFull(this, this.width_pixels + 0xb, this.height_pixels, this.height_pixels + 1, this.x_pos);
    if (this.subtype & 2) this.sub_1DAD2(savedStatus);
    const d0 = this.status & 0x18; // standing_mask
    if (!(this.subtype & 1) || !d0) return this.spriteOnScreenTest(this.homeX); // loc_1D76C
    // loc_1D782: smashed by a player landing on it rolling (sub_1D7CE bounces him up)
    if (d0 === 0x18) {
      if (anim[0] !== 2 && anim[1] !== 2) return this.spriteOnScreenTest(this.homeX);
      this.sub_1D7C8(p1, anim[0]);
      this.sub_1D7C8(p2, anim[1]);
    } else if (d0 & P1_STANDING) {
      if (anim[0] !== 2) return this.spriteOnScreenTest(this.homeX);
      this.sub_1D7CE(p1);
    } else {
      if (anim[1] !== 2) return this.spriteOnScreenTest(this.homeX); // loc_1D800
      this.sub_1D7CE(p2);
    }
    // loc_1D818
    core.chainBonus = chain;
    this.status &= 0xe7;
    const f = this.mapping_frame;
    return this.smash(f * 2, TBL.RockDebrisVel + this.game.rom.u16(TBL.RockDebrisVel + f * 2));
  }
  // sub_1D7C8 / sub_1D7CE
  sub_1D7C8(p, anim) {
    if (anim === 2) return this.sub_1D7CE(p);
    p.status |= S_INAIR; // loc_1D7EC
    p.status &= ~S_ONOBJ;
    p.routine = 2;
  }
  sub_1D7CE(p) {
    p.status |= S_ROLL;
    p.y_radius = 0xe;
    p.x_radius = 7;
    p.anim = 2;
    p.y_vel = -0x300;
    p.status |= S_INAIR;
    p.status &= ~S_ONOBJ;
    p.routine = 2;
  }
  // loc_1D8E0: breakable by rolling into its side (Knuckles just has to push)
  sideUpdate() {
    const core = this.core, g = this.game, p1 = g.player, p2 = g.sidekick;
    const xv1 = p1.x_vel, xv2 = p2?.x_vel ?? 0; // $30 / $36
    core.solidObjectFull(this, this.width_pixels + 0xb, this.height_pixels, this.height_pixels + 1, this.x_pos);
    const d6 = core.d6 & 3;
    if (d6) {
      const fast = (v) => u16(Math.abs(v)) >= 0x480;
      if (d6 & 1) {
        // loc_1D926: Player_1
        let brk;
        if (this.subtype & 0x80) brk = p1.character_id === 2;
        else brk = p1.character_id === 2 || (((p1.status_secondary & SS_FIRE) || (this.status & P1_PUSHING)) && p1.anim === 2 && fast(xv1));
        if (brk) {
          // loc_1D97A
          this.status &= ~P1_PUSHING;
          const p2Pushing = (this.status & P2_PUSHING) !== 0;
          this.sub_1DA08(p1, xv1);
          if (p2Pushing && p2 && (p2.character_id === 2 || p2.anim === 2)) {
            p2.x_vel = xv2;
            p2.ground_vel = p2.x_vel;
            p2.status &= ~S_PUSH;
          }
          return;
        }
      }
      // loc_1D9BE: Player_2
      if (p2 && (this.status & P2_PUSHING)) {
        let brk;
        if (this.subtype & 0x80) brk = p2.character_id === 2;
        else brk = p2.character_id === 2 || (p2.anim === 2 && fast(xv2));
        if (brk) {
          this.status &= ~P2_PUSHING; // loc_1DA02
          return this.sub_1DA08(p2, xv2);
        }
      }
    }
    this.spriteOnScreenTest(this.homeX); // loc_1D910
  }
  // sub_1DA08 (+ sub_1DAA8: whoever stands on it falls)
  sub_1DA08(p, xv) {
    this.core.players().forEach((pl, i) => {
      const bit = i ? P2_STANDING : P1_STANDING;
      if (!(this.status & bit)) return;
      this.status &= ~bit;
      pl.status |= S_INAIR;
      pl.status &= ~S_ONOBJ;
    });
    p.x_vel = xv;
    p.x_pos = s16(p.x_pos + 4);
    let a4 = TBL.RockDebrisSideL;
    if (u16(this.x_pos) >= u16(p.x_pos)) {
      p.x_pos = s16(p.x_pos - 8);
      a4 = TBL.RockDebrisSideR;
    }
    p.ground_vel = p.x_vel;
    p.status &= ~S_PUSH;
    // S3&K sub_1FE34: a gliding Knuckles drops out of the glide
    if (p.character_id === 2 && p.double_jump_flag === 1) {
      p.double_jump_flag = 2;
      p.anim = 0x21;
      p.status &= ~1;
      if (p.x_vel < 0) p.status |= 1;
    }
    return this.smash(this.mapping_frame * 2, a4);
  }
  // sub_1DAD2 / sub_1DAFC: pushable rock (moves left one pixel every 17 frames)
  sub_1DAD2(savedStatus) {
    const d3 = this.status & 0x60; // pushing_mask
    if (!d3) return;
    const d2 = this.x_pos;
    this.core.players().forEach((p, i) => {
      if (!(d3 & (i ? P2_PUSHING : P1_PUSHING))) return;
      if (u16(d2) >= u16(p.x_pos)) return;
      if (!(savedStatus[i] & S_PUSH)) return;
      if (--this.pushTimer >= 0) return;
      this.pushTimer = 0x10;
      if (this.pushLeft === 0) return;
      this.pushLeft--;
      this.x_pos--;
      p.x_pos--;
      this.y_pos = s16(this.y_pos + this.objCheckFloorDist());
      this.respawnByte = ((0x40 - this.pushLeft) & 0x7f) | 0x80;
    });
  }
  // sub_1DB60: break into debris (this object becomes the first fragment)
  smash(d0, a4) {
    const g = this.game, rom = g.rom, core = this.core;
    let a3 = TBL.RockDebrisPos + rom.u16(TBL.RockDebrisPos + d0);
    const n = rom.u16(a3) + 1;
    a3 += 2;
    const x = this.x_pos, y = this.y_pos;
    let d6 = 3;
    for (let k = 0; k < n; k++) {
      const frag = new RockFragment(g, x + rom.s8(a3 + k * 2), y + rom.s8(a3 + k * 2 + 1));
      frag.mappings = this.mappings;
      frag.render_flags = this.render_flags;
      frag.art_tile = this.art_tile | 0x8000;
      frag.x_vel = rom.s16(a4 + k * 4);
      frag.y_vel = rom.s16(a4 + k * 4 + 2);
      frag.mapping_frame = d6;
      if (++d6 >= 7) d6 = 3;
      if (k === 0) core.replace(this, frag); else core.spawn(frag);
    }
    g.sfx('destroy'); // sfx_Collapse
  }
}

// loc_1D836: rock debris
class RockFragment extends Obj {
  constructor(game, x, y) {
    super(game, { x, y });
    this.priority = 0x80;
    this.width_pixels = 0x18;
  }
  update() {
    this.anim_frame_timer = (this.anim_frame_timer - 1) & 0xff;
    if (this.anim_frame_timer & 0x80) {
      this.anim_frame_timer = 2;
      let d0 = this.mapping_frame + 1;
      if (d0 >= 7) d0 = 3;
      this.mapping_frame = d0;
    }
    this.moveSprite2();
    this.y_vel = s16(this.y_vel + 0x18);
    if (!this.onScreen) return this.delete();
    this.display();
  }
}

// =============================================================================
// Obj_FloatingPlatform
class FloatingPlatform extends Obj {
  constructor(game, d) {
    super(game, d);
    const z = game.zone.id;
    this.mappings = game.maps(MAP.FloatingPlatform);
    this.art_tile = 0x43f7; // make_art_tile(ArtTile_AIZFloatingPlatform,2,0)
    if (z === 0x001) this.art_tile = 0x4440;
    if ((z >> 8) === 1) { this.mappings = game.maps(MAP.HCZFloatingPlatform); this.art_tile = 0x441d; }
    if ((z >> 8) === 2) { this.mappings = game.maps(MAP.MGZFloatingPlatform); this.art_tile = 0x4001; }
    this.priority = 0x180;
    const a2 = TBL.PlatformSizes + ((this.subtype >> 2) & 0x1c);
    const rom = game.rom;
    this.width_pixels = rom.u8[a2];
    this.height_pixels = rom.u8[a2 + 1];
    this.mapping_frame = rom.u8[a2 + 2];
    this.x30 = this.x_pos;
    this.x32 = this.x_pos;
    this.y34 = this.y_pos;
    this.dir2e = this.status & 0xff;
    this.range42 = 0x280;
    this.x44 = this.x_pos;
    this.sink3a = 0;
    this.v40 = 0;
    this.p36 = 0;
    this.flag3c = 0;
    const d0 = (this.subtype & 0xf) - 8;
    if (d0 >= 0) {
      if (d0 < 4) {
        if (this.core.oscWord(0x2c + d0 * 4) & 0x8000) this.dir2e ^= 1;
      } else {
        this.range42 = 0x380;
        this.x44 += 0x100;
      }
    }
    this.kind = this.subtype & 0xf;
  }
  // loc_244EA
  update() {
    const oldX = this.x_pos;
    this.move();
    if (this.onScreen) this.core.solidObjectTop(this, this.width_pixels, this.height_pixels + 1, oldX);
    if (u16((this.x44 & 0xff80) - this.core.coarseBack) > this.range42) return this.unload();
    this.display();
  }
  osc(o) { return this.core.oscByte(o); }
  move() {
    switch (this.kind) {
      case 0: return this.stationary();
      case 1: return this.horizontal(64, this.osc(0x0a));
      case 2: return this.horizontal(128, this.osc(0x1e));
      case 3: return this.vertical(64, this.osc(0x0a));
      case 4: return this.vertical(128, this.osc(0x1e));
      case 5: // Platform_DiagonalUp
        this.horizontal(128, this.osc(0x1e));
        return this.vertical(64, this.osc(0x1e) >> 1);
      case 6: // Platform_DiagonalDown
        this.horizontal(128, 128 - this.osc(0x1e));
        return this.vertical(64, this.osc(0x1e) >> 1);
      case 7: return this.rising();
      case 8: return this.square(16, this.osc(0x2a) >> 1, this.core.oscWord(0x2c));
      case 9: return this.square(48, this.osc(0x2e), this.core.oscWord(0x30));
      case 10: return this.square(80, this.osc(0x32), this.core.oscWord(0x34));
      case 11: return this.square(112, this.osc(0x36), this.core.oscWord(0x38));
      case 12: return this.horizontal256();
      default: return this.stationary();
    }
  }
  // Platform_Stationary: sinks a little while stood on
  stationary() {
    if (this.status & 0x18) { if (this.sink3a !== 0x40) this.sink3a += 4; }
    else if (this.sink3a) this.sink3a -= 4;
    const [sin] = this.core.sincos(this.sink3a);
    this.y_pos = this.y34 + (sin >> 6);
  }
  // sub_23ED4
  horizontal(d1, d0) {
    if (this.status & 1) d0 = d1 - d0;
    this.x_pos = this.x30 + d0;
  }
  // loc_23F02
  vertical(d1, d0) {
    if (this.status & 1) d0 = d1 - d0;
    this.y_pos = this.y34 - d0;
  }
  // Platform_Square32..224 (loc_241AE)
  square(d1, d0, d3) {
    if (d3 === 0) this.dir2e = (this.dir2e + 1) & 3;
    const d2 = this.dir2e & 3;
    if (d2 === 0) {
      this.x_pos = this.x30 + d0 - d1;
      this.y_pos = this.y34 - d1;
    } else if (d2 === 1) {
      this.y_pos = this.y34 - (d0 - (d1 - 1));
      this.x_pos = this.x30 + d1;
    } else if (d2 === 2) {
      this.x_pos = this.x30 - (d0 - (d1 - 1));
      this.y_pos = this.y34 + d1;
    } else {
      this.y_pos = this.y34 + d0 - d1;
      this.x_pos = this.x30 - d1;
    }
  }
  // Platform_Horizontal256
  horizontal256() {
    const d2 = 0x7f;
    if (!this.flag3c) {
      this.v40 = s16(this.v40 + 4);
      this.p36 = u16(this.p36 + this.v40);
      if (!(d2 > (this.p36 >> 8))) this.flag3c = 1;
    } else {
      this.v40 = s16(this.v40 - 4);
      this.p36 = u16(this.p36 + this.v40);
      if (!(d2 <= (this.p36 >> 8))) this.flag3c = 0;
    }
    let d0 = this.p36 >> 8;
    if (this.status & 1) d0 = d2 - d0;
    this.x_pos = this.x30 + d0;
  }
  // Platform_Rising (ceiling stop/crush check not ported: stops $80 above its start)
  rising() {
    if (!this.flag3c) {
      if (this.status & 0x18) { this.flag3c = 1; this.y_radius = 0xc; }
      return;
    }
    this.moveSprite2();
    if (!(u16(this.y34 - 0x80) >= u16(this.y_pos))) this.y_vel = s16(this.y_vel - 8);
    else { this.y_pos = this.y34 - 0x80; this.y_vel = 0; this.flag3c = 0; }
  }
}

// =============================================================================
// Obj_CollapsingPlatform: collapses into its mapping pieces after being stood on.
class CollapsingPlatform extends Obj {
  constructor(game, d) {
    super(game, d);
    const z = game.zone.id;
    this.mappings = game.maps(z === 0x001 ? MAP.CollapsingPlatform2 : MAP.CollapsingPlatform);
    this.art_tile = 0x4001; // make_art_tile($001,2,0)
    this.timers = romBytes(game, TBL.CollapseTimers, 30); // $30
    this.slope = romBytes(game, TBL.CollapseSlope, 0x40); // $3C
    this.width_pixels = 0x3c;
    this.height_pixels = 0x20;
    if ((z >> 8) === 5) {
      this.mappings = game.maps(MAP.ICZCollapsingBridge);
      this.timers = romBytes(game, TBL.ICZCollapseTimers, 32);
      this.slope = romBytes(game, TBL.ICZCollapseSlope, 0x30);
      this.width_pixels = 0x30;
      this.height_pixels = 0x30;
    }
    this.priority = 0x280;
    this.timer38 = 7;
    this.mapping_frame = this.subtype;
    this.status |= 0x80;
    this.touched3a = 0;
  }
  // loc_1DEB2
  update() {
    if (this.touched3a) {
      if (this.timer38 === 0) return this.createFragments();
      this.timer38--;
    }
    if (this.status & 0x18) this.touched3a = 1;
    this.sub_1DED4();
  }
  // sub_1DED4
  sub_1DED4() {
    this.core.solidObjectTopSloped2(this, this.width_pixels, this.slope, this.x_pos);
    this.spriteOnScreenTest();
  }
  // ObjPlatformCollapse_CreateFragments / ObjPlatformCollapse_SmashObject
  createFragments() {
    const g = this.game, core = this.core;
    this.mapping_frame += 2;
    const pieces = this.mappings[this.mapping_frame] || [];
    const me = new CollapseFragment(g, this.x_pos, this.y_pos, this, true);
    me.pieces = pieces.slice(0, 1);
    me.timer38 = this.timers[0];
    core.replace(this, me);
    me.respawn = -1;
    for (let k = 1; k < pieces.length; k++) {
      const f = new CollapseFragment(g, this.x_pos, this.y_pos, this, false);
      f.pieces = [pieces[k]];
      f.timer38 = this.timers[k] ?? 0;
      core.spawn(f);
    }
    me.display();
    // FragmentsDrawAndPlaySfx: the layout entry may load again later
    if (this.respawn >= 0) core.respawnTable[this.respawn] &= 0x7f;
    g.sfx('destroy'); // sfx_Collapse
  }
}

// loc_1DEEC
class CollapseFragment extends Obj {
  constructor(game, x, y, parent, first) {
    super(game, { x, y });
    this.render_flags = parent.render_flags | 0x20;
    this.status = first ? parent.status : 0;
    this.art_tile = parent.art_tile;
    this.priority = parent.priority;
    this.width_pixels = parent.width_pixels;
    this.height_pixels = parent.height_pixels;
    this.slope = parent.slope;
    this.touched3a = first ? 1 : 0;
  }
  update() {
    if (this.timer38 === 0) {
      // loc_1DF3C
      this.moveSprite();
      if (!this.onScreen) return this.delete();
      return this.display();
    }
    if (!this.touched3a) {
      this.timer38--;
      return this.display();
    }
    // loc_1DF00
    this.core.solidObjectTopSloped2(this, this.width_pixels, this.slope, this.x_pos);
    this.spriteOnScreenTest();
    if (--this.timer38 === 0) {
      // sub_1DF18 for Player_1 and Player_2
      this.core.players().forEach((p, i) => {
        const bit = i ? P2_STANDING : P1_STANDING;
        if (!(this.status & bit)) return;
        this.status &= ~bit;
        p.status &= ~(S_ONOBJ | S_PUSH);
        p.status |= S_INAIR;
        p.prev_anim = 1;
      });
    }
  }
}

// =============================================================================
// Obj_StarPost
class StarPost extends Obj {
  constructor(game, d) {
    super(game, d);
    // loc_2C436
    this.routine = 2;
    this.mappings = game.maps(MAP.StarPost);
    this.art_tile = 0x5ec; // make_art_tile(ArtTile_StarPost+8,0,0)
    this.width_pixels = 8;
    this.height_pixels = 0x28;
    this.priority = 0x280;
    if ((this.respawnByte & 1) || (this.core.lastStarPost & 0x7f) >= (this.subtype & 0x7f)) {
      this.respawnByte = this.respawnByte | 1;
      this.anim = 2;
    }
  }
  update() {
    if (this.routine === 2) this.sub_2C49E();
    // loc_2C56E
    this.animateSprite(ANI.Starpost);
    this.spriteOnScreenTest();
  }
  // sub_2C49E
  sub_2C49E() {
    const g = this.game, core = this.core, p = g.player;
    if ((core.lastStarPost & 0x7f) >= (this.subtype & 0x7f)) {
      if (this.anim === 0) this.anim = 2;
      return;
    }
    if (u16(p.x_pos - this.x_pos + 8) >= 0x10) return;
    if (u16(p.y_pos - this.y_pos + 0x40) >= 0x68) return;
    g.sfx('starpost');
    core.spawn(new StarPostBall(g, this));
    // (50+ rings: the bonus stage stars of sub_2C83E are not ported)
    this.anim = 1;
    // sub_2C5DA / Save_Level_Data
    core.lastStarPost = this.subtype;
    const pl = g.player;
    g.checkpoint = { x: this.x_pos, y: this.y_pos, time: g.time, starpost: this.subtype,
      top_solid_bit: pl.top_solid_bit, lrb_solid_bit: pl.lrb_solid_bit, highPriority: !!pl.highPriority };
    this.routine = 4;
    this.respawnByte = this.respawnByte | 1;
  }
}

// loc_2C580: the ball spinning around the starpost's head
class StarPostBall extends Obj {
  constructor(game, parent) {
    super(game, { x: parent.x_pos, y: parent.y_pos });
    this.cx = parent.x_pos; // $30
    this.cy = parent.y_pos - 0x14; // $32
    this.mappings = parent.mappings;
    this.art_tile = parent.art_tile;
    this.width_pixels = 8;
    this.height_pixels = 8;
    this.priority = 0x200;
    this.mapping_frame = 2;
    this.timer = 0x20; // $36
    this.parent = parent;
    this.angle = 0;
  }
  update() {
    if (--this.timer < 0) {
      const a1 = this.parent;
      if (a1.alive && a1 instanceof StarPost) { a1.anim = 2; a1.mapping_frame = 0; }
      return this.delete();
    }
    let d0 = this.angle;
    this.angle = (this.angle - 0x10) & 0xff;
    d0 = (d0 - 0x40) & 0xff;
    const [sin, cos] = this.core.sincos(d0);
    this.x_pos = ((cos * 0xc00) >> 16) + this.cx;
    this.y_pos = ((sin * 0xc00) >> 16) + this.cy;
    this.spriteOnScreenTest();
  }
}

// =============================================================================
// Obj_AIZForegroundPlant ($2B72E): foreground foliage. Subtype high nybble picks a
// parallax routine (loc_2B7AE..): pos = home + ((home - screen centre - camera) >> shift).
class Plant extends Obj {
  constructor(game, d) {
    super(game, d);
    this.mappings = game.maps(MAP.Plant);
    this.art_tile = 0xc333; // make_art_tile(ArtTile_AIZMisc1,2,1)
    this.mapping_frame = this.subtype & 1;
    this.shift = [0, 4, 3, 2, 1, 1, 1][(this.subtype >> 4) & 7] ?? 0;
    this.priority = 0;
    this.width_pixels = 0x20;
    this.height_pixels = 0x20;
  }
  update() { this.spriteOnScreenTest(); }
  draw(vdp, cx, cy) {
    let x = this.x_pos, y = this.y_pos;
    if (this.shift) {
      x += (this.x_pos - 160 - cx) >> this.shift;
      y += (this.y_pos - 112 - cy) >> this.shift;
    }
    const pieces = this.mappings && this.mappings[this.mapping_frame];
    if (pieces) vdp.addSprite(pieces, x - cx, y - cy, this.art_tile, this.xflip, this.yflip, 0);
  }
}

export { Projectile };

const TYPES = {
  1: Monitor, 2: PathSwap, 4: CollapsingPlatform, 5: Rock, 7: Spring, 8: Spikes,
  40: InvisibleBlock, 52: StarPost, 53: Plant, 81: FloatingPlatform,
  ...AIZ_TYPES, // objects-aiz.js: AIZ badniks and gimmicks
};

TYPES[84] = Bubbler; // Obj_Bubbler (water.js)

export function createObject(game, d) {
  const T = TYPES[d.id];
  return T ? new T(game, d) : null;
}
