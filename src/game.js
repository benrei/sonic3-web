// Game loop glue: level, player, camera, rings, objects, HUD.
import { ADDR, ART_TILE, ZONES } from './rom.js';
import { Level } from './level.js';
import { VDP, SCREEN_W, SCREEN_H } from './vdp.js';
import { Player } from './player.js';
import { createObject, Projectile } from './objects.js';
import { ObjCore, Explosion } from './objcore.js';
import { TileAnimator } from './animate.js';
import { Ram, R } from './ram.js';
import { Camera } from './camera.js';
import { Scroll } from './scroll.js';
import { ShieldObject } from './shields.js';

const MAP_HUD = 0xe932;
const HUD_DIGITS = 0xeed2; // ArtUnc_HUDDigits: 8x16 glyphs, $40 bytes each
const LIVES_DIGITS = 0xeed2 + 0x300; // ArtUnc_LivesDigits
const MAP_EXPLOSION = 0x1c38a;
const STATUS_IN_AIR = 2, STATUS_ON_OBJ = 8;

export class Game {
  constructor(rom, zoneIndex, audio, state = {}) {
    this.rom = rom;
    this.zoneIndex = zoneIndex;
    this.zone = ZONES[zoneIndex];
    this.audio = audio;
    this.mapCache = new Map();
    this.level = new Level(rom, this.zone);
    this.vdp = new VDP(this.level);
    const z = this.zone.id;
    this.animator = new TileAnimator(rom, this.level, this.vdp, ((z >> 8) << 1) | (z & 1));
    this.player = new Player(rom, this.level);
    this.player.onRingLoss = () => this.loseRings();
    this.player.onSound = (name, n) => this.audio?.play(name, n);
    this.sonicMap = this.maps(ADDR.Map_Sonic);
    this.ringMap = this.maps(ADDR.Map_Ring);
    this.hudMap = this.maps(MAP_HUD);
    this.explosionMap = this.maps(MAP_EXPLOSION);
    this.lastDplcFrame = -1;
    this.rings = 0;
    this.score = state.score ?? 0;
    this.lives = state.lives ?? 3;
    this.time = 0; // frames
    this.frameCount = 0;
    this.checkpoint = state.checkpoint ?? null;
    this.rhinoSlot = 0;
    this.titleCard = 150;
    this.actClear = 0;
    this.gameOver = false;
    this.deathTimer = 0;
    this.spawnPlayer();
    // the level's end trigger: the AIZ1 miniboss cutscene object, otherwise near the right edge
    const boss = this.level.objects.find((o) => o.id === 128 || o.id === 169);
    this.endX = boss ? boss.x : this.level.bounds.maxX + 320 - 0x80;
    this.camX = 0;
    this.camY = 0;
    this.centerCamera();
    // object manager / ring manager / touch response (objcore.js); Load_Sprites runs here
    new ObjCore(this, createObject);
  }

  maps(addr) {
    let m = this.mapCache.get(addr);
    if (!m) { m = this.rom.mappings(addr); this.mapCache.set(addr, m); }
    return m;
  }

  spawnPlayer() {
    const p = this.player;
    if (this.checkpoint) {
      p.x_pos = this.checkpoint.x;
      p.y_pos = this.checkpoint.y;
      this.time = this.checkpoint.time;
    }
  }

  // Level init order of the original: Get_LevelSizeStart, DeformBgLayer, LevelSetup.
  centerCamera() {
    this.ram = new Ram(this.rom, this.level.layout);
    this.camera = new Camera(this, this.ram);
    this.scroll = new Scroll(this, this.ram);
    this.camera.levelSizeStart();
    this.camera.deformBgLayer();
    this.scroll.levelSetup();
    this.syncCamera();
  }

  // Mirror the RAM camera state into the fields the rest of the game uses.
  syncCamera() {
    const m = this.ram, p = this.player;
    this.camX = m.w(R.Camera_X_pos_copy);
    this.camY = m.w(R.Camera_Y_pos_copy);
    this.minX = m.w(R.Camera_min_X_pos);
    this.minY = m.w(R.Camera_min_Y_pos);
    this.maxY = m.w(R.Camera_max_Y_pos);
    p.bounds = { minX: this.minX, maxX: m.w(R.Camera_max_X_pos), minY: this.minY, maxY: this.maxY };
    p.cameraY = m.w(R.Camera_Y_pos);
  }

  sfx(name) { this.audio?.play(name); }

  // --- per-frame ---------------------------------------------------------
  update(input) {
    this.frameCount++;
    const p = this.player;
    if (this.titleCard > 0) this.titleCard--;
    this.animator.update();
    if (this.actClear > 0) {
      this.actClear++;
      if (this.actClear > 1) input = { held: { right: true }, pressed: {} };
    }
    if (this.gameOver) return;

    if (!p.dead && this.titleCard < 100) {
      if (!this.actClear && this.time < 10 * 60 * 60 - 1) this.time++;
    }
    const freeze = this.titleCard > 110;
    if (!freeze) {
      const control = p.routine === 2;
      p.update(input);
      // Sonic_Control ends with TouchResponse (rings, shield deflection, object touches)
      if (control && !(p.object_control & 0xa0)) this.core.touchResponse();
      (this.shieldObj ??= new ShieldObject(this)).update(); // Obj_*Shield runs right after the player
    }
    if (p.dead || p.dying) this.handleDeath();
    this.soundEvents(p);

    // Process_Sprites: level objects run after the player, before the camera moves
    if (!freeze) this.core.runObjects();

    this.updateCamera();
    // Load_Rings, OscillateNumDo, ChangeRingFrame, Render_Sprites flags, Load_Sprites
    if (!freeze) this.core.afterCamera();

    // reached the end of the act?
    if (!this.actClear && p.x_pos >= this.endX && !p.dead) {
      this.actClear = 1;
      this.score += Math.max(0, 50000 - Math.floor(this.time / 60) * 100) + this.rings * 100;
      this.sfx('clear');
    }
  }

  handleDeath() {
    this.deathTimer++;
    if (this.deathTimer > 150) {
      this.lives--;
      if (this.lives < 0) { this.gameOver = true; return; }
      this.restartRequested = true;
    }
  }

  // Sound effects are played by the player code itself at the original Play_SFX
  // call sites (player.onSound); nothing to infer from state changes here.
  soundEvents() {}


  // DeformBgLayer (camera, Do_ResizeEvents) + water height + ScreenEvents (plane drawing,
  // deformation); see camera.js / scroll.js / zones/.
  updateCamera() {
    this.camera.update();
    this.scroll.screenEvents();
    this.syncCamera();
  }

  // --- rings / hurt / power-ups (see objcore.js for the ported routines) -----
  get objects() { return this.core.objects; }
  // status_secondary is the source of truth for shields / invincibility
  get invincible() { return this.player.status_secondary & 2 ? this.player.invincibility_timer || 1 : 0; }
  set invincible(v) { /* derived from player.status_secondary */ }
  get shield() { return this.player.status_secondary & 1 ? this.player.status_secondary & 0x71 : 0; }
  set shield(v) { /* derived from player.status_secondary */ }

  collectRing() { this.core.giveRing(); }

  // HurtCharacter callback: spawns Obj_Bouncing_Ring (RingLoss) if there are rings.
  loseRings() {
    if (this.rings === 0) return false;
    this.core.ringLoss();
    return true;
  }

  hurtPlayer(srcX) {
    const p = this.player;
    if ((p.status_secondary & 2) || p.invulnerable_time || p.dead) return;
    this.core.hurtCharacter(srcX);
  }

  // Obj_MonitorContents reward (off_1B69C)
  monitorReward(type, icon) {
    const p = this.player, core = this.core;
    switch (type) {
      case 1: // Monitor_Give_1up
        this.lives++;
        this.sfx('1up');
        break;
      case 0: case 2: { // Monitor_Give_Eggman -> sub_228EC
        if ((p.status_secondary & 2) || p.invulnerable_time || p.routine >= 4) break;
        p._y = (p._y - (p.y_vel << 8)) | 0;
        core.hurtCharacter(icon ? icon.x_pos : p.x_pos);
        break;
      }
      case 3: { // Monitor_Give_Rings
        this.rings = Math.min(999, this.rings + 10);
        let life = false;
        if (this.rings >= 100) {
          if (!(core.extraLifeFlags & 2)) { core.extraLifeFlags |= 2; life = true; }
          else if (this.rings >= 200 && !(core.extraLifeFlags & 4)) { core.extraLifeFlags |= 4; life = true; }
        }
        if (life) { this.lives++; this.sfx('1up'); } else this.sfx('ring');
        break;
      }
      case 4: // Monitor_Give_SpeedShoes (timer (20*60)/8, Max_speed $C00 ...)
        p.speedShoes = true;
        break;
      case 5: case 6: case 7: // Monitor_Give_Fire/Lightning/BubbleShield
        p.status_secondary = (p.status_secondary & 0x8e) | 1 | ({ 5: 0x10, 6: 0x20, 7: 0x40 })[type];
        this.sfx('shield');
        break;
      case 8: // Monitor_Give_Invincibility
        p.status_secondary |= 2;
        p.invincibility_timer = (20 * 60) / 8;
        break;
      case 9: // Monitor_Give_SuperSonic (only the rings + invincibility part)
        this.rings = Math.min(999, this.rings + 50);
        p.status_secondary |= 2;
        break;
      default: break;
    }
  }

  spawnExplosion(x, y) { this.core.spawn(new Explosion(this, x, y, 2)); }

  spawnProjectile(x, y, vx, vy, map, frame, art) {
    this.core.spawn(new Projectile(this, x, y, vx, vy, map, frame, art));
  }

  // --- rendering -------------------------------------------------------------
  render() {
    const vdp = this.vdp, cx = this.camX | 0, cy = this.camY | 0;
    // Sonic first so he's in front of objects with the same priority (lower order = front)
    this.drawPlayer(cx, cy);
    this.core.draw(vdp, cx, cy); // Render_Rings + displayed objects
    this.drawHUD();
    vdp.renderScroll(this.scroll.scrollLines());
    this.drawOverlays();
  }

  drawPlayer(cx, cy) {
    const p = this.player;
    const frame = p.mapping_frame | 0;
    if (frame !== this.lastDplcFrame) {
      this.lastDplcFrame = frame;
      this.loadPlayerArt(frame);
    }
    // shield / insta-shield object (updated here, once per rendered game frame)
    this.shieldObj?.draw(this.vdp, cx, cy);
    if (p.visible === false && !p.dying) return;
    const pieces = this.sonicMap[frame];
    if (!pieces) return;
    const art = ART_TILE.Player_1 | (p.highPriority ? 0x8000 : 0);
    this.vdp.addSprite(pieces, p.x_pos - cx, p.y_pos - cy, art, !!p.flipX, !!p.flipY, 0x100);
    const invincible = this.invincible > 0 || (p.status_secondary & 0x02);
    if (invincible) this.drawAura(p.x_pos - cx, p.y_pos - cy);
  }

  // Sonic_Load_PLC: copy the frame's tiles from ArtUnc_Sonic into VRAM.
  loadPlayerArt(frame) {
    const rom = this.rom;
    const base = ADDR.PLC_Sonic;
    const o = base + rom.u16(base + frame * 2);
    const n = rom.u16(o);
    let v = ART_TILE.Player_1 * 32;
    for (let i = 0; i < n && i < 32; i++) {
      const w = rom.u16(o + 2 + i * 2);
      const count = (w >> 12) + 1;
      const src = ADDR.ArtUnc_Sonic + (w & 0xfff) * 32;
      this.vdp.writeVram(v, rom.u8.subarray(src, src + count * 32));
      v += count * 32;
    }
  }

  // Perform_DPLC for slotted badniks (count-1 word, entries: tile<<4 | (n-1)).
  objectDPLC(artBase, table, frame, artTile) {
    const rom = this.rom;
    const o = table + rom.u16(table + frame * 2);
    const n = rom.u16(o) + 1;
    let v = (artTile & 0x7ff) * 32;
    for (let i = 0; i < n && i < 32; i++) {
      const w = rom.u16(o + 2 + i * 2);
      const count = (w & 15) + 1;
      const src = artBase + (w >> 4) * 32;
      this.vdp.writeVram(v, rom.u8.subarray(src, src + count * 32));
      v += count * 32;
    }
  }

  drawAura(sx, sy) {
    // simple sparkle ring for shields / invincibility (the real ones are separate objects)
    const t = this.frameCount;
    const pieces = this.ringMap[4 + ((t >> 2) & 3)];
    for (let i = 0; i < 4; i++) {
      const a = t / 8 + (i * Math.PI) / 2;
      this.vdp.addSprite(pieces, sx + Math.round(Math.cos(a) * 18), sy + Math.round(Math.sin(a) * 18), ART_TILE.Ring | 0x2000 | 0x8000, false, false, 0x80);
    }
  }

  // HUD: write digit glyphs into VRAM like HUD_Update, then draw Map_HUD.
  drawHUD() {
    const writeGlyphs = (tile, str) => {
      let v = tile * 32;
      for (const ch of str) {
        const idx = ch === ' ' ? -1 : ch === ':' ? 10 : ch === 'E' ? 11 : ch.charCodeAt(0) - 48;
        const data = idx < 0 ? new Uint8Array(64) : this.rom.u8.subarray(HUD_DIGITS + idx * 64, HUD_DIGITS + idx * 64 + 64);
        this.vdp.writeVram(v, data);
        v += 64;
      }
    };
    const R = ART_TILE.Ring;
    const sc = Math.min(999999, Math.floor(this.score / 10));
    writeGlyphs(R + 0x26, 'E' + (sc ? String(sc) : '').padStart(6, ' ') + '0');
    const secs = Math.floor(this.time / 60);
    writeGlyphs(R + 0x36, `${Math.min(9, Math.floor(secs / 60))}:${String(secs % 60).padStart(2, '0')}`);
    writeGlyphs(R + 0x3e, String(this.rings).padStart(3, ' '));
    // lives: two 8x8 digits at ArtTile_PlayerLifeIcon+9 and +11
    const lives = Math.max(0, Math.min(99, this.lives));
    const lv = String(lives).padStart(2, ' ');
    let v = (0x7d4 + 9) * 32;
    for (const ch of lv) {
      const d = ch === ' ' ? null : this.rom.u8.subarray(LIVES_DIGITS + (+ch) * 32, LIVES_DIGITS + (+ch) * 32 + 32);
      this.vdp.writeVram(v, d ?? new Uint8Array(32));
      v += 64; // HUD_Lives: digits are $40 bytes apart (tiles +9 and +11)
    }
    // frame 0 normal; flashing red RINGS (frame 1) when zero rings, TIME (2) after 9 minutes
    const flash = (this.frameCount >> 3) & 1;
    let f = 0;
    if (this.rings === 0 && flash) f = 1;
    this.vdp.addSprite(this.hudMap[f], 0x8f - 0x80, 0x108 - 0x80, 0x8000 | (R + 0xe), false, false, 0);
  }

  // Text overlays rendered straight into the framebuffer (title card / act clear).
  drawOverlays() {
    this.overlay = null;
    if (this.titleCard > 0) this.overlay = { kind: 'title', t: this.titleCard };
    else if (this.actClear > 0) this.overlay = { kind: 'clear', t: this.actClear };
    else if (this.gameOver) this.overlay = { kind: 'gameover' };
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
