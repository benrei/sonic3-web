// Game loop glue: level, player, camera, rings, objects, HUD.
import { ADDR, ART_TILE, ZONES } from './rom.js';
import { Level } from './level.js';
import { VDP, SCREEN_W, SCREEN_H } from './vdp.js';
import { Player } from './player.js';
import { createObject } from './objects.js';
import { TileAnimator } from './animate.js';
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
    this.invincible = 0;
    this.speedShoes = 0;
    this.shield = 0;
    this.checkpoint = state.checkpoint ?? null;
    this.effects = [];
    this.scattered = [];
    this.standingOn = null;
    this.rhinoSlot = 0;
    this.titleCard = 150;
    this.actClear = 0;
    this.gameOver = false;
    this.deathTimer = 0;
    this.messages = [];
    this.spawnPlayer();
    this.objects = [];
    for (const d of this.level.objects) {
      const o = createObject(this, d);
      if (o) this.objects.push(o);
    }
    // the level's end trigger: the AIZ1 miniboss cutscene object, otherwise near the right edge
    const boss = this.level.objects.find((o) => o.id === 128 || o.id === 169);
    this.endX = boss ? boss.x : this.level.bounds.maxX + 320 - 0x80;
    this.ringState = this.level.rings.map((r) => ({ ...r }));
    this.ringFrame = 0;
    this.ringTimer = 0;
    this.camX = 0;
    this.camY = 0;
    this.centerCamera();
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

  centerCamera() {
    const b = this.level.bounds;
    this.camX = clamp(this.player.x_pos - 160, b.minX, b.maxX);
    this.camY = clamp(this.player.y_pos - 96, b.minY, b.maxY);
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
      if (p.status & STATUS_ON_OBJ && !this.standingOn) p.status &= ~STATUS_ON_OBJ;
      p.update(input);
      (this.shieldObj ??= new ShieldObject(this)).update(); // Obj_*Shield runs right after the player
    }
    if (p.dead || p.dying) this.handleDeath();
    this.soundEvents(p);

    if (this.invincible > 0) this.invincible--;

    this.dynamicResize();
    this.updateCamera();
    p.bounds = { minX: this.minX, maxX: this.level.bounds.maxX, minY: this.minY, maxY: this.maxY };
    if (!freeze) {
      const cx = this.camX;
      for (const o of this.objects) {
        if (!o.alive) continue;
        if (o.x < cx - 0x180 || o.x > cx + SCREEN_W + 0x180) { if (o.standing) { o.standing = false; this.standingOn = null; } continue; }
        o.update();
      }
      this.objects = this.objects.filter((o) => o.alive);
      if (this.standingOn && !this.standingOn.alive) { this.standingOn = null; p.status &= ~STATUS_ON_OBJ; }
      this.updateRings();
      this.updateEffects();
    }

    // reached the end of the act?
    if (!this.actClear && p.x_pos >= this.endX && !p.dead) {
      this.actClear = 1;
      this.score += Math.max(0, 50000 - Math.floor(this.time / 60) * 100) + this.rings * 100;
      this.sfx('clear');
    }
  }

  handleDeath() {
    this.deathTimer++;
    if (this.deathTimer === 1) this.sfx('death');
    if (this.deathTimer > 150) {
      this.lives--;
      if (this.lives < 0) { this.gameOver = true; return; }
      this.restartRequested = true;
    }
  }

  // Do_ResizeEvents: per-act camera boundary changes (only AIZ1 is ported).
  dynamicResize() {
    const b = this.level.bounds;
    if (this.minX === undefined) { this.minX = b.minX; this.minY = b.minY; this.maxY = b.maxY; this.targetMaxY = b.maxY; }
    if (this.zone.id === 0x000) {
      // AIZ1_Resize (loc_1A9EC / loc_1AA40) using Resize_MaxYFromX table word_1AA84
      let a = 0x1aa84, w, x;
      do { w = this.rom.u16(a); x = this.rom.u16(a + 2); a += 4; } while (this.camX > x);
      if (w & 0x8000) { w &= 0x7fff; if (this.maxY === undefined) this.maxY = w; }
      this.targetMaxY = w;
      this.minY = this.camX >= 0x2c00 ? 0x2e0 : 0;
      if (this.camX >= 0x2d80) this.minX = Math.max(this.minX, Math.min(this.camX, 0x2d80));
    }
    // ease Camera_max_Y_pos towards the target (2px/frame, 8 when falling)
    const d = this.targetMaxY - this.maxY;
    if (d < 0) this.maxY = Math.max(this.targetMaxY, Math.min(this.maxY, this.camY) - 2);
    else if (d > 0) this.maxY = Math.min(this.targetMaxY, this.maxY + ((this.player.status & STATUS_IN_AIR) ? 8 : 2));
  }

  soundEvents(p) {
    const prev = this.prevP || {};
    const air = !!(p.status & STATUS_IN_AIR);
    if (air && !prev.air && p.y_vel < -0x300 && p.anim === 2) this.sfx('jump');
    if (!p.spin_dash_flag && prev.spin) this.sfx('release');
    if (p.anim === 0x0d && prev.anim !== 0x0d) this.sfx('skid');
    if (p.hurting && !prev.hurting) this.sfx('hurt');
    if (!air && (p.status & 4) && !prev.roll && !p.spin_dash_flag && !prev.spin) this.sfx('roll');
    this.prevP = { air, spin: !!p.spin_dash_flag, anim: p.anim, hurting: p.hurting, roll: !!(p.status & 4) };
  }

  updateCamera() {
    const p = this.player, b = this.level.bounds;
    if (p.dead) return;
    // horizontal: keep player between x 144 and 160 (max 24px/frame)
    const dx = p.x_pos - this.camX;
    if (dx > 160) this.camX += Math.min(dx - 160, 24);
    else if (dx < 144) this.camX -= Math.min(144 - dx, 24);
    // vertical
    const bias = 96 - (p.cameraLookOffset || 0);
    const dy = p.y_pos - this.camY - bias;
    if (p.status & STATUS_IN_AIR) {
      if (dy > 32) this.camY += Math.min(dy - 32, 24);
      else if (dy < -32) this.camY -= Math.min(-32 - dy, 24);
    } else {
      const max = Math.abs(p.ground_vel) >= 0x800 ? 24 : 6;
      if (dy > 0) this.camY += Math.min(dy, max);
      else if (dy < 0) this.camY -= Math.min(-dy, max);
    }
    this.camX = clamp(this.camX, this.minX ?? b.minX, Math.max(b.minX, b.maxX));
    this.camY = clamp(this.camY, this.minY ?? b.minY, this.maxY ?? b.maxY);
  }

  // --- rings ---------------------------------------------------------------
  updateRings() {
    const p = this.player;
    if (++this.ringTimer >= 8) { this.ringTimer = 0; this.ringFrame = (this.ringFrame + 1) & 3; }
    if (p.dead) return;
    const yr = p.y_radius - 3;
    const canCollect = !p.invulnerable_time || p.invulnerable_time < 0x78 - 64;
    for (const r of this.ringState) {
      if (r.collected) {
        if (r.sparkle !== undefined && r.sparkle < 24) r.sparkle++;
        continue;
      }
      if (Math.abs(r.x - this.camX - 160) > 200 || Math.abs(r.y - this.camY - 112) > 160) continue;
      if (canCollect && Math.abs(r.x - p.x_pos) < 8 + 6 && Math.abs(r.y - p.y_pos) < yr + 6) {
        r.collected = true;
        r.sparkle = 0;
        this.collectRing();
      }
    }
    // scattered rings (Obj_Bouncing_Ring)
    const L = this.level;
    for (const s of this.scattered) {
      s.life--;
      s.vy += 0x18;
      s.x += s.vx / 256;
      s.y += s.vy / 256;
      if (s.vy > 0 && L.solidAt(s.x, s.y + 8, 0)) { s.vy = -((s.vy * 3) >> 2); s.y -= 1; }
      if (s.life < 0x100 - 64 && Math.abs(s.x - p.x_pos) < 14 && Math.abs(s.y - p.y_pos) < yr + 6 && !p.dead) {
        s.life = 0;
        this.effects.push({ kind: 'sparkle', x: s.x, y: s.y, t: 0 });
        this.collectRing();
      }
    }
    this.scattered = this.scattered.filter((s) => s.life > 0);
  }

  collectRing(n = 1) {
    const before = this.rings;
    this.rings = Math.min(999, this.rings + n);
    if (Math.floor(this.rings / 100) > Math.floor(before / 100)) { this.lives++; this.sfx('1up'); }
    else this.sfx('ring');
  }

  // Called by the player when hurt: returns true if there were rings to lose.
  loseRings() {
    if (this.shield) { this.shield = 0; return true; }
    const n = Math.min(this.rings, 32);
    if (n === 0) return false;
    const p = this.player;
    // RingLoss spill pattern: two circles of 16 rings
    let angle = 0x288 & 0xff, speed = 4;
    let xflip = false;
    for (let i = 0; i < n; i++) {
      if (i === 16) { speed = 2; angle = 0x288 & 0xff; }
      const a = (angle / 256) * Math.PI * 2;
      let vx = Math.round(Math.cos(a) * speed * 256), vy = Math.round(-Math.abs(Math.sin(a)) * speed * 256);
      if (xflip) { vx = -vx; angle = (angle + 0x10) & 0xff; }
      xflip = !xflip;
      this.scattered.push({ x: p.x_pos, y: p.y_pos, vx, vy, life: 0xff });
    }
    this.rings = 0;
    this.sfx('ringloss');
    return true;
  }

  hurtPlayer(srcX) {
    const p = this.player;
    if (this.invincible > 0 || p.invulnerable_time || p.dead) return;
    p.hurt(srcX);
  }

  monitorReward(type) {
    switch (type) {
      case 1: this.lives++; this.sfx('1up'); break; // 1-up
      case 2: this.hurtPlayer(this.player.x_pos); break; // Eggman
      case 3: this.collectRing(10); break; // rings
      case 4: this.player.speedShoes = true; break;
      case 5: case 6: case 7: this.shield = type; this.sfx('shield'); break;
      case 8: this.invincible = 20 * 60; break;
      case 9: this.collectRing(50); break;
      default: break;
    }
    this.score += 10;
  }

  destroyBadnik(obj) {
    const p = this.player;
    this.spawnExplosion(obj.x, obj.y);
    this.sfx('destroy');
    this.score += 100;
    this.messages.push({ text: '100', x: obj.x, y: obj.y, t: 40 });
    // Touch_Enemy rebound
    if (p.status & STATUS_IN_AIR) {
      if (p.y_pos < obj.y && p.y_vel > 0) p.y_vel = -p.y_vel;
      else p.y_vel -= 0x100;
    }
  }

  spawnExplosion(x, y) {
    this.effects.push({ kind: 'explosion', x, y, t: 0 });
  }

  spawnProjectile(x, y, vx, vy, map, frame, art) {
    this.effects.push({ kind: 'projectile', x, y, vx, vy, map, frame, art, t: 0 });
  }

  updateEffects() {
    const p = this.player;
    for (const e of this.effects) {
      e.t++;
      if (e.kind === 'projectile') {
        e.vy += 0x20; e.x += e.vx / 256; e.y += e.vy / 256;
        if (!p.dead && Math.abs(e.x - p.x_pos) < 12 && Math.abs(e.y - p.y_pos) < p.y_radius) {
          if (this.shield) { e.t = 999; continue; }
          this.hurtPlayer(e.x);
          e.t = 999;
        }
        if (e.t > 180) e.t = 999;
      }
    }
    this.effects = this.effects.filter((e) => (e.kind === 'explosion' ? e.t < 30 : e.kind === 'sparkle' ? e.t < 24 : e.t < 999));
    for (const m of this.messages) { m.t--; m.y -= 1; }
    this.messages = this.messages.filter((m) => m.t > 0);
  }

  // --- rendering -------------------------------------------------------------
  render() {
    const vdp = this.vdp, cx = this.camX | 0, cy = this.camY | 0;
    // Sonic first so he's in front of objects with the same priority (lower order = front)
    this.drawPlayer(cx, cy);
    for (const o of this.objects) {
      if (o.x < cx - 0x80 || o.x > cx + SCREEN_W + 0x80) continue;
      o.draw(vdp, cx, cy);
    }
    this.drawRings(cx, cy);
    this.drawEffects(cx, cy);
    this.drawHUD();
    const [bgH, bgV] = this.backgroundScroll(cx, cy);
    vdp.render(cx, cy, bgH, bgV);
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

  drawRings(cx, cy) {
    const vdp = this.vdp, art = ART_TILE.Ring | 0x2000;
    for (const r of this.ringState) {
      const sx = r.x - cx, sy = r.y - cy;
      if (sx < -16 || sx > SCREEN_W + 16 || sy < -16 || sy > SCREEN_H + 16) continue;
      if (r.collected) {
        if (r.sparkle < 24) vdp.addSprite(this.ringMap[4 + (r.sparkle >> 3)], sx, sy, art, false, false, 0x80);
        continue;
      }
      vdp.addSprite(this.ringMap[this.ringFrame], sx, sy, art, false, false, 0x80);
    }
    const fast = (this.frameCount >> 1) & 3;
    for (const s of this.scattered) {
      if (s.life < 64 && (s.life & 2)) continue;
      vdp.addSprite(this.ringMap[fast], s.x - cx, s.y - cy, art, false, false, 0x80);
    }
  }

  drawEffects(cx, cy) {
    const vdp = this.vdp;
    for (const e of this.effects) {
      if (e.kind === 'explosion') {
        const f = Math.min(4, Math.floor(e.t / 6));
        if (this.explosionMap[f]) vdp.addSprite(this.explosionMap[f], e.x - cx, e.y - cy, ART_TILE.Explosion, false, false, 0x80);
      } else if (e.kind === 'sparkle') {
        vdp.addSprite(this.ringMap[4 + Math.min(3, e.t >> 3)], e.x - cx, e.y - cy, ART_TILE.Ring | 0x2000, false, false, 0x80);
      } else if (e.kind === 'projectile' && e.map[e.frame]) {
        vdp.addSprite(e.map[e.frame], e.x - cx, e.y - cy, e.art, false, false, 0x100);
      }
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

  backgroundScroll(cx, cy) {
    const z = this.zone.id;
    if (z === 0x000) {
      // AIZ1_Deform: layered parallax ((camX-$1300) * 7/16 .. 10/16). The jungle band of the
      // BG layout lives at y $200-$37F; map the camera's vertical range onto it.
      const base = cx - 0x1300;
      const range = Math.max(1, (this.maxY ?? this.level.bounds.maxY) - this.level.bounds.minY);
      const bgY = 0x200 + Math.round(((cy - this.level.bounds.minY) / range) * (0x380 - 0x200 - SCREEN_H));
      return [
        (line) => {
          const f = line < 64 ? 7 / 32 : line < 128 ? 8 / 32 : line < 176 ? 9 / 16 : 10 / 16;
          return Math.floor(base * f);
        },
        (line) => bgY + line,
      ];
    }
    if (z === 0x001) {
      const bgY = Math.floor(cy * 0.25) + 0x80;
      return [(line) => Math.floor(cx * (line + bgY < 0x200 ? 0.25 : 0.5)), (line) => bgY + line];
    }
    const bgY = Math.floor(cy * 0.25);
    return [() => Math.floor(cx * 0.5), (line) => bgY + line];
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
