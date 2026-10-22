// Level intro objects spawned by SpawnLevelMainSprites (loc_4DFE..loc_4EB6), ported from s3.asm.
//   HCZ1 / MGZ1 (loc_4DFE / loc_4E36): Sonic starts in the air with anim $1B
//   ICZ1: Obj_LevelIntroICZ1 ($38CE2) -> loc_38D7E / loc_38D94 / loc_38DD0 / loc_38E4C / loc_38EA4
//         (the snowboard Sonic jumps on), loc_389EC / loc_38A38 / loc_38A9E / loc_38BFC / loc_38C74
//         (Sonic riding the snowboard, Map_SonicSnowboard + DPLC_SonicSnowboard), loc_38EDE /
//         sub_38F22 / loc_38FA4 (snowboard dust), sub_38C7A / sub_38C8C (the DPLC loaders)
//   LBZ1: Obj_LevelIntro_PlayerLaunchFromGround ($39014) -> loc_3907E / loc_390D0 / sub_39144,
//         plus the Dust object's anim 4 (Obj_DashDust loc_1796C, the splash).
// Ctrl_1_locked / Ctrl_1_logical are modelled by game.ctrl1Locked / game.ctrl1Logical (Obj_Sonic
// copies the pad into Ctrl_1_logical only while the lock is clear); game.ctrl1 is the raw pad.
// Only Player 1 (Sonic) is handled: the Tails variants (Obj_LevelIntroICZ1Tails, Player_2 parts)
// are not ported.
import { Obj } from './objcore.js';
import { R } from './ram.js';

const S_INAIR = 2, S_ROLL = 4;
const ART_PLAYER_1 = 0x680, ART_S3_SNOWBOARD = 0x6a4, ART_SNOWBOARD_DUST = 0x6b8, ART_DASH_DUST = 0x7e0;

// ROM addresses (found from the instructions that reference them)
const Map_SonicSnowboard = 0x147e30; // move.l #Map_SonicSnowboard,mappings(a0) at $389F2
const DPLC_SonicSnowboard = 0x147f8a; // sub_38C8C
const ArtUnc_SonicSnowboard = 0x145010;
const Map_Snowboard = 0x148020; // Obj_LevelIntroICZ1
const DPLC_Snowboard = 0x148128; // sub_38C7A
const ArtUnc_Snowboard = 0x147850;
const Ani_SonicSnowboard = 0x38a74; // lea at loc_38A5C
const ICZSnowboard_Slope1 = 0x144e80; // lea at loc_38BFC
const ICZSnowboard_Slope2 = 0x144f48;
const Map_SnowboardDust = 0x38fd6; // sub_38F22
const Ani_SnowboardDust = 0x38fce; // loc_38FA4
const Map_DashDust = 0x17b40; // loc_178D4
const Ani_DashSplashDrown = 0x17b0c;
const DPLC_DashSplashDrown = 0x17c2e; // SplashDrown_Load_DPLC
const ArtUnc_SplashDrown = 0xc2280; // loc_1796C

const s16 = (v) => (v << 16) >> 16;
const byte_38AF0 = [4, 5, 2, 1, 1, 1, 1, 1, 0, 1, 2, 0, 1, 2, 0, 4];

// SpawnLevelMainSprites: the level-start part (no star post hit). Runs the intro object's first
// step right away, like the Process_Sprites call in the level init, then clears Ctrl_1_locked
// (loc_4AA2) as the original does after that call.
export function spawnLevelIntro(game) {
  if (game.checkpoint) return; // Last_star_post_hit
  const p = game.player, z = game.zone.id;
  let o = null;
  if (z === 0x100 || z === 0x200) {
    // loc_4DFE / loc_4E36
    p.anim = 0x1b;
    p.status |= S_INAIR;
  } else if (z === 0x500) {
    o = new LevelIntroICZ1(game);
  } else if (z === 0x600) {
    o = new LevelIntroPlayerLaunchFromGround(game);
  }
  if (o) {
    game.core.spawn(o);
    o.update();
  }
  game.ctrl1Locked = false;
}

// Random_Number ($1FAE) with RNG_seed in the emulated RAM. New seed = [random word : low word of
// the product]; returns d0: high word = high word of the old seed, low word = the new random word.
const RNG_seed = 0xfff636;
function randomNumber(game) {
  const m = game.ram;
  let d1 = m.l(RNG_seed) >>> 0 || 0x2a6d365a;
  const seed = d1;
  d1 = (((d1 << 2) >>> 0) + seed) >>> 0;
  d1 = (((d1 << 3) >>> 0) + seed) >>> 0;
  const r = (d1 + (d1 >>> 16)) & 0xffff; // move.w d1,d0 / swap d1 / add.w d1,d0
  m.setL(RNG_seed, ((r << 16) | (d1 & 0xffff)) | 0); // move.w d0,d1 / swap d1 -> [r : low word]
  return ((seed & 0xffff0000) | r) >>> 0;
}

// loc_38C9C / SplashDrown_Load_DPLC: copy the frame's tiles into VRAM if the frame changed.
// Entries: count-1 in the top nibble, source tile in the low 12 bits.
function loadDPLC(o, key, art, table, vramTile) {
  const f = o.mapping_frame;
  if (f === o[key]) return;
  o[key] = f;
  const rom = o.game.rom;
  const t = table + rom.u16(table + f * 2);
  const n = rom.u16(t);
  let v = vramTile * 32;
  for (let i = 0; i < n; i++) {
    const w = rom.u16(t + 2 + i * 2);
    const bytes = ((w >> 12) + 1) * 32;
    const src = art + (w & 0xfff) * 32;
    o.game.vdp.writeVram(v, rom.u8.subarray(src, src + bytes));
    v += bytes;
  }
}

function lockCtrl(game, logical = { held: {}, pressed: {} }) {
  game.ctrl1Locked = true;
  game.ctrl1Logical = logical;
}

// ============================================================================ LBZ1
// Obj_LevelIntro_PlayerLaunchFromGround: Sonic starts inside the ground at y $650, waits 30 frames
// with object_control 3, then is thrown up at y_vel -$B00 (anim $10, object_control 1, moved by
// sub_39144 with gravity $38) until he is above y $5C0.
export class LevelIntroPlayerLaunchFromGround extends Obj {
  constructor(game) {
    super(game, {});
    this.state = 0;
  }
  update() {
    const g = this.game, p = g.player;
    if (this.state === 0) {
      this.state = 1; // move.l #loc_3907E,(a0)
      lockCtrl(g);
      this.anim_frame_timer = 30;
      p.object_control = 3; // sub_39076
      return;
    }
    lockCtrl(g); // Ctrl_1_locked = 1, Ctrl_1_logical = 0
    if (this.state === 1) {
      // loc_3907E
      if (--this.anim_frame_timer !== 0) return;
      this.state = 2; // loc_3909E -> sub_390B2
      p.y_vel = -0xb00;
      p.status |= S_INAIR;
      p.jumping = 0;
      p.anim = 0x10;
      p.object_control = 1;
      return;
    }
    // loc_390D0
    if ((p.y_pos & 0xffff) >= 0x5c0) {
      // loc_3913A -> sub_39144
      p._x = (p._x + (p.x_vel << 8)) | 0;
      const yv = p.y_vel;
      p.y_vel = s16(yv + 0x38);
      p._y = (p._y + (yv << 8)) | 0;
      return;
    }
    p.object_control = 0;
    // move.w #4<<8,(Dust+anim) / move.w #$5C0,(Dust+y_pos)
    this.core.spawn(new DashDustSplash(g, p.x_pos, 0x5c0));
    g.sfx('skid'); // sfx_SandSplash (no dedicated synth sound)
    g.ctrl1Locked = false;
    this.delete();
  }
}

// Obj_DashDust with anim 4 (loc_1796C): the splash/dust cloud, ArtUnc_SplashDrown via
// SplashDrown_Load_DPLC. When the script switches to anim 0 the dust slot goes idle; here the
// object is removed then.
class DashDustSplash extends Obj {
  constructor(game, x, y) {
    super(game, { x, y });
    this.mappings = game.maps(Map_DashDust);
    this.art_tile = ART_DASH_DUST;
    this.priority = 0x80;
    this.width_pixels = 0x10;
    this.anim = 4;
    this.prev_anim = 0;
    this.dplcFrame = 0; // $34
  }
  update() {
    // tst.b prev_anim: x_pos / status / art priority were set at spawn
    this.animateSprite(Ani_DashSplashDrown);
    if (this.anim !== 4) return this.delete();
    loadDPLC(this, 'dplcFrame', ArtUnc_SplashDrown, DPLC_DashSplashDrown, ART_DASH_DUST);
    this.display();
  }
}

// ============================================================================ ICZ1
// Obj_LevelIntroICZ1: the snowboard lying at ($C0,$170). Sonic rolls in at x_vel $800, jumps at
// x $C0 while the board flies up, lands on it at x $184; then the snowboarding Sonic object
// (SonicSnowboard) takes over until the crash at x >= $3880.
export class LevelIntroICZ1 extends Obj {
  constructor(game) {
    super(game, {});
    this.state = 0;
    this.dplcFrame = 0; // $32
  }
  update() {
    const g = this.game, p = g.player;
    switch (this.state) {
      case 0: // Obj_LevelIntroICZ1
        p.x_vel = 0x800;
        p.y_vel = 0x280;
        p.ground_vel = 0x800;
        p.status |= S_INAIR;
        p.jumping = 0;
        p.y_radius = 0xe;
        p.x_radius = 7;
        p.anim = 2;
        p.status |= S_ROLL;
        lockCtrl(g);
        p.mapping_frame = 0;
        p.object_control = 3;
        this.anim_frame_timer = 30;
        this.mappings = g.maps(Map_Snowboard);
        this.art_tile = ART_S3_SNOWBOARD;
        this.priority = 0x80;
        this.width_pixels = 0x20;
        this.height_pixels = 0x20;
        this.render_flags = 4;
        this.mapping_frame = 8;
        this.x_pos = 0xc0;
        this.y_pos = 0x170;
        this.state = 1;
      // fallthrough
      case 1: // loc_38D7E
        if (--this.anim_frame_timer === 0) {
          p.object_control = 0;
          this.state = 2;
        }
      // fallthrough
      case 2: // loc_38D94
        lockCtrl(g);
        if ((p.x_pos & 0xffff) >= 0xc0) {
          this.y_vel = -0x600;
          p.x_vel = 0x400;
          p.y_vel = -0x800;
          this.state = 3;
        }
        return this.drawBoard();
      case 3: { // loc_38DD0
        this.x_pos = p.x_pos;
        this.anim_frame_timer = (this.anim_frame_timer - 1) & 0xff;
        if (this.anim_frame_timer & 0x80) {
          this.anim_frame_timer = 1;
          if (++this.mapping_frame >= 9) this.mapping_frame = 1;
        }
        // loc_38DF8
        if ((p.x_pos & 0xffff) < 0x184) {
          this.moveSprite2(); // loc_38E3C
          this.y_vel = s16(this.y_vel + 0x28);
          return this.drawBoard();
        }
        p.mapping_frame = 0;
        p.object_control = 2;
        const s = new SonicSnowboard(g);
        s.x_pos = p.x_pos; s.y_pos = p.y_pos; s.x_vel = p.x_vel; s.y_vel = p.y_vel;
        this.core.spawn(s);
        this.state = 4;
        return; // not drawn this frame
      }
      case 4: { // loc_38E4C: board hidden under Sonic; only A/B/C/Start reach Sonic
        this.x_pos = p.x_pos;
        this.y_pos = p.y_pos;
        const pad = g.ctrl1 ?? {};
        const pick = (o = {}) => ({ a: !!o.a, b: !!o.b, c: !!o.c, start: !!o.start });
        g.ctrl1Logical = { held: pick(pad.held), pressed: pick(pad.pressed) };
        if (p.object_control) return;
        g.ctrl1Locked = false;
        this.state = 5;
        this.y_pos = this.y_pos + 0x14;
        this.x_vel = -0x200;
        this.y_vel = -0x400;
        this.render_flags = 0x84;
        this.mapping_frame = 1;
        this.anim_frame_timer = 1;
        return this.drawBoard();
      }
      default: // loc_38EA4: the board flies off after the crash
        if (!(this.render_flags & 0x80)) return this.delete();
        this.anim_frame_timer = (this.anim_frame_timer - 1) & 0xff;
        if (this.anim_frame_timer & 0x80) {
          this.anim_frame_timer = 1;
          if (++this.mapping_frame >= 9) this.mapping_frame = 1;
        }
        this.moveSprite2();
        this.y_vel = s16(this.y_vel + 0x28);
        return this.drawBoard();
    }
  }
  // loc_38DC4: sub_38C7A + Draw_Sprite
  drawBoard() {
    loadDPLC(this, 'dplcFrame', ArtUnc_Snowboard, DPLC_Snowboard, ART_S3_SNOWBOARD);
    this.display();
  }
}

// loc_389EC: Sonic on the snowboard (drawn with Map_SonicSnowboard into Sonic's own VRAM slot
// while the player object shows the empty frame 0 with object_control 2).
class SonicSnowboard extends Obj {
  constructor(game) {
    super(game, {});
    this.art_tile = ART_PLAYER_1;
    this.mappings = game.maps(Map_SonicSnowboard);
    this.priority = 0x100;
    this.width_pixels = 0x20;
    this.height_pixels = 0x20;
    this.render_flags = 4;
    this.mapping_frame = 6;
    this.anim = 0; // move.w #1,anim(a0): anim 0, prev_anim 1
    this.prev_anim = 1;
    this.dplcFrame = 0; // $32
    this.slope = 0; // $36
    this.slopePos = 0; // $34
    this.state = 0;
    this.core.spawn(new SnowboardDustSpawner(game, this)); // loc_38EDE
  }
  update() {
    const g = this.game, p = g.player;
    if (this.state === 0) {
      // loc_38A38: in the air until Sonic lands on the ground
      this.x_pos = p.x_pos;
      this.y_pos = p.y_pos;
      if (!(p.status & S_INAIR)) {
        this.anim = 1;
        this.state = 1;
      }
      this.animateSprite(Ani_SonicSnowboard);
      return this.draw2();
    }
    if (this.state === 2) return this.slopeRide();
    if (this.state === 3) return this.delete(); // loc_38C74
    // loc_38A9E
    this.x_pos = p.x_pos;
    this.y_pos = p.y_pos;
    this.anim = byte_38AF0[((p.angle + 5) & 0xff) >> 4];
    if (p.status & S_INAIR) {
      this.anim = 0;
      if (p.x_vel !== 0 && p.x_vel >= 0x1000) p.x_vel = 0x1000;
      if (p.y_vel < -0x200) p.y_vel = -0x200;
    } else {
      // loc_38B00
      if ((g.ram.uw(R.Level_frame_counter) & 0xf) === 0) { /* sfx_SlideSkidQuiet (not synthesized) */ }
      const x = p.x_pos & 0xffff;
      let d0 = -1;
      if (x >= 0x1310) {
        if (x < 0x1330) d0 = 1;
        else if (x >= 0x2210 && x < 0x2230) d0 = 2;
      }
      if (d0 > 0 && d0 !== this.slope) {
        // loc_38B36: follow the loop path table
        this.slope = d0;
        p.object_control = 3;
        this.state = 2;
        this.slopePos = 0;
      }
    }
    // loc_38B52
    this.animateSprite(Ani_SonicSnowboard);
    if (this.mapping_frame === 8 && p.ground_vel >= 0x1000) p.ground_vel = s16(p.ground_vel - 8);
    else if (p.ground_vel < 0x1000) p.ground_vel = 0x1000;
    // loc_38B84: the end of the snowboard run (crash into the wall)
    if ((p.x_pos & 0xffff) >= 0x3880 && p.x_vel === 0) {
      this.state = 3;
      p.status |= S_INAIR;
      p.x_vel = -0x200;
      p.y_vel = -0x400;
      p.anim = 0x19;
      p.object_control = 0;
      g.ram.setW(R.Screen_shake_flag, 0x14);
      g.sfx('destroy'); // sfx_Crash
    }
    // loc_38BCA
    if (!(p.status & S_INAIR) && this.mapping_frame !== this.dplcFrame
      && (this.mapping_frame === 7 || this.mapping_frame === 8)) g.sfx('skid'); // sfx_GroundSlide
    this.draw2();
  }
  // loc_38BFC: position, height and frame come from ICZSnowboard_Slope1/2 (6 bytes per frame)
  slopeRide() {
    const g = this.game, p = g.player, rom = g.rom;
    const a = (this.slope === 1 ? ICZSnowboard_Slope1 : ICZSnowboard_Slope2) + this.slopePos;
    this.slopePos += 6;
    const x = rom.u16(a), y = rom.u16(a + 2);
    this.x_pos = x; p.x_pos = x;
    this.y_pos = y; p.y_pos = y;
    this.mapping_frame = rom.u8[a + 5];
    if (rom.u16(a + 6) & 0x8000) {
      p.top_solid_bit = 0xe;
      p.lrb_solid_bit = 0xf;
      p.object_control = 2;
      this.state = 1;
    }
    if (this.mapping_frame !== this.dplcFrame) g.sfx('skid'); // sfx_GroundSlide
    this.draw2();
  }
  // sub_38C8C + Draw_Sprite
  draw2() {
    loadDPLC(this, 'dplcFrame', ArtUnc_SonicSnowboard, DPLC_SonicSnowboard, ART_PLAYER_1);
    this.display();
  }
}

// loc_38EDE / loc_38EE4: spawns snow dust behind the board while Sonic is on the ground
// (2 per frame, 8 on the crouched frames 7/8); deleted when object_control is cleared.
class SnowboardDustSpawner extends Obj {
  constructor(game, parent) {
    super(game, {});
    this.parent = parent; // $30
  }
  update() {
    const p = this.game.player;
    if (!p.object_control) return this.delete();
    if (p.status & S_INAIR) return;
    const f = this.parent.mapping_frame;
    const n = f === 7 || f === 8 ? 8 : 2;
    for (let i = 0; i < n; i++) this.spawnDust(p); // sub_38F22
  }
  spawnDust(p) {
    const g = this.game;
    const d = new SnowboardDust(g);
    d.x_pos = p.x_pos;
    d.y_pos = s16(p.y_pos + 0x14);
    const r = randomNumber(g);
    d.y_vel = s16(-(r & 0x1ff)); // the subi #$200 before it is overwritten in the original
    d.x_vel = -0x100;
    d.x_pos = s16(d.x_pos - (r & 0xf));
    d.y_pos = s16(d.y_pos - ((r >>> 16) & 0xf));
    this.core.spawn(d);
  }
}

// loc_38FA4
class SnowboardDust extends Obj {
  constructor(game) {
    super(game, {});
    this.art_tile = ART_SNOWBOARD_DUST;
    this.mappings = game.maps(Map_SnowboardDust);
    this.priority = 0x100;
    this.width_pixels = 4;
    this.height_pixels = 4;
    this.render_flags = 0x84;
    this.anim = 0; // move.w #1,anim(a1)
    this.prev_anim = 1;
  }
  update() {
    if (!(this.render_flags & 0x80)) return this.delete();
    this.moveSprite2();
    this.animateSprite(Ani_SnowboardDust);
    if (this.routine !== 0) return this.delete();
    this.display();
  }
}
