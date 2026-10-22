// Level objects. Behaviour is a simplified port of the original object code
// (Obj_PathSwap, Obj_Monitor, Obj_Spring, Obj_Spikes, badniks, ...); art and
// mappings are always taken from the ROM.

const STATUS_FACING_LEFT = 1, STATUS_IN_AIR = 2, STATUS_ROLL = 4, STATUS_ON_OBJ = 8, STATUS_PUSH = 0x20;

export const MAP = {
  PathSwap: 0x1b372,
  Monitor: 0x1b958,
  Spring: 0x21dea,
  Spring2: 0x21f92,
  Spikes: 0x22a5c,
  Rock: 0x1dcdc,
  StarPost: 0x2c7be,
  FloatingPlatform: 0x24598,
  CollapsingPlatform: 0x1e6c8,
  Rhinobot: 0x1615a8,
  Bloominator: 0x1616c0,
  MonkeyDude: 0x161776,
  Plant: 0x2b8ec,
  Explosion: null,
};

// Player helpers ------------------------------------------------------------

function playerBox(p) {
  return { l: p.x_pos - 8, r: p.x_pos + 8, t: p.y_pos - p.y_radius + 3, b: p.y_pos + p.y_radius - 3 };
}
function overlap(p, x, y, hw, hh) {
  const b = playerBox(p);
  return b.r > x - hw && b.l < x + hw && b.b > y - hh && b.t < y + hh;
}
// Attacking = rolling/jumping (anim 2 = roll), or invincible.
function isAttacking(p, game) {
  return p.anim === 2 || (p.status & STATUS_ROLL) !== 0 || game.invincible > 0;
}

// Generic solid object (simplified SolidObjectFull). Returns side touched:
// 'top' | 'bottom' | 'left' | 'right' | null.
export function solidObject(game, obj, hw, hTop, hBot = hTop, topOnly = false) {
  const p = game.player;
  if (p.dead) return null;
  if (obj.standing) {
    // keep player on top while standing (MvSonicOnPtfm)
    const dx = p.x_pos - obj.x;
    if ((p.status & STATUS_IN_AIR) || Math.abs(dx) > hw + 8 || game.standingOn !== obj) {
      obj.standing = false;
      if (game.standingOn === obj) {
        game.standingOn = null;
        p.status &= ~STATUS_ON_OBJ;
        if (!(p.status & STATUS_IN_AIR)) p.status |= STATUS_IN_AIR;
      }
      return null;
    }
    p.y_pos = obj.y - hTop - p.y_radius;
    return 'top';
  }
  const pw = 10;
  const l = obj.x - hw - pw, r = obj.x + hw + pw;
  const t = obj.y - hTop - p.y_radius, b = obj.y + hBot + p.y_radius;
  const px = p.x_pos, py = p.y_pos;
  if (px <= l || px >= r || py <= t || py >= b) return null;
  const dTop = py - t, dBot = b - py, dL = px - l, dR = r - px;
  const minY = Math.min(dTop, dBot), minX = Math.min(dL, dR);
  if (topOnly) {
    if (p.y_vel >= 0 && dTop <= 16) return land(game, obj, hTop);
    return null;
  }
  if (minY <= minX || minY < 6) {
    if (dTop <= dBot) {
      if (p.y_vel >= 0) return land(game, obj, hTop);
      return null;
    }
    if (p.y_vel < 0) {
      p.y_pos = b;
      p.y_vel = 0;
    }
    return 'bottom';
  }
  // side
  const fromLeft = dL < dR;
  p.x_pos = fromLeft ? l : r;
  if ((fromLeft && p.x_vel > 0) || (!fromLeft && p.x_vel < 0)) {
    p.x_vel = 0;
    p.ground_vel = 0;
    if (!(p.status & STATUS_IN_AIR)) p.status |= STATUS_PUSH;
  }
  return fromLeft ? 'left' : 'right';
}

function land(game, obj, hTop) {
  const p = game.player;
  p.y_pos = obj.y - hTop - p.y_radius;
  if (p.status & STATUS_IN_AIR) {
    // RideObject_SetRide: land on the object like Player_TouchFloor
    p.ground_vel = p.x_vel;
    p.y_vel = 0;
    p.angle = 0;
    if (typeof p._touchFloorCheckSpindash === 'function') p._touchFloorCheckSpindash();
    else p.status &= ~STATUS_IN_AIR;
    p.y_pos = obj.y - hTop - p.y_radius;
  }
  p.y_vel = 0;
  p.angle = 0;
  p.status |= STATUS_ON_OBJ;
  obj.standing = true;
  if (game.standingOn && game.standingOn !== obj) game.standingOn.standing = false;
  game.standingOn = obj;
  return 'top';
}

// Objects -----------------------------------------------------------------

class Obj {
  constructor(game, d) {
    Object.assign(this, { x: d.x, y: d.y, xflip: !!d.xflip, yflip: !!d.yflip, id: d.id, subtype: d.subtype });
    this.game = game;
    this.alive = true;
    this.frame = 0;
    this.order = 0x200;
  }
  update() {}
  draw(vdp, cx, cy) {
    if (!this.map) return;
    const pieces = this.map[this.frame];
    if (pieces) vdp.addSprite(pieces, this.x - cx, this.y - cy, this.art, this.xflip, this.yflip, this.order);
  }
}

// Obj_PathSwap ($1AFC2): invisible collision-layer switcher.
class PathSwap extends Obj {
  constructor(game, d) {
    super(game, d);
    this.vertical = (this.subtype & 4) !== 0;
    this.size = [0x20, 0x40, 0x80, 0x100][this.subtype & 3];
    const p = game.player;
    this.side = this.vertical ? (p.y_pos >= this.y ? 1 : 0) : (p.x_pos >= this.x ? 1 : 0);
  }
  update() {
    const p = this.game.player, s = this.subtype;
    const along = this.vertical ? p.y_pos : p.x_pos;
    const pos = this.vertical ? this.y : this.x;
    const cross = this.vertical ? p.x_pos : p.y_pos;
    const crossPos = this.vertical ? this.x : this.y;
    const now = along >= pos ? 1 : 0;
    if (now === this.side) return;
    this.side = now;
    if (cross < crossPos - this.size || cross >= crossPos + this.size) return;
    if ((s & 0x80) && (p.status & STATUS_IN_AIR)) return;
    if (!this.xflip) {
      const second = now ? (s & 8) : (s & 0x10);
      p.top_solid_bit = second ? 0xe : 0xc;
      p.lrb_solid_bit = second ? 0xf : 0xd;
    }
    p.highPriority = !!(now ? (s & 0x20) : (s & 0x40));
  }
}

// Obj_Monitor: solid box, breaks when rolled into or jumped on.
class Monitor extends Obj {
  constructor(game, d) {
    super(game, d);
    this.map = game.maps(MAP.Monitor);
    this.art = 0x4c4;
    this.order = 0x180;
    this.broken = false;
    this.timer = 0;
    this.animIndex = 0;
    this.icon = null;
  }
  update() {
    const g = this.game, p = g.player;
    if (this.broken) {
      if (this.icon) {
        this.icon.y += this.icon.vy;
        this.icon.vy = Math.min(0, this.icon.vy + 0x18 / 256);
        if (++this.icon.t > 60) this.icon = null;
      }
      this.frame = 0xb;
      solidObject(g, this, 15, 0, 0, true);
      return;
    }
    // Ani_Monitor: [0, icon, icon, 1, icon, icon] at 2 ticks per frame
    if (++this.timer >= 2) {
      this.timer = 0;
      this.animIndex = (this.animIndex + 1) % 6;
    }
    const icon = this.subtype + 1;
    this.frame = [0, icon, icon, 1, icon, icon][this.animIndex];
    // Rolling player breaks it (touch response) instead of being blocked
    if (isAttacking(p, g) && overlap(p, this.x, this.y, 14, 16) && !this.standing) {
      if (p.y_vel < 0 && p.y_pos > this.y + 4) {
        // hit from below: monitor bounces (simplified: just block)
        solidObject(g, this, 0x19 - 10, 16, 17);
        return;
      }
      this.break();
      return;
    }
    solidObject(g, this, 0x19 - 10, 16, 17);
  }
  break() {
    const g = this.game, p = g.player;
    this.broken = true;
    if (this.standing) { this.standing = false; g.standingOn = null; }
    if (p.status & STATUS_IN_AIR) p.y_vel = -Math.abs(p.y_vel); // Touch_Monitor: rebound
    g.spawnExplosion(this.x, this.y - 2);
    g.sfx('destroy');
    this.icon = { y: this.y - 4, vy: -3, t: 0, frame: this.subtype + 1 };
    g.monitorReward(this.subtype);
  }
  draw(vdp, cx, cy) {
    super.draw(vdp, cx, cy);
    if (this.icon) {
      // only the icon part of the frame (last piece is the screen) - draw the whole frame small offset
      const pieces = this.map[this.icon.frame];
      if (pieces) vdp.addSprite(pieces.slice(0, 1), this.x - cx, this.icon.y - cy - 0, this.art, false, false, 0x100);
    }
  }
}

// Obj_Spring: up / horizontal / down. Red = -$1000, yellow = -$A00.
class Spring extends Obj {
  constructor(game, d) {
    super(game, d);
    const yellow = (this.subtype & 2) !== 0;
    this.map = game.maps(yellow ? MAP.Spring2 : MAP.Spring);
    this.power = yellow ? 0xa00 : 0x1000;
    this.kind = (this.subtype >> 4) & 7; // 0 up, 1 horizontal, 2 down, 3/4 diagonal
    this.art = 0x4a4;
    this.baseFrame = 0;
    if (this.kind === 1) { this.art = 0x4b4; this.baseFrame = 3; }
    if (this.kind === 2) { this.baseFrame = 6; this.yflip = true; }
    this.frame = this.baseFrame;
    this.anim = 0;
  }
  update() {
    const g = this.game, p = g.player;
    if (this.anim > 0) { this.anim--; this.frame = this.baseFrame + (this.anim > 4 ? 2 : 1); }
    else this.frame = this.baseFrame;
    if (this.kind === 1) {
      const side = solidObject(g, this, 8, 16, 16);
      const facingRight = !this.xflip;
      if ((side === 'right' && !facingRight) || (side === 'left' && facingRight) ||
          (overlap(p, this.x, this.y, 12, 14) && !(p.status & STATUS_IN_AIR))) {
        const dir = facingRight ? 1 : -1;
        if (Math.sign(p.x_pos - this.x) === dir || side) {
          p.springLaunch(dir * this.power, 0);
          if (dir > 0) p.status &= ~STATUS_FACING_LEFT; else p.status |= STATUS_FACING_LEFT;
          this.anim = 8;
          g.sfx('spring');
        }
      }
      return;
    }
    if (this.kind === 2) {
      const side = solidObject(g, this, 16, 8, 8);
      if (side === 'bottom') {
        p.springLaunch(p.x_vel, this.power);
        this.anim = 8;
        g.sfx('spring');
      }
      return;
    }
    const side = solidObject(g, this, 16, 8, 8);
    if (side === 'top' && this.standing) {
      this.standing = false;
      g.standingOn = null;
      p.status &= ~STATUS_ON_OBJ;
      p.y_pos -= 8;
      p.springLaunch(p.x_vel, -this.power);
      this.anim = 8;
      g.sfx('spring');
    }
  }
}

// Obj_Spikes: solid, hurts on the pointed side.
class Spikes extends Obj {
  constructor(game, d) {
    super(game, d);
    this.map = game.maps(MAP.Spikes);
    const idx = (this.subtype >> 4) & 7;
    this.frame = idx;
    this.sideways = idx >= 4;
    this.art = this.sideways ? 0x494 : 0x49c;
    const sizes = [[0x10, 0x10], [0x20, 0x10], [0x30, 0x10], [0x40, 0x10], [0x10, 0x10], [0x10, 0x20], [0x10, 0x30], [0x10, 0x40]];
    [this.hw, this.hh] = sizes[idx];
    this.hw -= 4;
  }
  update() {
    const g = this.game, p = g.player;
    const side = solidObject(g, this, this.hw, this.hh, this.hh);
    if (!side) return;
    let hurts;
    if (this.sideways) hurts = this.xflip ? side === 'left' : side === 'right';
    else hurts = this.yflip ? side === 'bottom' : side === 'top';
    if (hurts && g.invincible <= 0 && !p.invulnerable_time) {
      if (side === 'top') { this.standing = false; g.standingOn = null; p.status &= ~STATUS_ON_OBJ; }
      g.hurtPlayer(this.x, true);
    }
  }
}

// Obj_InvisibleBlock: solid box sized by subtype (only visible in debug mode).
class InvisibleBlock extends Obj {
  constructor(game, d) {
    super(game, d);
    this.hw = (((this.subtype >> 4) & 0xf) + 1) * 8;
    this.hh = ((this.subtype & 0xf) + 1) * 8;
  }
  update() { solidObject(this.game, this, this.hw, this.hh, this.hh); }
  draw() {}
}

// Obj_AIZLRZEMZRock: solid rock, broken by a rolling player (subtype selects size).
class Rock extends Obj {
  constructor(game, d) {
    super(game, d);
    this.map = game.maps(MAP.Rock);
    this.art = 0x2333; // make_art_tile(ArtTile_AIZMisc1,1,0)
    this.frame = (this.subtype >> 4) & 3;
    const sizes = [[0x10, 0x28], [0x18, 0x18], [0x10, 0x10], [0x10, 0x10]];
    [this.hw, this.hh] = sizes[this.frame] || [16, 16];
  }
  update() {
    const g = this.game, p = g.player;
    if (isAttacking(p, g) && Math.abs(p.ground_vel) >= 0x480 && overlap(p, this.x, this.y, this.hw + 4, this.hh)) {
      this.alive = false;
      g.spawnExplosion(this.x, this.y);
      g.sfx('destroy');
      return;
    }
    solidObject(g, this, this.hw, this.hh, this.hh);
  }
}

// Obj_FloatingPlatform (AIZ): top-solid platform moving on a sine path.
class FloatingPlatform extends Obj {
  constructor(game, d) {
    super(game, d);
    this.map = game.maps(MAP.FloatingPlatform);
    this.art = 0x43f7;
    this.bx = this.x; this.by = this.y;
    this.t = 0;
    this.kind = this.subtype & 0xf;
  }
  update() {
    const g = this.game;
    this.t = (g.frameCount * 1.4) % 256;
    const s = Math.sin((this.t / 256) * Math.PI * 2);
    const ox = this.x, oy = this.y;
    if (this.kind === 1) this.x = this.bx + Math.round(s * 0x40);
    else if (this.kind === 2) this.y = this.by + Math.round(s * 0x40);
    else if (this.kind >= 3) this.y = this.by + Math.round(s * 0x20);
    if (this.standing) g.player.x_pos += this.x - ox;
    void oy;
    solidObject(g, this, 0x20, 8, 8, true);
  }
}

// Obj_CollapsingPlatform: top-solid ledge that falls after being stood on.
class CollapsingPlatform extends Obj {
  constructor(game, d) {
    super(game, d);
    this.timer = -1;
    this.vy = 0;
  }
  update() {
    const g = this.game;
    if (this.timer < 0) {
      if (solidObject(g, this, 0x30, 8, 8, true) === 'top') this.timer = 7;
      return;
    }
    if (this.timer > 0) { this.timer--; solidObject(g, this, 0x30, 8, 8, true); return; }
    // falling: release player
    if (this.standing) { this.standing = false; g.standingOn = null; g.player.status &= ~STATUS_ON_OBJ; g.player.status |= STATUS_IN_AIR; }
    this.vy += 0.22; this.y += this.vy;
    if (this.y > g.level.heightPx + 256) this.alive = false;
  }
  draw() {}
}

// Obj_StarPost: checkpoint.
class StarPost extends Obj {
  constructor(game, d) {
    super(game, d);
    this.map = game.maps(MAP.StarPost);
    this.art = 0x5ec;
    this.active = false;
    this.spin = 0;
  }
  update() {
    const g = this.game, p = g.player;
    if (!this.active && overlap(p, this.x, this.y, 8, 0x28)) {
      this.active = true;
      this.spin = 32;
      g.checkpoint = { x: this.x, y: this.y, time: g.time };
      g.sfx('starpost');
    }
    if (this.spin > 0) this.spin--;
    this.frame = 0;
  }
  draw(vdp, cx, cy) {
    if (!this.map) return;
    // Map_StarPost: 0 = idle (red lamp), 1 = pole only, 3 = gold lamp, 4 = activated
    const sx = this.x - cx, sy = this.y - cy;
    if (!this.spin) { vdp.addSprite(this.map[this.active ? 4 : 0], sx, sy, this.art, false, false, 0x280); return; }
    vdp.addSprite(this.map[1], sx, sy, this.art, false, false, 0x280);
    const a = (this.spin / 32) * Math.PI * 4;
    vdp.addSprite(this.map[3], sx + Math.round(Math.sin(a) * 8), sy - 24 - Math.round(Math.cos(a) * 8), this.art, false, false, 0x280);
  }
}

// Obj_AIZForegroundPlant ($2B72E): foreground foliage. Subtype high nybble picks a
// parallax routine (loc_2B7AE..): pos = home + ((home - screen centre - camera) >> shift).
class Plant extends Obj {
  constructor(game, d) {
    super(game, d);
    this.map = game.maps(MAP.Plant);
    this.art = 0xc333; // make_art_tile(ArtTile_AIZMisc1,2,1)
    this.frame = this.subtype & 1;
    this.shift = [0, 4, 3, 2, 1, 1, 1][(this.subtype >> 4) & 7] ?? 0;
    this.order = 0;
  }
  draw(vdp, cx, cy) {
    let x = this.x, y = this.y;
    if (this.shift) {
      x += (this.x - 160 - cx) >> this.shift;
      y += (this.y - 112 - cy) >> this.shift;
    }
    const pieces = this.map && this.map[this.frame];
    if (pieces) vdp.addSprite(pieces, x - cx, y - cy, this.art, this.xflip, this.yflip, 0);
  }
}

// --- Badniks -----------------------------------------------------------------

class Badnik extends Obj {
  constructor(game, d) {
    super(game, d);
    this.order = 0x280;
  }
  hitbox() { return [12, 12]; }
  update() {
    const g = this.game, p = g.player;
    this.think();
    const [hw, hh] = this.hitbox();
    if (!p.dead && overlap(p, this.x, this.y, hw, hh)) {
      if (isAttacking(p, g)) {
        this.alive = false;
        g.destroyBadnik(this);
      } else if (!p.invulnerable_time) {
        g.hurtPlayer(this.x, false);
      }
    }
  }
  think() {}
}

// Obj_Rhinobot: patrols, accelerates towards Sonic and skids when turning.
class Rhinobot extends Badnik {
  constructor(game, d) {
    super(game, d);
    this.map = game.maps(MAP.Rhinobot);
    this.slot = game.rhinoSlot++ & 1;
    this.art = 0x2500 + this.slot * 0x15;
    this.dir = this.xflip ? 1 : -1;
    this.vx = 0;
    this.lastDplc = -1;
    this.animT = 0;
    this.skid = 0;
    this.fall = 0;
  }
  think() {
    const g = this.game, L = g.level, p = g.player;
    // charge when player is ahead on the same level
    const dx = p.x_pos - this.x;
    const ahead = Math.sign(dx) === this.dir && Math.abs(dx) < 0x60 && Math.abs(p.y_pos - this.y) < 0x20;
    const max = ahead ? 0x400 : 0x300;
    if (this.skid > 0) {
      this.skid--;
      this.vx -= Math.sign(this.vx) * 0x20;
      if (this.skid === 0) { this.dir = -this.dir; this.vx = 0; }
    } else {
      this.vx += this.dir * 0x10;
      if (Math.abs(this.vx) > max) this.vx = Math.sign(this.vx) * max;
      // turn at walls / ledges
      const fx = this.x + this.dir * 12;
      const wall = L.solidAt(fx, this.y, 0, false) || L.solidAt(fx, this.y - 8, 0, false);
      const ledge = !L.solidAt(fx, this.y + 20, 0) && !L.solidAt(fx, this.y + 28, 0);
      if (wall || ledge || Math.abs(this.x - this.homeX()) > 0xa0 && Math.sign(this.x - this.homeX()) === this.dir) {
        this.skid = 16;
      }
    }
    this.x += this.vx / 256;
    // stick to floor
    for (let i = 0; i < 16 && !L.solidAt(this.x, this.y + 16, 0); i++) this.y++;
    for (let i = 0; i < 16 && L.solidAt(this.x, this.y + 15, 0); i++) this.y--;
    this.xflip = this.dir > 0 ? !(this.skid > 0) : this.skid > 0;
    // frames: 0-3 run cycle, 4-7 dust (children); skid = frame 0
    this.animT = (this.animT + 1) % 16;
    this.frame = this.skid > 0 ? 0 : [0, 1, 2, 3][(this.animT >> 2) & 3];
    if (this.frame !== this.lastDplc) {
      this.lastDplc = this.frame;
      this.game.objectDPLC(0x16732a, 0x16156e, this.frame, this.art);
    }
  }
  homeX() { return this.home ?? (this.home = this.x); }
  hitbox() { return [16, 14]; }
  draw(vdp, cx, cy) {
    // DPLC must match the frame being drawn: reload right before queueing
    this.game.objectDPLC(0x16732a, 0x16156e, this.frame, this.art);
    vdp.addSprite(this.map[this.frame], this.x - cx, this.y - cy, this.art, this.xflip, false, this.order);
  }
}

// Obj_Bloominator: stationary flower cannon; fires spike balls upwards.
class Bloominator extends Badnik {
  constructor(game, d) {
    super(game, d);
    this.map = game.maps(MAP.Bloominator);
    this.art = 0x252a;
    this.t = 0;
  }
  think() {
    this.t = (this.t + 1) % 160;
    this.frame = this.t > 120 ? ((this.t >> 3) & 1) + 1 : 0;
    if (this.t === 140) {
      for (const dir of [-1, 1]) this.game.spawnProjectile(this.x + dir * 4, this.y - 20, dir * 0x100, -0x500, this.map, 4, this.art);
    }
  }
  hitbox() { return [12, 20]; }
}

// Obj_MonkeyDude: climbs on palm trees and throws coconuts.
class MonkeyDude extends Badnik {
  constructor(game, d) {
    super(game, d);
    this.map = game.maps(MAP.MonkeyDude);
    this.art = 0x2548;
    this.t = 0;
    this.by = this.y;
  }
  think() {
    const p = this.game.player;
    this.t++;
    this.y = this.by + Math.round(Math.sin(this.t / 30) * 16);
    this.xflip = p.x_pos > this.x;
    this.frame = (this.t >> 4) % 3;
    if (this.t % 150 === 0 && Math.abs(p.x_pos - this.x) < 0xa0) {
      const dir = this.xflip ? 1 : -1;
      this.game.spawnProjectile(this.x + dir * 12, this.y - 8, dir * 0x200, -0x300, this.map, 6, this.art);
    }
  }
  hitbox() { return [12, 14]; }
}

const TYPES = {
  1: Monitor, 2: PathSwap, 4: CollapsingPlatform, 5: Rock, 7: Spring, 8: Spikes,
  40: InvisibleBlock, 52: StarPost, 53: Plant, 81: FloatingPlatform,
  129: Bloominator, 130: Rhinobot, 131: MonkeyDude,
};

export function createObject(game, d) {
  const T = TYPES[d.id];
  return T ? new T(game, d) : null;
}
