// Water: ports of the Sonic 3 water objects and the screen-side water handling (s3.asm).
// Labels in comments are the original ones; loc_xxxxx labels are real ROM addresses.
//
//   Water            LoadWaterPalette, the per-frame part of Handle_Onscreen_Water_Height
//                    (Water_full_screen_flag / H_int_counter, used by the VDP's line palettes),
//                    owner of the reserved-slot objects below, player.water interface.
//   Dust             Obj_DashDust, only the splash animation (anim 1) the player triggers
//                    when entering / leaving the water (spindash / skid dust are not ported).
//   AirCountdown     Obj_AirCountdown: the Breathing_bubbles controller (subtype $81, air
//                    countdown, warning dings, drowning) and the bubbles / countdown numbers
//                    it spawns.
//   Bubbler          Obj_Bubbler (object id 84): bubble spawner and the bubbles it emits;
//                    big bubbles give air (Player_ResetAirTimer).
//   HCZWaveSplash    Obj_HCZWaveSplash: Hydrocity's water surface sprites.
//
// The player-side code (Sonic_Water / Sonic_InWater / Sonic_OutWater, underwater physics,
// Player_ResetAirTimer, the drowning routine) is in player.js.
import { Obj } from './objcore.js';
import { R } from './ram.js';

const s8 = (v) => (v << 24) >> 24;
const s16 = (v) => (v << 16) >> 16;
const u16 = (v) => v & 0xffff;

// ROM addresses (found by matching the referencing instructions in the ROM)
const WATER_TRANSITION = { // WaterTransition_* (HInt3 colour tables), header = count-1
  AIZ1: 0x5758, AIZ2: 0x577a, CNZ2ICZ2: 0x57a2, HCZLBZ1: 0x57cc, LBZ2: 0x57f6,
};
const MAP_BUBBLER = 0x2e3c8; // AirCountdown_Init / loc_2E068: move.l #Map_Bubbler,mappings(a0)
const ANI_AIRCOUNTDOWN = 0x17454; // AirCountdown_Animate: lea (Ani_AirCountdown).l,a1
const AIRCOUNTDOWN_WOBBLE = 0x170b6; // AirCountdown_Wobble: lea (AirCountdown_WobbleData).l,a1
const ARTUNC_AIRCOUNTDOWN = 0x8d834; // AirCountdown_Load_Art: addi.l #ArtUnc_AirCountdown,d1
const ANI_BUBBLER = 0x2e394; // loc_2E0C6: lea (Ani_Bubbler).l,a1
const BUBBLER_TABLE = 0x2e2ac; // byte_2E2AC
const MAP_DASHDUST = 0x17b40; // loc_178D4: move.l #Map_DashDust,mappings(a0)
const ANI_DASHSPLASHDROWN = 0x17b0c; // loc_179FE: lea (Ani_DashSplashDrown).l,a1
const DPLC_DASHSPLASHDROWN = 0x17c2e; // SplashDrown_Load_DPLC: lea (DPLC_DashSplashDrown).l,a2
const ARTUNC_DASHDUST = 0x149122; // DashDust_Load_DPLC: move.l #ArtUnc_DashDust,d6
const MAP_HCZWAVESPLASH = 0x1cf2e; // Obj_HCZWaveSplash: move.l #Map_HCZWaveSplash,mappings(a0)

const ARTTILE_BUBBLES = 0x45c, ARTTILE_DASHDUST = 0x7e0, ARTTILE_HCZWAVESPLASH = 0x42e;
const PALID_WATER = { // LoadWaterPalette
  0x000: [0x2b, 'AIZ1'], 0x001: [0x2c, 'AIZ2'], 0x100: [0x31, 'HCZLBZ1'], 0x101: [0x32, 'HCZLBZ1'],
  0x301: [0x3a, 'CNZ2ICZ2'], 0x501: [0x39, 'CNZ2ICZ2'], 0x600: [0x2d, 'HCZLBZ1'], 0x601: [0x2e, 'LBZ2'],
};
const RNG_SEED = 0xfff636;
const S_UNDERWATER = 0x40, S_FACING = 1, S_ROLL = 4, S_ROLLJUMP = 0x10, S_PUSH = 0x20, S2_BUBL = 0x40;

// Random_Number ($1FAE). Returns the low word of d0.
export function randomNumber(ram) {
  let d1 = ram.l(RNG_SEED);
  if (!d1) d1 = 0x2a6d365a;
  const d0 = d1;
  d1 = ((d1 << 2) + d0) | 0;
  d1 = ((d1 << 3) + d0) | 0;
  const lo = d1 & 0xffff, hi = (d1 >>> 16) & 0xffff;
  const r = (lo + hi) & 0xffff;
  ram.setL(RNG_SEED, (r << 16) | lo);
  return r;
}

// ============================================================================ Water
export class Water {
  constructor(game) {
    this.game = game;
    this.ram = game.ram;
    this.lvl = game.level;
    this.zoneAct = game.level.zoneAct;
    this.enteredCounter = 0; // Water_entered_counter
    this.fullScreen = false; // Water_full_screen_flag
    this.counter = 0xff; // H_int_counter
    this.breathing = null; // Breathing_bubbles slot
    this.dust = null; // Dust slot
    game.player.water = this;
    if (!this.flag) return;
    // LoadWaterPalette: LoadPalette2 into Water_palette (and Target_water_palette, which the
    // level fade-in copies over Water_palette lines 2-4: the end result is the same palette)
    const [palId, trans] = PALID_WATER[this.zoneAct] ?? [0x2b, 'AIZ1'];
    const wp = new Uint16Array(64);
    const { src, dest, count } = game.rom.palette(palId);
    for (let i = 0; i < count && dest + i < 64; i++) wp[dest + i] = game.rom.u16(src + i * 2);
    this.lvl.waterPalette = wp;
    game.vdp.updatePalette();
    // CheckLevelForWater: HInt2 for Hydrocity (whole palette), HInt3 elsewhere
    if ((this.zoneAct >> 8) === 1) this.groups = null;
    else {
      const t = WATER_TRANSITION[trans], n = game.rom.u16(t) + 1;
      this.groups = Array.from({ length: n }, (_, i) => game.rom.u16(t + 2 + i * 2) >> 1);
    }
    // reserved object slots: Dust (SpawnLevelMainSprites) and Wave_Splash (HCZ)
    const core = game.core;
    this.dust = new Dust(game);
    core.objects.unshift(this.dust);
    if ((this.zoneAct >> 8) === 1) core.objects.unshift(new HCZWaveSplash(game));
  }

  get flag() { return this.ram.ub(R.Water_flag) !== 0; }
  // player.water.level: Water_level as Sonic sees it (set by the previous frame's camera update)
  get level() { return this.ram.w(R.Water_level); }

  // Sonic_InWater / Sonic_OutWater bookkeeping
  onWaterChange(p, entered) {
    this.enteredCounter = (this.enteredCounter + 1) & 0xff;
    if (!entered) return;
    // move.l #Obj_AirCountdown,(Breathing_bubbles).w / move.b #$81,subtype: the slot keeps
    // its state, so an already running countdown controller just carries on
    if (!this.breathing || !this.breathing.alive) {
      this.breathing = new AirCountdown(this.game, { x: p.x_pos, y: p.y_pos, subtype: 0x81 });
      this.breathing.parent = p;
      this.game.core.objects.unshift(this.breathing);
    }
  }

  // move.w #1<<8,anim(a6): Dust object splash
  splash() {
    if (!this.dust) return;
    this.dust.anim = 1;
    this.dust.prev_anim = 0;
  }

  // Obj_LightningShield_DestroyUnderwater: flash the underwater palette white; the
  // shield object restores it 4 frames later (Obj_LightningShield_DestroyUnderwater2)
  flashWhite() {
    const wp = this.lvl.waterPalette;
    if (!wp || this.flashBackup) return;
    this.flashBackup = wp.slice(); // Target_water_palette
    wp.fill(0x0eee);
    wp[0x20] = 0; // Water_palette_line_3 colour 0
    this.game.vdp.updatePalette();
    const water = this;
    this.game.core.spawn(Object.assign(new Obj(this.game, {}), {
      anim_frame_timer: 3,
      update() {
        if (--this.anim_frame_timer >= 0) return;
        water.lvl.waterPalette.set(water.flashBackup);
        water.flashBackup = null;
        water.game.vdp.updatePalette();
        this.delete();
      },
    }));
  }

  // Handle_Onscreen_Water_Height, from loc_50FC (Water_level itself is set in camera.js):
  // Water_full_screen_flag and H_int_counter for VInt / the water H-int.
  screenWater() {
    const m = this.ram;
    this.fullScreen = false;
    this.counter = 0xff;
    if (!this.flag) return;
    if (this.zoneAct === 0x100 && u16(m.w(R.Camera_X_pos)) < 0x900) return; // loc_5130
    const d0 = s16(m.w(R.Water_level) - m.w(R.Camera_Y_pos));
    if (d0 <= 0) { this.fullScreen = true; return; } // loc_512A
    this.counter = d0 >= 0xdf ? 0xff : d0;
  }

  // called by Game.render before the planes are drawn
  prepareRender(vdp) {
    this.screenWater();
    this.ram.setB(R.Water_full_screen_flag, this.fullScreen ? 1 : 0);
    vdp.water = this.flag ? { fullScreen: this.fullScreen, counter: this.counter, groups: this.groups } : null;
  }
}

// ============================================================================ Dust
// Obj_DashDust (loc_1792A), splash only. anim 0 = idle (frame 0, empty), 1 = splash.
class Dust extends Obj {
  constructor(game) {
    super(game, {});
    this.mappings = game.maps(MAP_DASHDUST);
    this.render_flags |= 4;
    this.priority = 0x80;
    this.width_pixels = 0x10;
    this.art_tile = ARTTILE_DASHDUST;
    this.lastDplc = -1; // $34
  }
  update() {
    const p = this.game.player;
    if (this.anim === 1) {
      // loc_17948
      this.y_pos = this.game.ram.w(R.Water_level);
      if (this.prev_anim === 0) {
        this.x_pos = p.x_pos;
        this.status = 0;
        this.art_tile &= 0x7fff;
      }
    } else if (this.anim !== 0) {
      this.anim = 0; // spindash / skid dust: not ported
    }
    // loc_179FE
    this.animateSprite(ANI_DASHSPLASHDROWN);
    this.loadDPLC();
    this.display();
  }
  // DashDust_Load_DPLC
  loadDPLC() {
    const f = this.mapping_frame;
    if (f === this.lastDplc) return;
    this.lastDplc = f;
    const rom = this.game.rom;
    let a = DPLC_DASHSPLASHDROWN + rom.u16(DPLC_DASHSPLASHDROWN + f * 2);
    const n = rom.u16(a);
    a += 2;
    let v = ARTTILE_DASHDUST * 32;
    for (let i = 0; i < n; i++, a += 2) {
      const w = rom.u16(a);
      const bytes = ((w >> 12) + 1) * 32;
      const src = ARTUNC_DASHDUST + (w & 0xfff) * 32;
      this.game.vdp.writeVram(v, rom.u8.subarray(src, src + bytes));
      v += bytes;
    }
  }
}

// ============================================================================ AirCountdown
// Obj_AirCountdown. Routines: 0 Init, 2 Animate, 4 ChkWater, 6 Display, 8 Delete,
// $A Countdown (the Breathing_bubbles controller), $C AirLeft, $E DisplayNumber, $10 Delete.
// Fields: $30 drown timer, $34 base x, $36/$37 number-bubble interval, $38 bubbles left in
// this burst, $3A flags (bit 15 numbers allowed, bit 14 number bubble made), $3C timer,
// $3E time to the next bubble, $40 parent (player).
export class AirCountdown extends Obj {
  constructor(game, d) {
    super(game, d);
    this.parent = game.player;
    this.angle = 0;
    this.lastArt = 0; // $32
    this.t30 = 0; this.t34 = 0; this.t36 = 0; this.t37 = 0; this.t38 = 0;
    this.t3a = 0; this.t3c = 0; this.t3e = 0;
    this.screen = false; // render_flags bit 2 clear: x/y are screen coordinates + $80
  }

  update() {
    switch (this.routine) {
      case 0: return this.init();
      case 2: return this.animate();
      case 4: return this.chkWater();
      case 6: return this.displayRoutine();
      case 0xa: return this.countdown();
      case 0xc: return this.airLeft();
      case 0xe: return this.displayNumber();
      default: return this.delete(); // 8, $10
    }
  }

  // AirCountdown_Init
  init() {
    this.routine += 2;
    this.mappings = this.game.maps(MAP_BUBBLER);
    this.art_tile = ARTTILE_BUBBLES;
    this.render_flags = 0x84;
    this.width_pixels = 0x10;
    this.priority = 0x80;
    const d0 = this.subtype;
    if (d0 & 0x80) {
      this.routine += 8;
      this.t37 = d0 & 0x7f;
      return this.countdown();
    }
    this.anim = d0;
    this.t34 = this.x_pos;
    this.y_vel = -0x100;
    this.animate();
  }

  // AirCountdown_Animate
  animate() {
    this.animateSprite(ANI_AIRCOUNTDOWN);
    this.chkWater();
  }

  // AirCountdown_ChkWater
  chkWater() {
    const wl = u16(this.game.ram.w(R.Water_level));
    if (wl >= u16(this.y_pos)) {
      // pop the bubble
      this.routine = 6;
      this.anim = (this.anim + 7) & 0xff;
      if (this.anim > 0xd) this.anim = 0xd;
      return this.displayRoutine();
    }
    // AirCountdown_Wobble (WindTunnel_flag is never set here)
    const a = this.angle;
    this.angle = (this.angle + 1) & 0xff;
    this.x_pos = s16(this.t34 + this.game.rom.s8(AIRCOUNTDOWN_WOBBLE + (a & 0x7f)));
    this.showNumber();
    this.moveSprite2();
    if (this.screen || (this.render_flags & 0x80)) this.display();
    else this.delete();
  }

  // AirCountdown_Display
  displayRoutine() {
    this.showNumber();
    this.animateSprite(ANI_AIRCOUNTDOWN);
    this.loadArt();
    this.display();
  }

  // AirCountdown_AirLeft
  airLeft() {
    const p = this.parent;
    if (p.air_left > 12) return this.delete();
    this.t3c = u16(this.t3c - 1);
    if (this.t3c === 0) {
      this.routine = 0xe;
      this.anim = (this.anim + 7) & 0xff;
      return this.displayRoutine();
    }
    // AirCountdown_Display2
    this.animateSprite(ANI_AIRCOUNTDOWN);
    this.loadArt();
    if (this.screen || (this.render_flags & 0x80)) this.display();
    else this.delete();
  }

  // AirCountdown_DisplayNumber
  displayNumber() {
    if (this.parent.air_left > 12) return this.delete();
    this.showNumber();
    this.animateSprite(ANI_AIRCOUNTDOWN);
    this.display();
  }

  // AirCountdown_ShowNumber: the bubble turns into a number fixed on screen
  showNumber() {
    if (this.t3c === 0) return;
    this.t3c = u16(this.t3c - 1);
    if (this.t3c !== 0) return;
    if (this.anim >= 7) return;
    this.t3c = 0xf;
    this.y_vel = 0;
    this.render_flags = 0x80;
    this.screen = true;
    const m = this.game.ram;
    this.x_pos = s16(this.x_pos - m.w(R.Camera_X_pos) + 0x80);
    this.y_pos = s16(this.y_pos - m.w(R.Camera_Y_pos) + 0x80);
    this.routine = 0xc;
  }

  // AirCountdown_Load_Art: number frames 9..$12 stream their 6 tiles to ArtTile_DashDust
  loadArt() {
    const d1 = this.mapping_frame;
    if (d1 < 9 || d1 >= 0x13) return;
    if (d1 === this.lastArt) return;
    this.lastArt = d1;
    const src = ARTUNC_AIRCOUNTDOWN + (d1 - 9) * 3 * 64;
    this.game.vdp.writeVram(ARTTILE_DASHDUST * 32, this.game.rom.u8.subarray(src, src + 0xc0));
  }

  // AirCountdown_Countdown (the Breathing_bubbles controller)
  countdown() {
    const p = this.parent, game = this.game, m = game.ram;
    if (this.t30 !== 0) {
      // loc_1730C: drowning
      p.anim = 0x17;
      this.t30 = u16(this.t30 - 1);
      if (this.t30 === 0) { p.routine = 6; return; }
      return this.bubbleTimer();
    }
    if (p.routine >= 6) return;
    if (p.status_secondary & S2_BUBL) return;
    if (!(p.status & S_UNDERWATER)) return;
    this.t3c = s16(this.t3c - 1);
    if (this.t3c >= 0) return this.bubbleTimer();
    this.t3c = 60 - 1;
    this.t3a = 1;
    this.t38 = randomNumber(m) & 1;
    const d0 = p.air_left;
    if (d0 === 25 || d0 === 20 || d0 === 15) {
      game.sfx('airding'); // AirCountdown_WarnSound: sfx_AirDing
    } else if (d0 <= 12) {
      if (d0 === 12) game.sfx('drowning'); // mus_Drowning
      // loc_17278
      this.t36 = s8(this.t36 - 1);
      if (this.t36 < 0) {
        this.t36 = this.t37;
        this.t3a |= 0x8000;
      }
    }
    // AirCountdown_ReduceAir
    if (p.air_left === 0) {
      p.air_left = 0xff;
      // out of air
      this.t38 = 0xa;
      this.t3a = 1;
      this.t30 = 0x78;
      p.drown(); // object_control $81, sfx_Drown, Player_ResetAirTimer, anim $17, routine $C
      m.setB(R.Deform_lock, 1);
      return;
    }
    p.air_left--;
    this.makeItem();
  }

  // loc_17324
  bubbleTimer() {
    if (this.t3a === 0) return;
    this.t3e = s16(this.t3e - 1);
    if (this.t3e >= 0) return;
    this.makeItem();
  }

  // AirCountdown_MakeItem: a bubble from Sonic's mouth
  makeItem() {
    const p = this.parent, m = this.game.ram;
    this.t3e = (randomNumber(m) & 0xf) + 8;
    const b = new AirCountdown(this.game, { x: p.x_pos, y: p.y_pos, subtype: 6 });
    b.parent = p;
    let d0 = 6;
    if (p.status & S_FACING) { d0 = -6; b.angle = 0x40; }
    b.x_pos = s16(b.x_pos + d0);
    if (this.t30 !== 0) {
      // drowning: a stream of bubbles
      this.t3e &= 7;
      b.y_pos = s16(p.y_pos - 0xc);
      b.angle = randomNumber(m) & 0xff;
      if ((m.uw(R.Level_frame_counter) & 3) === 0) b.subtype = 0xe;
    } else if ((this.t3a & 0x8000) && p.air_left < 12) {
      // loc_173BA: one of the bubbles of this burst becomes a countdown number
      const d2 = p.air_left >> 1;
      let skip = false;
      if ((randomNumber(m) & 3) === 0) {
        if (this.t3a & 0x4000) skip = true;
        else { this.t3a |= 0x4000; b.subtype = d2; b.t3c = 0x1c; }
      }
      // loc_173EE
      if (!skip && this.t38 === 0 && !(this.t3a & 0x4000)) {
        this.t3a |= 0x4000;
        b.subtype = d2;
        b.t3c = 0x1c;
      }
    }
    this.game.core.spawn(b);
    // loc_17406
    this.t38 = s8(this.t38 - 1);
    if (this.t38 < 0) this.t3a = 0;
  }

  draw(vdp, cx, cy) {
    if (!this.screen) return super.draw(vdp, cx, cy);
    const pieces = this.mappings && this.mappings[this.mapping_frame];
    if (pieces) vdp.addSprite(pieces, this.x_pos - 0x80, this.y_pos - 0x80, this.art_tile, false, false, this.priority);
  }
}

// ============================================================================ Bubbler
// Obj_Bubbler (id 84). Subtype bit 7 = the spawner (routine $A, loc_2E166), otherwise a
// bubble: anim 0 small, 1 medium, 2 big (breathable from mapping frame 6).
// Fields: $2E breathable, $30 base x, $32/$33 cycles before a big bubble, $34 bubbles left,
// $36 flags, $38 timer, $3C table pointer.
export class Bubbler extends Obj {
  constructor(game, d) {
    super(game, d);
    this.angle = 0;
    this.f2e = 0; this.f30 = 0; this.f32 = 0; this.f33 = 0; this.f34 = 0;
    this.f36 = 0; this.f38 = 0; this.f3c = 0;
  }

  update() {
    switch (this.routine) {
      case 0: return this.init();
      case 2: return this.rise();
      case 4: return this.chkWater();
      case 6: return this.pop();
      case 0xa: return this.spawner();
      default: return this.delete(); // 8: loc_2E160
    }
  }

  // loc_2E068
  init() {
    this.routine += 2;
    this.mappings = this.game.maps(MAP_BUBBLER);
    this.art_tile = ARTTILE_BUBBLES;
    this.render_flags = 0x84;
    this.width_pixels = 0x10;
    this.priority = 0x80;
    const d0 = this.subtype;
    if (d0 & 0x80) {
      this.routine += 8;
      this.f32 = d0 & 0x7f;
      this.f33 = d0 & 0x7f;
      this.anim = 8;
      return this.spawner();
    }
    this.anim = d0;
    this.f30 = this.x_pos;
    this.y_vel = -0x88;
    this.angle = randomNumber(this.game.ram) & 0xff;
    this.rise();
  }

  // loc_2E0C6
  rise() {
    this.animateSprite(ANI_BUBBLER);
    if (this.mapping_frame === 6) this.f2e = 1;
    this.chkWater();
  }

  // loc_2E0E0
  chkWater() {
    const wl = u16(this.game.ram.w(R.Water_level));
    if (wl >= u16(this.y_pos)) {
      this.routine = 6;
      this.anim = (this.anim + 4) & 0xff;
      return this.pop();
    }
    const a = this.angle;
    this.angle = (this.angle + 1) & 0xff;
    this.x_pos = s16(this.f30 + this.game.rom.s8(AIRCOUNTDOWN_WOBBLE + (a & 0x7f)));
    if (this.f2e) {
      this.breathe(this.game.player); // sub_2E2BE (Player 1 only here)
      if (this.routine === 6) return this.pop();
    }
    this.moveSprite2();
    if (this.render_flags & 0x80) this.display();
    else this.delete();
  }

  // loc_2E142
  pop() {
    this.animateSprite(ANI_BUBBLER);
    if (this.render_flags & 0x80) this.display();
    else this.delete();
  }

  // sub_2E2C8: the player breathes the big bubble
  breathe(p) {
    if (p.object_control & 0x80) return;
    const px = u16(p.x_pos), py = u16(p.y_pos);
    let d1 = u16(this.x_pos - 0x10);
    if (d1 >= px) return;
    d1 = u16(d1 + 0x20);
    if (d1 < px) return;
    d1 = u16(this.y_pos);
    if (d1 >= py) return;
    d1 = u16(d1 + 0x10);
    if (d1 < py) return;
    if (p.status_secondary & S2_BUBL) return;
    p.resetAirTimer(); // Player_ResetAirTimer
    this.game.sfx('airbubble'); // sfx_Bubble
    p.x_vel = 0;
    p.y_vel = 0;
    p.ground_vel = 0;
    p.anim = 0x15;
    p.move_lock = 35;
    p.jumping = 0;
    p.status &= ~(S_PUSH | S_ROLLJUMP);
    if (p.status & S_ROLL) {
      // Obj_Sonic
      p.status &= ~S_ROLL;
      p.y_radius = 0x13;
      p.x_radius = 9;
      p.y_pos = s16(p.y_pos - 5);
    }
    if (this.routine === 6) return;
    this.routine = 6;
    this.anim = (this.anim + 4) & 0xff;
  }

  // loc_2E166: the spawner
  spawner() {
    const game = this.game, m = game.ram;
    const wl = u16(m.w(R.Water_level));
    let doAnim = true;
    if (this.f36 === 0) {
      if (wl >= u16(this.y_pos) || !(this.render_flags & 0x80)) { doAnim = false; }
      else {
        this.f38 = s16(this.f38 - 1);
        if (this.f38 >= 0) { /* loc_2E266 */ }
        else {
          this.f36 = 1;
          let d0, d1;
          do { d0 = randomNumber(m); d1 = d0; d0 &= 7; } while (d0 >= 6); // loc_2E18E
          this.f34 = d0;
          this.f3c = BUBBLER_TABLE + (d1 & 0xc);
          this.f32 = s8(this.f32 - 1);
          if (this.f32 < 0) {
            this.f32 = this.f33;
            this.f36 |= 0x8000;
          }
          this.emit();
        }
      }
    } else {
      // loc_2E1C8
      this.f38 = s16(this.f38 - 1);
      if (this.f38 < 0) this.emit();
    }
    if (doAnim) this.animateSprite(ANI_BUBBLER); // loc_2E266
    // loc_2E272
    if (this.outOfRange()) return this.unload();
    if (wl < u16(this.y_pos)) this.display();
  }

  // loc_2E1D0
  emit() {
    const game = this.game, m = game.ram, rom = game.rom;
    this.f38 = randomNumber(m) & 0x1f;
    const b = new Bubbler(game, { x: this.x_pos, y: this.y_pos });
    b.x_pos = s16(b.x_pos + (randomNumber(m) & 0xf) - 8);
    b.subtype = rom.u8at(this.f3c + this.f34);
    if (this.f36 & 0x8000) {
      let skip = false;
      if ((randomNumber(m) & 3) === 0) {
        if (this.f36 & 0x4000) skip = true;
        else { this.f36 |= 0x4000; b.subtype = 2; }
      }
      // loc_2E236
      if (!skip && this.f34 === 0 && !(this.f36 & 0x4000)) {
        this.f36 |= 0x4000;
        b.subtype = 2;
      }
    }
    game.core.spawn(b);
    // loc_2E24A
    this.f34 = s8(this.f34 - 1);
    if (this.f34 < 0) {
      this.f38 = s16(this.f38 + (randomNumber(m) & 0x7f) + 0x80);
      this.f36 = 0;
    }
  }
}

// ============================================================================ HCZWaveSplash
// Obj_HCZWaveSplash (loc_1CEA4): two copies of the surface sprite $C0 apart (multi-sprite
// main + 1 child), following the camera in steps of $20 and shifted by $20 every other
// frame. Pausing (the +3 frame offset) isn't handled.
class HCZWaveSplash extends Obj {
  constructor(game) {
    super(game, {});
    this.mappings = game.maps(MAP_HCZWAVESPLASH);
    this.art_tile = 0x8000 | ARTTILE_HCZWAVESPLASH;
    this.render_flags = 4 | 0x40;
    this.width_pixels = 0x80;
    this.height_pixels = 8;
    this.priority = 0; // never set by Obj_HCZWaveSplash: 0 = in front of all other sprites
  }
  update() {
    const m = this.game.ram;
    let d1 = (m.w(R.Camera_X_pos) & 0xffe0) + 0x60;
    if (m.uw(R.Level_frame_counter) & 1) d1 += 0x20;
    this.x_pos = d1;
    this.y_pos = m.w(R.Water_level);
    this.anim_frame_timer = s8(this.anim_frame_timer - 1);
    if (this.anim_frame_timer < 0) {
      this.anim_frame_timer = 9;
      this.mapping_frame++;
      if (this.mapping_frame >= 4) this.mapping_frame = 1;
    }
    this.display();
  }
  draw(vdp, cx, cy) {
    const pieces = this.mappings[this.mapping_frame];
    if (!pieces) return;
    vdp.addSprite(pieces, this.x_pos - cx, this.y_pos - cy, this.art_tile, false, false, this.priority);
    vdp.addSprite(pieces, this.x_pos + 0xc0 - cx, this.y_pos - cy, this.art_tile, false, false, this.priority);
  }
}

// ============================================================================ FireShieldDissipate
// Obj_FireShield_Dissipate (loc_1C2F8): left behind when the fire shield goes out underwater.
export class FireShieldDissipate extends Obj {
  constructor(game, x, y) {
    super(game, { x, y });
    this.mappings = game.maps(0x1c38a); // Map_Explosion
    this.art_tile = 0x5a0; // make_art_tile(ArtTile_Explosion,0,0)
    this.priority = 0x280;
    this.width_pixels = 0xc;
    this.height_pixels = 0xc;
    this.anim_frame_timer = 3;
    this.mapping_frame = 1;
  }
  update() {
    this.moveSprite2();
    this.anim_frame_timer = s8(this.anim_frame_timer - 1);
    if (this.anim_frame_timer < 0) {
      this.anim_frame_timer = 3;
      if (++this.mapping_frame === 5) return this.delete();
    }
    this.display();
  }
}
