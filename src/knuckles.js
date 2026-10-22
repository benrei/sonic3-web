// Knuckles (Obj_Knuckles, character_id 2), ported from the Sonic 3 & Knuckles 68000 code
// (sonic3k.asm, skdisasm). Needs the S3&K lock-on ROM: Knuckles' code, art, mappings,
// animations, palette, start positions and the S3&K object/ring layouts all live in the
// S&K half ($000000-$1FFFFF of the 4 MB image, read through rom.full / rom.sku*).
//
// `Knuckles extends Player` (player.js = the Sonic 3 Obj_Sonic port). The routines that
// Knuckles shares with Sonic in S3&K (SonicKnux_Spindash, SonicKnux_Roll,
// SonicKnux_DoLevelCollision, Player_AnglePos, Player_SlopeResist/Repel, Player_LevelBound,
// Player_JumpAngle, HurtCharacter, Kill_Character, Knuckles_Water = Sonic_Water ...) are
// inherited; everything below is the Knuckles-specific code:
//   Knuckles_Control / Knux_Modes   (Knux_Stand_Path, Knux_Stand_Freespace -> Knux_Glide_Freespace,
//                                    Knux_Spin_Path, Knux_Spin_Freespace)
//   Knux_Jump ($600 / $300 underwater), Knux_JumpHeight, Knux_Test_For_Glide
//   Knux_InputAcceleration_Path (balance turns Knuckles around, down is checked before up),
//   Knux_RollSpeed, loc_17382 (wall in front)
//   Knuckles_Move_Glide, Knuckles_Glide, Knuckles_Set_Gliding_Animation,
//   Knux_Gliding_HitFloor, Knuckles_Gliding_HitWall, Knuckles_Fall_From_Glide,
//   Knuckles_Sliding, Knuckles_Wall_Climb (+ GetDistanceFromWall), Knuckles_ClimbUp,
//   Knuckles_LetGoOfWall, Knuckles_DoLedgeClimbingAnimation, Knuckles_Climb_Ledge,
//   Knux_DoLevelCollision_CheckRet (Gliding_collision_flags), Knux_TouchFloor,
//   Animate_Knuckles (AniKnuckles), Knuckles_Load_PLC (PLC_Knuckles / ArtUnc_Knux).
// Knuckles has no insta-shield and no shield abilities (the shields only protect him).
// Not ported: Super/Hyper Knuckles (Knux_Transform, needs the emeralds), reverse gravity,
// Disable_wall_grab (only set by S&K zones), the skid/slide dust (Dust routine 6), debug mode.
//
// applyKnucklesLevel() holds what the S3&K engine loads differently for Knuckles in the
// Sonic 3 zones (Knux_Start_Locations, Pal_Knuckles, the S3&K object/ring layouts,
// Adjust_AIZ1Chunks2 / Adjust_AIZ2Layout). The level art, blocks, chunks, collision and
// FG/BG layouts are the same Sonic 3 data in both games. Knuckles-specific code elsewhere:
// camera.js (AIZ1 line 3 colour 15 = word_4FAEA, AIZ2_KnuxResize1-5, CheckLevelForWater:
// no AIZ2 water when AIZ2 is loaded directly, DynamicWaterHeight_HCZ2/LBZ2 Knuckles tables),
// intros.js (HCZ1 glide-fall pose, no ICZ1 snowboard intro), zones/lbz.js
// (LBZ1_KnuxLevelSizeAdjust, LBZ1_ModEndingLayout without the barrier), objcore.js /
// objects.js / objects-aiz.js (gliding/sliding attacks enemies and monitors, rocks and
// walls Knuckles breaks by touching them, the stand-to-break rock $xF, glide drop).
// Not ported (Knuckles side of the S3 zones): the bosses / cutscene objects of his route
// (Obj_LBZMinibossBoxKnux, Obj_LBZFinalBossKnux, Obj_MGZEndBossKnux, his HCZ/ICZ/CNZ boss
// variants: the act ends when he reaches them, see actEndX), Obj_ICZTeleporter /
// Obj_CNZTeleporter, Obj_LevelIntro_PlayerRun (CNZ1 run-in) and the CNZ1 +$B0 start camera,
// ICZ1BGE snow-pile skip, LBZ1_BackgroundInit's Death Egg removal, the LBZ1 boss-arena
// chunk swap for Knuckles, AIZ2 bombership art / PalID_AIZBoss, the S3&K versions of
// objects whose Knuckles checks are in code we don't have (CNZ cylinder at $17E0, LBZ cup
// elevator bit 6, ICZ breakable wall / crushing column / freezer).
import { Player } from './player.js';
import { ART_TILE } from './rom.js';
import { registerCharacter } from './characters.js';
import { nemesis } from './decomp.js';

// S3&K addresses (sk.symbols.json; absolute in the 4 MB image)
export const SK = {
  Map_Knuckles: 0x14a8d6,
  PLC_Knuckles: 0x14bd0a,
  ArtUnc_Knux: 0x1200e0,
  AniKnuckles: 0x17ef4,
  Knux_Start_Locations: 0x1e3cd8,
  Pal_Knuckles: 0xa8afc, // PalPoint entry 5 (PalID_Knuckles): $A8AFC -> $FC00, 16 colours
  Pal_WaterKnux: 0x7a4a, // 3 colours (water palette line 0, colours 2-4) per zone
  SpriteLocPtrs: 0x1e3d98,
  RingLocPtrs: 0x1e3e58,
  word_4FAE4: 0x4fae4, // Knuckles' AIZ1 palette line 4 colours 8-11 ($EE4 $EA6 $E62, word_4FAEA = $E40)
  ArtNem_KnucklesLifeIcon: 0x190e4c, // PLC_05 -> ArtTile_PlayerLifeIcon
};
const ANIM_COUNT = 0x25;

const S_FACING = 1, S_INAIR = 2, S_ROLL = 4, S_ONOBJ = 8, S_ROLLJUMP = 0x10, S_PUSH = 0x20, S_UNDERWATER = 0x40;
const GCF_INAIR = 2, GCF_PUSH = 0x20; // Gliding_collision_flags bits (Status_InAir / Status_Push)

const s8 = (v) => (v << 24) >> 24;
const s16 = (v) => (v << 16) >> 16;
const u16 = (v) => v & 0xffff;

// RawAni_Knuckles_GlideTurn
const GLIDE_TURN = [0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc3, 0xc2, 0xc1];
// Knuckles_ClimbLedge_Frames: mapping_frame, x_pos, y_pos, anim_frame_timer
const CLIMB_LEDGE_FRAMES = [
  [0xbd, 3, -3, 6],
  [0xbe, 8, -10, 6],
  [0xbf, -8, -12, 6],
  [0xd2, 8, -5, 6],
];
const CLIMB_LEDGE_END = CLIMB_LEDGE_FRAMES.length * 4;

export class Knuckles extends Player {
  constructor(rom, level, game = null) {
    if (!rom.sk) throw new Error('Knuckles needs the Sonic 3 & Knuckles ROM');
    applyKnucklesLevel(level, rom, game);
    super(rom, level);
    this.game = game;
    this.character_id = 2; // move.b #2,character_id(a0)
    // Animate_Knuckles: AniKnuckles scripts (S&K half)
    this.animAddrs = [];
    for (let i = 0; i < ANIM_COUNT; i++) this.animAddrs.push(SK.AniKnuckles + rom.sku16(SK.AniKnuckles + i * 2));
    this.mappings = parseMappings(rom, SK.Map_Knuckles);
    this.priority = 0x100;
    this._plcFrame = -1; // Player_prev_frame
  }

  _reset(x, y) {
    super._reset(x, y);
    this.double_jump_property = 0; // glide angle / climb animation counter
    this.glideFlags = 0; // Gliding_collision_flags
  }

  // Knuckles has no insta-shield (TouchResponse only checks it for character_id 0)
  get instaShieldActive() { return false; }

  // ================================================================ Knuckles_Control
  _control() {
    if (this.object_control & 1) {
      this.double_jump_flag = 0;
    } else {
      switch (this.status & 6) { // Knux_Modes
        case 0: this._mdNormal(); break; // Knux_Stand_Path
        case 2: this._mdAir(); break; // Knux_Stand_Freespace
        case 4: this._mdRoll(); break; // Knux_Spin_Path
        case 6: this._mdJump(); break; // Knux_Spin_Freespace
      }
    }
    if (this.routine !== 2) this.visible = true;
    else this._display(); // Knuckles_Display
    this._water(); // Knuckles_Water (same speeds as Sonic_Water)
    this.next_tilt = this.primaryAngle;
    this.tilt = this.secondaryAngle;
    if (!(this.object_control & 2)) this._animate(); // Animate_Knuckles (+ Knuckles_Load_PLC in drawSelf)
  }

  // Knux_Stand_Freespace
  _mdAir() {
    if (this.double_jump_flag) return this._glideFreespace();
    super._mdAir(); // Knux_JumpHeight, Knux_ChgJumpDir, LevelBound, MoveSprite, JumpAngle, DoLevelCollision
  }

  // Knux_Spin_Freespace: like Knux_Stand_Freespace without the glide check
  _mdJump() {
    Player.prototype._mdAir.call(this);
  }

  // Knux_Glide_Freespace
  _glideFreespace() {
    this._moveGlide();
    this._levelBound();
    if (this.routine !== 2) return;
    this._moveSprite2(); // MoveSprite_TestGravity2
    this._glide();
  }

  // ---------------------------------------------------------------- Knux_Jump
  _jump() {
    if (!this.pressed.jump) return false;
    const room = this._calcRoomOverHead((this.angle + 0x80) & 0xff);
    if (room < 6) return false;
    const d2 = this.status & S_UNDERWATER ? 0x300 : 0x600; // Knuckles' lower jump
    const sin = this._sincos((this.angle - 0x40) & 0xff);
    this.x_vel = s16(this.x_vel + (Math.imul(this._cos, d2) >> 8));
    this.y_vel = s16(this.y_vel + (Math.imul(sin, d2) >> 8));
    this.status |= S_INAIR;
    this.status &= ~S_PUSH;
    this.jumping = 1;
    this.stick_to_convex = 0;
    this.onSound?.('jump'); // sfx_Jump
    this.y_radius = this.default_y_radius;
    this.x_radius = this.default_x_radius;
    if (this.status & S_ROLL) {
      this.status |= S_ROLLJUMP; // loc_177E2
      return true;
    }
    this.y_radius = 0xe;
    this.x_radius = 7;
    this.anim = 2;
    this.status |= S_ROLL;
    this._addY(-s8(this.y_radius - this.default_y_radius));
    return true;
  }

  // Knux_JumpHeight
  _jumpHeight() {
    if (this.jumping) {
      const d1 = this.status & S_UNDERWATER ? -0x200 : -0x400;
      if (d1 <= this.y_vel) return this._testForGlide();
      if (!this.held.jump) this.y_vel = d1;
      return;
    }
    // loc_17818
    if (this.spin_dash_flag) return;
    if (this.y_vel < -0xfc0) this.y_vel = -0xfc0;
  }

  // Knux_Test_For_Glide (the Super/Hyper transformation branch needs 7 emeralds: not ported)
  _testForGlide() {
    if (this.double_jump_flag) return;
    if (!this.pressed.jump) return;
    // loc_1786C
    this.status &= ~S_ROLL;
    this.y_radius = 0xa;
    this.x_radius = 0xa;
    this.status &= ~S_ROLLJUMP;
    this.double_jump_flag = 1;
    this.y_vel = s16(this.y_vel + 0x200);
    if (this.y_vel < 0) this.y_vel = 0;
    let d0 = 0x400, d1 = 0;
    this.ground_vel = d0;
    if (this.status & S_FACING) { d0 = -d0; d1 = 0x80; }
    this.x_vel = d0;
    this.double_jump_property = d1;
    this.angle = 0; // move.w #0,angle(a0): angle and flip_angle
    this.flip_angle = 0;
    this.glideFlags = GCF_INAIR;
    this._setGlidingAnimation();
  }

  // ---------------------------------------------------------------- Knux_InputAcceleration_Path
  _move() {
    const d6 = this.max_speed, d4 = this.deceleration, d5 = this.acceleration;
    if (!(this.status_secondary & 0x80)) {
      let lbl;
      if (this.move_lock !== 0) {
        lbl = 0x1731c;
      } else {
        if (this.held.left) this._moveLeft(d4, d5, d6); // sub_17428 (same as Sonic's)
        if (this.held.right) this._moveRight(d4, d5, d6); // sub_174B4
        if (((this.angle + 0x20) & 0xc0) !== 0 || this.ground_vel !== 0) {
          lbl = 0x1731c;
        } else {
          this.status &= ~S_PUSH;
          this.anim = 5;
          lbl = this._knuxBalance();
        }
      }
      if (lbl === 0x1731c) {
        this.scroll_delay_counter = 0;
        lbl = 0x17322;
      }
      if (lbl === 0x17322) this._recenterCamera();
      // loc_1732E: friction when neither left nor right is held
      if (!this.held.left && !this.held.right && this.ground_vel !== 0) {
        const gv = this.ground_vel;
        if (gv > 0) this.ground_vel = gv - d5 < 0 ? 0 : gv - d5;
        else this.ground_vel = u16(gv) + d5 > 0xffff ? 0 : gv + d5;
      }
    }
    // loc_17364
    const sin = this._sincos(this.angle);
    this.x_vel = s16(Math.imul(this._cos, this.ground_vel) >> 8);
    this.y_vel = s16(Math.imul(sin, this.ground_vel) >> 8);
    this._wallInFront();
  }

  // Knuckles' balancing: one balance animation; he turns to face away from the edge.
  // Returns the label Knux_InputAcceleration_Path continues at.
  _knuxBalance() {
    const turn = (facingLeft) => {
      if (facingLeft) this.status |= S_FACING; else this.status &= ~S_FACING;
      this.anim_frame_timer = 0;
      this.anim_frame = 4;
      this.anim = 6;
      this.prev_anim = 6;
    };
    if (this.status & S_ONOBJ) {
      const o = this.interact;
      if (!o || (o.status & 0x80)) return this._knuxLookUpDown();
      let d1 = o.width_pixels;
      const d2 = d1 * 2 - 2;
      d1 = s16(d1 + this.x_pos - o.x_pos);
      if (d1 < 2) { // loc_171FE
        if (this.status & S_FACING) this.anim = 6; else turn(true);
        return 0x1731c;
      }
      if (d1 >= d2) { // loc_171D0
        if (!(this.status & S_FACING)) this.anim = 6; else turn(false);
        return 0x1731c;
      }
      return this._knuxLookUpDown();
    }
    // loc_1722C (ChooseChkFloorEdge)
    if (this._chkFloorEdge(this.x_pos) < 0xc) return this._knuxLookUpDown();
    if (this.next_tilt === 3) {
      if (!(this.status & S_FACING)) this.anim = 6; else turn(false); // loc_17256
      return 0x1731c;
    }
    if (this.tilt !== 3) return this._knuxLookUpDown();
    if (this.status & S_FACING) this.anim = 6; else turn(true); // loc_1728C
    return 0x1731c;
  }

  // loc_172A8: duck (checked first) / look up
  _knuxLookUpDown() {
    if (this.held.down) {
      this.anim = 8;
      this.scroll_delay_counter = (this.scroll_delay_counter + 1) & 0xff;
      if (this.scroll_delay_counter < 120) return 0x17322;
      this.scroll_delay_counter = 120;
      if (this.distance_from_top !== 8) this.distance_from_top -= 2;
      return 0x1732e;
    }
    if (this.held.up) {
      this.anim = 7;
      this.scroll_delay_counter = (this.scroll_delay_counter + 1) & 0xff;
      if (this.scroll_delay_counter < 120) return 0x17322;
      this.scroll_delay_counter = 120;
      if (this.distance_from_top !== 0xc8) this.distance_from_top += 2;
      return 0x1732e;
    }
    return 0x1731c;
  }

  // loc_17382: stop at walls in front (S3&K version of the angle test)
  _wallInFront() {
    if (this.object_control & 0x40) return;
    if ((this.angle & 0x3f) !== 0 && ((this.angle + 0x40) & 0x80)) return;
    if (this.ground_vel === 0) return;
    const d1 = this.ground_vel < 0 ? 0x40 : -0x40;
    const d0 = (this.angle + d1) & 0xff;
    let dist = this._calcRoomInFront(d0); // sub_F61C
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

  // ---------------------------------------------------------------- Knux_RollSpeed
  _rollSpeed() {
    const d5 = this.acceleration >> 1;
    const d4 = 0x20;
    if (!(this.spin_dash_flag & 0x80) && !(this.status_secondary & 0x80)) {
      if (this.move_lock === 0) {
        if (this.held.left) { // sub_1763A
          const gv = this.ground_vel;
          if (gv <= 0) {
            this.status |= S_FACING;
            this.anim = 2;
          } else this.ground_vel = u16(gv) < d4 ? -0x80 : gv - d4;
        }
        if (this.held.right) { // sub_1765E
          const gv = this.ground_vel;
          if (gv >= 0) {
            this.status &= ~S_FACING;
            this.anim = 2;
          } else this.ground_vel = u16(gv) + d4 > 0xffff ? 0x80 : gv + d4;
        }
      }
      // loc_17580: rolling friction
      const gv = this.ground_vel;
      if (gv > 0) this.ground_vel = u16(gv) < d5 ? 0 : gv - d5;
      else if (gv < 0) this.ground_vel = u16(gv) + d5 > 0xffff ? 0 : gv + d5;
      // loc_175A2: unroll below $80
      if (Math.abs(this.ground_vel) < 0x80) {
        if (!this.spin_dash_flag) {
          this.status &= ~S_ROLL;
          const d0 = this.y_radius;
          this.y_radius = this.default_y_radius;
          this.x_radius = this.default_x_radius;
          this.anim = 5;
          this._addY(s8(d0 - this.default_y_radius));
        } else {
          this.ground_vel = this.status & S_FACING ? -0x400 : 0x400; // loc_175E6
        }
      }
    }
    // loc_175F8
    this._recenterCamera();
    const sin = this._sincos(this.angle);
    this.y_vel = s16(Math.imul(sin, this.ground_vel) >> 8);
    let d1 = s16(Math.imul(this._cos, this.ground_vel) >> 8);
    if (d1 > 0x1000) d1 = 0x1000;
    if (d1 < -0x1000) d1 = -0x1000;
    this.x_vel = d1;
    this._wallInFront(); // bra.w loc_17382
  }

  // ---------------------------------------------------------------- Knux_TouchFloor
  _touchFloor() {
    const d0 = this.y_radius;
    this.y_radius = this.default_y_radius;
    this.x_radius = this.default_x_radius;
    if (this.status & S_ROLL) {
      this.status &= ~S_ROLL;
      this.anim = 0;
      let d = s8(d0 - this.default_y_radius);
      if ((this.angle + 0x40) & 0x80) d = -d; // on walls / ceilings the offset is reversed
      this._addY(d);
    }
    this._touchFloorFlags();
    if (this.anim >= 0x20) this.anim = 0; // leave the glide / climb animations
  }

  // loc_121D8 / loc_17B6A (Player_TouchFloor_Check_Spindash lands here while spindashing).
  // No bubble shield bounce: that's only for character_id 0.
  _touchFloorFlags() {
    this.status &= ~(S_INAIR | S_PUSH | S_ROLLJUMP);
    this.jumping = 0;
    this.flip_angle = 0;
    this.flip_type = 0;
    this.flips_remaining = 0;
    this.scroll_delay_counter = 0;
    this.double_jump_flag = 0;
  }

  // Diagonal / horizontal springs (sub_23190, sub_233CA) also end a glide or a climb
  springLaunch(xVel, yVel) {
    if (this.routine !== 2) return;
    super.springLaunch(xVel, yVel);
    if (xVel) this.double_jump_flag = 0;
  }

  // ================================================================ gliding
  // Knuckles_Set_Gliding_Animation
  _setGlidingAnimation() {
    this.anim_frame_timer = 0x20;
    this.anim_frame = 0;
    this.anim = 0x20;
    this.prev_anim = 0x20;
    this.status &= ~(S_PUSH | S_FACING);
    const d0 = ((this.double_jump_property + 0x10) & 0xff) >> 5;
    const d1 = GLIDE_TURN[d0];
    this.mapping_frame = d1;
    if (d1 === 0xc4) {
      this.status |= S_FACING;
      this.mapping_frame = 0xc0;
    }
  }

  // Knuckles_Move_Glide
  _moveGlide() {
    if (this.double_jump_flag === 1) {
      let d0 = u16(this.ground_vel);
      if (d0 < 0x400) d0 += 8;
      else if (d0 < 0x1800 && (this.double_jump_property & 0x7f) === 0) d0 += 4; // not while turning
      this.ground_vel = s16(d0);
      // turning: double_jump_property is the glide direction (0 = right, $80 = left)
      let p = this.double_jump_property & 0xff;
      let set = false;
      if (this.held.left && p !== 0x80) {
        if (p & 0x80) p = -p & 0xff;
        p = (p + 2) & 0xff;
        set = true;
      }
      if (!set && this.held.right && p !== 0) {
        if (!(p & 0x80)) p = -p & 0xff;
        p = (p + 2) & 0xff;
        set = true;
      }
      if (!set && (p & 0x7f)) p = (p + 2) & 0xff; // finish a turn that was started
      this.double_jump_property = p;
      this._sincos(p);
      this.x_vel = s16(Math.imul(this._cos, this.ground_vel) >> 8);
      // parachute effect: fall at about $80 at most
      if (this.y_vel >= 0x80) this.y_vel = s16(this.y_vel - 0x20);
      else this.y_vel = s16(this.y_vel + 0x20);
      // above the level's top boundary: kill the horizontal speed
      const minY = this.bounds.minY;
      if (minY !== -0x100 && s16(minY + 0x10) > this.y_pos) {
        this.x_vel >>= 1;
        this.ground_vel >>= 1;
      }
    }
    this._recenterCamera(); // .doNotKillspeed
  }

  // Knuckles_Glide: double_jump_flag 1 glide, 2 fall, 3 slide, 4 climb, 5 climb over a ledge
  _glide() {
    switch (this.double_jump_flag) {
      case 0: return;
      case 2: return this._fallFromGlide();
      case 3: return this._sliding();
      case 4: return this._wallClimb();
      case 5: return this._climbLedge();
      default: break;
    }
    this._knuxLevelCollision();
    if (!(this.glideFlags & GCF_INAIR)) return this._glideHitFloor();
    if (this.glideFlags & GCF_PUSH) return this._glideHitWall();
    if (!this.held.jump) {
      // let go of the button: fall
      this.double_jump_flag = 2;
      this.anim = 0x21;
      this._faceXVel();
      this.x_vel = (this.x_vel >> 1) >> 1;
      this.y_radius = this.default_y_radius;
      this.x_radius = this.default_x_radius;
      return;
    }
    this._setGlidingAnimation(); // .continueGliding
  }

  _faceXVel() {
    this.status &= ~S_FACING;
    if (this.x_vel < 0) this.status |= S_FACING;
  }

  // Knux_Gliding_HitFloor
  _glideHitFloor() {
    this._faceXVel();
    if (((this.angle + 0x20) & 0xc0) !== 0) {
      this.x_vel = this.ground_vel;
      this.y_vel = 0;
      return this._touchFloor();
    }
    // loc_1693E: slide on his belly
    this.double_jump_flag = 3;
    this.mapping_frame = 0xcc;
    this.anim_frame_timer = 0x7f;
    this.anim_frame = 0;
    // (dust clouds: Dust routine 6 / frame $15 - not ported)
  }

  // Knuckles_Gliding_HitWall: grab the wall if it's tall enough
  _glideHitWall() {
    const d5 = this.lrb_solid_bit;
    let ok = false;
    if (((this.double_jump_property + 0x40) & 0x80) === 0) {
      // .right
      this.status &= ~S_FACING;
      const d1 = this._checkRightCeilingDist(d5);
      if ((d1 | this._d0) === 0) ok = true;
      else ok = this._grabCheckFloor(this.x_pos + s8(this.y_radius) + 1); // .checkFloorRight
    } else {
      // .left
      this.status |= S_FACING;
      const d1 = this._checkLeftCeilingDist(d5);
      if ((d1 | this._d0) === 0) {
        this._addX(1);
        ok = true;
      } else ok = this._grabCheckFloor(this.x_pos - s8(this.y_radius) - 1); // .checkFloorLeft
    }
    if (!ok) {
      // .fail: fall
      this.double_jump_flag = 2;
      this.anim = 0x21;
      this.y_radius = this.default_y_radius;
      this.x_radius = this.default_x_radius;
      this.glideFlags |= GCF_INAIR;
      return;
    }
    // .success
    this.onSound?.('grab'); // sfx_Grab
    this.ground_vel = 0;
    this.x_vel = 0;
    this.y_vel = 0;
    this.double_jump_flag = 4;
    this.mapping_frame = 0xb7;
    this.anim_frame_timer = 0x7f;
    this.anim_frame = 0;
    this.double_jump_property = 3;
    // move.w x_pos(a0),x_pos+2(a0): the X pixel he grabbed the wall at is kept in the
    // subpixel word
    this._x = ((this.x_pos << 16) | (this.x_pos & 0xffff)) | 0;
  }

  // .checkFloorCommon: the top of the wall is just below him (ChkFloorEdge_Part3 at y-11)
  _grabCheckFloor(d3) {
    this.primaryAngle = 0;
    const d1 = this._findFloor(s16(this.y_pos - 11), d3, this.top_solid_bit, 0x10, 0, 0);
    if (d1 < 0 || d1 >= 12) return false;
    this._addY(d1);
    return true;
  }

  // Knuckles_Fall_From_Glide
  _fallFromGlide() {
    this._chgJumpDir(); // Knux_ChgJumpDir
    this.y_vel = s16(this.y_vel + 0x38);
    if (this.status & S_UNDERWATER) this.y_vel = s16(this.y_vel - 0x28);
    this._knuxLevelCollision();
    if (this.glideFlags & GCF_INAIR) return;
    // landed
    this.ground_vel = 0;
    this.x_vel = 0;
    this.y_vel = 0;
    this._addY(s8(this.y_radius - this.default_y_radius));
    this.onSound?.('glideland'); // sfx_GlideLand
    if (((this.angle + 0x20) & 0xc0) !== 0) return this._touchFloor();
    this._touchFloor();
    this.move_lock = 0xf;
    this.anim = 0x23;
  }

  // Knuckles_Sliding: slides on the ground while the button is held
  _sliding() {
    let getUp = !this.held.jump;
    if (!getUp) {
      if (this.x_vel < 0) {
        this.x_vel = s16(this.x_vel + 0x20);
        getUp = this.x_vel >= 0;
      } else {
        this.x_vel = s16(this.x_vel - 0x20);
        getUp = this.x_vel < 0;
      }
    }
    if (getUp) {
      this.ground_vel = 0;
      this.x_vel = 0;
      this.y_vel = 0;
      this._addY(s8(this.y_radius - this.default_y_radius));
      this._touchFloor();
      this.move_lock = 0xf;
      this.anim = 0x22;
      return;
    }
    // .continueSliding
    this._knuxLevelCollision();
    const d1 = this._checkFloor(); // sub_11FD6
    if (d1 >= 14) {
      // slid off a ledge: fall
      this.double_jump_flag = 2;
      this.anim = 0x21;
      this.y_radius = this.default_y_radius;
      this.x_radius = this.default_x_radius;
      this.glideFlags |= GCF_INAIR;
      return;
    }
    this._addY(d1);
    this.angle = this._d3;
    if ((this.frameCounter & 7) === 0) this.onSound?.('groundslide'); // sfx_GroundSlide
  }

  // ================================================================ climbing
  // GetDistanceFromWall (d2 = y)
  _wallDist(d2) {
    const d5 = this.lrb_solid_bit;
    if (!(this.status & S_FACING)) {
      const d3 = this.x_pos + s8(this.x_radius); // loc_FAA4
      return this._singleAngle(this._findWall(d2, d3, d5, 0x10, 0, 0), 0xc0);
    }
    const d3 = (this.x_pos - 1 - s8(this.x_radius)) ^ 0xf; // loc_FDC8
    return this._singleAngle(this._findWall(d2, d3, d5, -0x10, 0x400, 0), 0x40);
  }

  // CheckCeilingDist_WithRadius (d2 = y, d3 = x)
  _ceilingDistR(d2, d3, d5) {
    d2 = (d2 - s8(this.x_radius)) ^ 0xf;
    return this._singleAngle(this._findFloor(d2, d3, d5, -0x10, 0x800, 0), 0x80);
  }

  // sub_F828: floor distance (d2 = y, d3 = x)
  _floorDistR(d2, d3, d5) {
    d2 += s8(this.x_radius);
    return this._singleAngle(this._findFloor(d2, d3, d5, 0x10, 0, 0), 0);
  }

  // Knuckles_Wall_Climb
  _wallClimb() {
    if (u16(this.x_pos) !== (this._x & 0xffff)) return this._letGoOfWall(); // pushed off the wall
    if (this.status & S_ONOBJ) return this._letGoOfWall();
    this.ground_vel = 0;
    this.x_vel = 0;
    this.y_vel = 0;
    let d1 = 0; // climbing animation delta
    let moving = true; // false = .notMoving
    if (this.held.up) {
      d1 = this._wallDist(s16(this.y_pos - 11));
      if (d1 >= 4) return this._climbUp(); // reached the top: climb onto the ledge
      if (d1 !== 0) moving = false; // small dip in the wall: stop
      else {
        const c = this._ceilingDistR(s16(this.y_pos - 8), this.x_pos, this.lrb_solid_bit);
        if (c < 0) {
          this._addY(-c); // bumping into the ceiling
        } else {
          this._addY(-1); // .moveUp
          const minY = this.bounds.minY;
          if (minY !== -0x100) {
            const d0 = s16(minY + 16);
            if (d0 > this.y_pos) this.y_pos = d0;
          }
        }
        d1 = 1;
      }
    } else if (this.held.down) {
      if (this.mapping_frame === 0xbd) {
        this.mapping_frame = 0xb7;
        this._addY(3);
        this._addX(-3);
        if (this.status & S_FACING) this._addX(6);
      }
      d1 = this._wallDist(s16(this.y_pos + 11));
      if (d1 !== 0) return this._letGoOfWall(); // climbed off the bottom of the wall
      const f = this._floorDistR(s16(this.y_pos + 9), this.x_pos, this.top_solid_bit);
      if (f < 0) return this._climbReachedFloor(f);
      this._addY(1); // .moveDown
      d1 = -1;
    }
    if (moving) {
      // .finishMoving: detach if there's ground right below him
      if (!this.held.up && !this.held.down) {
        // (original bug kept: d1 is overwritten by the floor distance, which makes the
        // climbing frame jump when no direction is held)
        d1 = this._floorDistR(s16(this.y_pos + 9), this.x_pos, this.top_solid_bit);
        if (d1 < 0) return this._climbReachedFloor(d1);
      }
      if (d1 !== 0) {
        // only animate every 4 frames
        this.double_jump_property = (this.double_jump_property - 1) & 0xff;
        if (this.double_jump_property & 0x80) {
          this.double_jump_property = 3;
          let f = (d1 + this.mapping_frame) & 0xff;
          if (f < 0xb7) f = 0xbc;
          if (f > 0xbc) f = 0xb7;
          this.mapping_frame = f;
        }
      }
    }
    // .notMoving
    this.anim_frame_timer = 0x20;
    this.anim_frame = 0;
    if (!this.pressed.jump) return;
    // jump off the wall
    this.y_vel = -0x380;
    this.x_vel = 0x400;
    const wasLeft = this.status & S_FACING;
    this.status ^= S_FACING;
    if (!wasLeft) this.x_vel = -0x400;
    this.status |= S_INAIR;
    this.jumping = 1;
    this.y_radius = 0xe;
    this.x_radius = 7;
    this.anim = 2;
    this.status |= S_ROLL;
    this.double_jump_flag = 0;
  }

  // .reachedFloor
  _climbReachedFloor(d1) {
    this._addY(d1);
    this.angle = this.primaryAngle;
    this.ground_vel = 0;
    this.x_vel = 0;
    this.y_vel = 0;
    this._touchFloor();
    this.anim = 5;
  }

  // Knuckles_ClimbUp
  _climbUp() {
    this.double_jump_flag = 5;
    if (this.mapping_frame === 0xbd) return;
    this.double_jump_property = 0;
    this._ledgeClimbStep();
  }

  // Knuckles_LetGoOfWall
  _letGoOfWall() {
    this.double_jump_flag = 2;
    this.anim = 0x21;
    this.prev_anim = 0x21;
    this.mapping_frame = 0xcb;
    this.anim_frame_timer = 7;
    this.anim_frame = 1;
    this.y_radius = this.default_y_radius;
    this.x_radius = this.default_x_radius;
  }

  // Knuckles_DoLedgeClimbingAnimation
  _ledgeClimbStep() {
    const [frame, dx, dy, t] = CLIMB_LEDGE_FRAMES[this.double_jump_property >> 2];
    this.mapping_frame = frame;
    this._addX(this.status & S_FACING ? -dx : dx);
    this._addY(dy);
    this.anim_frame_timer = t;
    this.double_jump_property = (this.double_jump_property + 4) & 0xff;
    this.anim_frame = 0;
  }

  // Knuckles_Climb_Ledge
  _climbLedge() {
    if (this.anim_frame_timer !== 0) return;
    this._ledgeClimbStep();
    if (this.double_jump_property !== CLIMB_LEDGE_END) return;
    this.ground_vel = 0;
    this.x_vel = 0;
    this.y_vel = 0;
    if (this.status & S_FACING) this._addX(-1);
    this._touchFloor();
    this.anim = 5;
  }

  // ================================================================ Knux_DoLevelCollision_CheckRet
  // Air collision for gliding / falling / sliding: never lands, it reports through
  // Gliding_collision_flags (InAir cleared = touched the floor, Push = hit a wall).
  _knuxLevelCollision() {
    const d5 = this.lrb_solid_bit;
    const leftWall = () => {
      const d1 = this._checkLeftWallDist(d5);
      if (d1 < 0) { this._addX(-d1); this.x_vel = 0; this.glideFlags |= GCF_PUSH; }
    };
    const rightWall = () => {
      const d1 = this._checkRightWallDist(d5);
      if (d1 < 0) { this._addX(d1); this.x_vel = 0; this.glideFlags |= GCF_PUSH; }
    };
    const floor = () => {
      const d1 = this._checkFloor(); // sub_11FD6
      if (d1 >= 0) return;
      this._addY(d1);
      this.angle = this._d3;
      this.y_vel = 0;
      this.glideFlags &= ~GCF_INAIR;
    };
    const q = (this._arctan(this.x_vel, this.y_vel) - 0x20) & 0xc0;
    if (q === 0x40) { // loc_179DA: moving left
      leftWall();
      let d1 = this._checkCeiling(d5); // sub_11FEE
      if (d1 < 0) {
        d1 = -d1;
        if (u16(d1) < 0x14) {
          this._addY(d1);
          if (this.y_vel < 0) this.y_vel = 0;
          return;
        }
        rightWall(); // loc_17A1C
        return;
      }
      if (this.y_vel < 0) return;
      floor();
      return;
    }
    if (q === 0x80) { // loc_17A62: moving up
      leftWall();
      rightWall();
      const d1 = this._checkCeiling(d5);
      if (d1 < 0) { this._addY(-d1); this.y_vel = 0; }
      return;
    }
    if (q === 0xc0) { // loc_17AB0: moving right
      rightWall();
      const d1 = this._checkCeiling(d5);
      if (d1 < 0) {
        this._addY(-d1);
        if (this.y_vel < 0) this.y_vel = 0;
        return;
      }
      if (this.y_vel < 0) return;
      floor();
      return;
    }
    leftWall();
    rightWall();
    floor();
  }

  // ================================================================ Animate_Knuckles
  // Same engine as Animate_Sonic (without Super Sonic), reading AniKnuckles from the S&K half.
  _animate() {
    const r = this.rom.full;
    const d0 = this.anim;
    if (d0 !== this.prev_anim) {
      this.prev_anim = d0;
      this.anim_frame = 0;
      this.anim_frame_timer = 0;
      this.status &= ~S_PUSH;
    }
    const a1 = this.animAddrs[d0] ?? this.animAddrs[0];
    const first = r[a1];
    if (!(first & 0x80)) {
      this.render_flags = (this.render_flags & 0xfc) | (this.status & 1);
      this.anim_frame_timer = (this.anim_frame_timer - 1) & 0xff;
      if (!(this.anim_frame_timer & 0x80)) return;
      this.anim_frame_timer = first;
      this._animStep(a1);
      return;
    }
    if (first === 0xff) return this._animWalk(); // loc_17DC8
    return this._animRoll(); // loc_17E84
  }

  // loc_17D7E
  _animStep(a1) {
    const r = this.rom.full;
    let d1 = this.anim_frame;
    let d0 = r[a1 + 1 + d1];
    if (d0 >= 0xfc) {
      if (d0 === 0xff) {
        this.anim_frame = 0;
        d0 = r[a1 + 1];
      } else if (d0 === 0xfe) {
        const n = r[a1 + 2 + d1];
        this.anim_frame = (this.anim_frame - n) & 0xff;
        d1 = (d1 - n) & 0xff;
        d0 = r[a1 + 1 + d1];
      } else if (d0 === 0xfd) {
        this.anim = r[a1 + 2 + d1];
        return;
      } else return;
    }
    this.mapping_frame = d0;
    this.anim_frame = (this.anim_frame + 1) & 0xff;
  }

  // loc_17DC8: walking / running
  _animWalk() {
    const r = this.rom.full;
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
    if (spd >= 0x600) a1 = this.animAddrs[1]; // AniKnuckles01
    else {
      a1 = this.animAddrs[0]; // AniKnuckles00
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

  // ================================================================ Knuckles_Load_PLC + display
  // Knuckles_Load_PLC: same DPLC format as Sonic's (count, then (n-1)<<12 | tile words), art
  // from ArtUnc_Knux into ArtTile_Player_1.
  loadArt(vdp, frame) {
    if (frame === this._plcFrame) return;
    this._plcFrame = frame;
    const rom = this.rom, full = rom.full;
    const o = SK.PLC_Knuckles + rom.sku16(SK.PLC_Knuckles + frame * 2);
    const n = rom.sku16(o);
    let v = ART_TILE.Player_1 * 32;
    for (let i = 0; i < n && i < 32; i++) {
      const w = rom.sku16(o + 2 + i * 2);
      const bytes = ((w >> 12) + 1) * 32;
      const src = SK.ArtUnc_Knux + (w & 0xfff) * 32;
      vdp.writeVram(v, full.subarray(src, src + bytes));
      v += bytes;
    }
  }

  // game.js calls this instead of its Sonic DPLC / Map_Sonic drawing
  drawSelf(vdp, cx, cy) {
    const frame = this.mapping_frame | 0;
    this.loadArt(vdp, frame);
    if (this.visible === false && !this.dying) return;
    const pieces = this.mappings[frame];
    if (!pieces) return;
    vdp.addSprite(pieces, this.x_pos - cx, this.y_pos - cy, ART_TILE.Player_1 | (this.highPriority ? 0x8000 : 0), this.flipX, this.flipY, this.priority);
  }

  // game.js: where the act ends (the bosses aren't ported, the act ends when the player
  // reaches the boss). Knuckles has his own end points in some acts.
  actEndX(zone, def) {
    const objs = this.level.objects;
    const at = (id, pick = Math.min) => {
      const xs = objs.filter((o) => o.id === id).map((o) => o.x);
      return xs.length ? pick(...xs) - 0x80 : def;
    };
    switch (zone.id) {
      case 0x101: return at(0xb5, Math.max); // Obj_HCZEndBoss: Knuckles' arena at X $44E0-$4640
      case 0x201: return at(0xb1); // Obj_MGZEndBossKnux
      case 0x301: return 0x4880; // CNZ2: Obj_CNZTeleporter appears at X >= $4880 (Y >= $B00)
      case 0x600: return at(OBJ_LBZ_MINIBOSS_BOX_KNUX); // Obj_LBZMinibossBoxKnux
      default: return def;
    }
  }

  // After the level objects are set up (game.js): Knuckles' colours in the water palette
  levelInit(game) {
    patchWaterPalette(game.level, this.rom);
    game.vdp?.updatePalette();
    // PLC_05 (Knuckles' variant of the HUD cue): ArtNem_KnucklesLifeIcon at ArtTile_PlayerLifeIcon
    const icon = nemesis(this.rom.full, SK.ArtNem_KnucklesLifeIcon);
    game.vdp?.writeVram(ART_TILE.PlayerLifeIcon * 32, icon);
  }
}

// Sprite mappings from the full image (same S3K format as Rom.mappings)
function parseMappings(rom, base) {
  const frames = [];
  const n = rom.sku16(base) / 2;
  for (let f = 0; f < n; f++) {
    const o = base + rom.sku16(base + f * 2);
    let cnt = rom.sku16(o);
    if (cnt > 80) cnt = 0; // past the end of the table (see Rom.mappings)
    const pieces = [];
    for (let i = 0; i < cnt; i++) {
      const p = o + 2 + i * 6;
      const size = rom.sku8(p + 1);
      pieces.push({ y: s8(rom.sku8(p)), w: ((size >> 2) & 3) + 1, h: (size & 3) + 1, tile: rom.sku16(p + 2), x: rom.sks16(p + 4) });
    }
    frames.push(pieces);
  }
  return frames;
}

// ============================================================================ level data
// S3&K object ID (Sprite_Listing3, "SK Set 1") -> Sonic 3 ID (Sprite_Listing), matched by
// object label. IDs below $80 are the same in both lists except $0B/$1C (Obj_Ring in S3&K)
// and $6F-$7F (FBZ objects). Objects that only exist in S3&K get $100 + their S3&K ID.
const SK_TO_S3 = {
  0x0b: 0x00, 0x1c: 0x00,
  0x80: 0xc5, 0x81: 0xc6, 0x82: 0xc7, 0x83: 0xc9, 0x84: 0xca, 0x85: 0xcb, 0x86: 0xce, 0x87: 0xcf,
  0x88: 0xd1, 0x89: 0xd2, 0x8c: 0x81, 0x8d: 0x82, 0x8e: 0x83, 0x8f: 0x9f,
  0x90: 0x80, 0x91: 0xac, 0x92: 0xa9, 0x93: 0x99, 0x94: 0x9a, 0x95: 0x9b, 0x96: 0x9c, 0x97: 0x9d,
  0x98: 0x9e, 0x99: 0xad, 0x9a: 0xb5, 0x9b: 0xa3, 0x9c: 0xa5, 0x9d: 0xa6, 0x9e: 0xa4, 0x9f: 0xc4,
  0xa0: 0xaf, 0xa1: 0xb0, 0xa2: 0xb1, 0xa3: 0xa0, 0xa4: 0xa1, 0xa5: 0xa2, 0xa6: 0x8e, 0xa7: 0x8d,
  0xa8: 0xa7, 0xa9: 0xa8, 0xaa: 0x8f, 0xab: 0xb6, 0xac: 0xb4, 0xad: 0xaa, 0xae: 0xab, 0xaf: 0xb8,
  0xb0: 0xb9, 0xb1: 0xba, 0xb2: 0xbb, 0xb3: 0xbc, 0xb4: 0xbd, 0xb5: 0xbe, 0xb6: 0xbf, 0xb7: 0xc0,
  0xb8: 0xc1, 0xb9: 0xc2, 0xba: 0xc3, 0xbb: 0xc8, 0xbc: 0xb3, 0xbd: 0xb2, 0xbe: 0x87, 0xbf: 0x88,
  0xc0: 0x89, 0xc1: 0x8a, 0xc2: 0x8b, 0xc3: 0xae, 0xc4: 0xcc, 0xc6: 0xb7, 0xc7: 0x00, 0xc8: 0xd3,
  0xc9: 0x85, 0xca: 0x86, 0xcb: 0x8c, 0xcc: 0xd0,
};
export const OBJ_LBZ_MINIBOSS_BOX_KNUX = 0x1c5; // Obj_LBZMinibossBoxKnux (no S3 ID)
export const OBJ_LBZ_FINAL_BOSS_KNUX = 0x1cd; // Obj_LBZFinalBossKnux (no S3 ID)

export function skObjectId(id) {
  if (id < 0x80 && id !== 0x0b && id !== 0x1c) return (id >= 0x6f) ? 0x100 | id : id;
  const t = SK_TO_S3[id];
  return t !== undefined ? t : 0x100 | id;
}

function actIdx(zoneAct) { return ((zoneAct >> 8) << 1) | (zoneAct & 1); }

// What the S3&K engine loads differently for Knuckles in a Sonic 3 act.
export function applyKnucklesLevel(level, rom, game = null) {
  if (level.knuckles) return;
  level.knuckles = true;
  const z = level.zoneAct, idx = actIdx(z);
  // Get_LevelSizeStart (loc_1BE5E): Knux_Start_Locations when Player_mode == 3
  level.start = { x: rom.sku16(SK.Knux_Start_Locations + idx * 4), y: rom.sku16(SK.Knux_Start_Locations + idx * 4 + 2) };
  // ICZ1_ScreenInit puts Knuckles at $3640,$660 (start of his ICZ1 route, no snowboard intro)
  if (z === 0x500) level.start = { x: 0x3640, y: 0x660 };
  // LoadPalette_Immediate(PalID_Knuckles) into line 0
  for (let i = 0; i < 16; i++) level.palette[i] = rom.sku16(SK.Pal_Knuckles + i * 2);
  // Chunk / palette changes for Knuckles' AIZ routes
  if (z === 0x000) adjustAIZ1Chunks2(level, rom);
  if (z === 0x001) adjustAIZ2LayoutKnux(level);
  loadSKLayouts(level, rom, idx);
  game?.vdp?.updatePalette();
}

// RAM chunk address -> index in level.chunks (Chunk_table at $FF0000)
const CW = (addr) => (addr - 0xff0000) >> 1;
function fill(chunks, addr, n, v) {
  const i = CW(addr);
  for (let k = 0; k < n; k++) chunks[i + k] = v;
  return addr + n * 2;
}

// Adjust_AIZ1Chunks2 (from AIZ1_ScreenInit when Player_mode == 3)
function adjustAIZ1Chunks2(level, rom) {
  const c = level.chunks, set = (addr, v) => { c[CW(addr)] = v; };
  // Target_palette_line_4+$10: 4 colours from word_4FAE4
  for (let i = 0; i < 4; i++) level.palette[0x30 + 8 + i] = rom.sku16(SK.word_4FAE4 + i * 2);
  for (const a of [0xff4c70, 0xff4cf0, 0xff4d70, 0xff52f0, 0xff4980, 0xff4d80]) fill(c, a, 8, 0x4b);
  let a = fill(c, 0xff3420, 8, 0x4b);
  set(a, 0x402); a += 2;
  a = fill(c, a, 6, 0x4b);
  set(a, 0x002);
  a = fill(c, 0xff3fa0, 8, 0x4b) + 4;
  set(a, 0x00c); set(a + 2, 0x406); set(a + 4, 0x4b); set(a + 6, 0x4b); set(a + 10, 0x40a);
  set(0xff5820, 0x40b);
  a = fill(c, 0xff5822, 6, 0x4b) + 6;
  set(a, 0x00c); set(a + 2, 0x406);
  fill(c, a + 4, 2, 0x4b);
}

// Adjust_AIZ2Layout, Player_mode == 3 part (the common part is in zones/aiz.js)
function adjustAIZ2LayoutKnux(level) {
  const c = level.chunks, set = (addr, v) => { c[CW(addr)] = v; };
  set(0xff1020, 0x5b);
  let a = fill(c, 0xff3420, 8, 0x5b);
  set(a, 0xcae); a += 2;
  a = fill(c, a, 6, 0x5b);
  set(a, 0x8ae);
  a = fill(c, 0xff3fa0, 8, 0x5b) + 4;
  set(a, 0x4b6); set(a + 2, 0x4cc); set(a + 4, 0x5b); set(a + 6, 0x5b); set(a + 10, 0x4b7);
  a = fill(c, 0xff5822, 6, 0x5b) + 6;
  set(a, 0x4b6); set(a + 2, 0x4cc); set(a + 4, 0x5b); set(a + 6, 0x5b);
}

// SpriteLocPtrs / RingLocPtrs of S3&K (same formats as Sonic 3's tables). The S3&K
// layouts of the Sonic 3 zones contain the objects of Knuckles' routes and bosses.
function loadSKLayouts(level, rom, idx) {
  const rings = [];
  let rp = rom.sku32(SK.RingLocPtrs + idx * 4);
  for (let i = 0; i < 2000; i++, rp += 4) {
    const x = rom.sku16(rp);
    if (x === 0xffff) break;
    const y = rom.sku16(rp + 2);
    if (x === 0 && y === 0) continue;
    rings.push({ x, y: y & 0xfff, collected: false });
  }
  const objects = [], layout = [];
  let op = rom.sku32(SK.SpriteLocPtrs + idx * 4);
  for (let i = 0; i < 4000; i++, op += 6) {
    const x = rom.sku16(op);
    if (x === 0xffff) break;
    const yw = rom.sku16(op + 2);
    layout.push({ x, yw, id: skObjectId(rom.sku8(op + 4)), subtype: rom.sku8(op + 5) }); // for ObjCore
    objects.push({
      x, y: yw & 0xfff, xflip: (yw >> 13) & 1, yflip: (yw >> 14) & 1,
      id: skObjectId(rom.sku8(op + 4)), skId: rom.sku8(op + 4), subtype: rom.sku8(op + 5),
    });
  }
  level.rings = rings;
  level.objects = objects;
  level.objectLayout = layout;
}

// LoadWaterPalette, loc_7A22: Knuckles' colours 2-4 of the water palette line 0
function patchWaterPalette(level, rom) {
  const wp = level.waterPalette;
  if (!wp) return;
  const zi = level.zoneAct >> 8; // Pal_WaterKnux is indexed by zone (AIZ..LBZ)
  if (zi > 6) return;
  for (let i = 0; i < 3; i++) wp[2 + i] = rom.sku16(SK.Pal_WaterKnux + zi * 6 + i * 2);
}

registerCharacter('knuckles', (rom, level, game) => (rom.sk ? new Knuckles(rom, level, game) : null));
