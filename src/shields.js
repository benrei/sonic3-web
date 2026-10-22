// Shield objects: Obj_InstaShield ($180xx), Obj_FireShield, Obj_LightningShield,
// Obj_BubbleShield. Art is streamed into VRAM at ArtTile_Shield with
// PLCLoad_Shields (same DPLC format as Sonic), animated with Animate_Sprite.
import { ART_TILE } from './rom.js';
import { FireShieldDissipate } from './water.js';

const ART_TILE_SHIELD = 0x79c;
const S2_INVINCIBLE = 0x02, S2_SHIELD = 0x01, S2_FIRE = 0x10, S2_LTNG = 0x20, S2_BUBL = 0x40;

// Addresses found by matching each object's init code in the ROM.
const DEFS = {
  insta: { map: 0x18c56, dplc: 0x18cda, art: 0x14aba2, ani: 0x18578 },
  fire: { map: 0x1864c, dplc: 0x1886c, art: 0x14b222, ani: 0x18590 },
  lightning: { map: 0x1894e, dplc: 0x18a80, art: 0x14d3c2, ani: 0x185b8 },
  bubble: { map: 0x18b08, dplc: 0x18bfc, art: 0x14e4a2, ani: 0x18600 },
};

export class ShieldObject {
  constructor(game) {
    this.game = game;
    this.rom = game.rom;
    this.kind = null;
    this.setKind('insta');
  }

  setKind(kind) {
    if (this.kind === kind) return;
    this.kind = kind;
    const d = DEFS[kind];
    this.def = d;
    this.map = this.game.maps(d.map);
    this.anim = kind === 'insta' ? 0 : 0;
    this.prevAnim = -1;
    this.animFrame = 0;
    this.animTimer = 0;
    this.frame = 0;
    this.prevFrame = -1;
    this.order = 0x80;
  }

  currentKind(p) {
    const s2 = p.status_secondary | 0;
    if (s2 & S2_SHIELD) {
      if (s2 & S2_FIRE) return 'fire';
      if (s2 & S2_LTNG) return 'lightning';
      if (s2 & S2_BUBL) return 'bubble';
    }
    return 'insta';
  }

  update() {
    const p = this.game.player;
    this.setKind(this.currentKind(p));
    this.visible = false;
    if ((p.status_secondary & S2_INVINCIBLE) || this.game.invincible > 0) return;
    if (p.anim === 0x1c || p.dead) return; // blank animation
    // Obj_FireShield_DestroyUnderwater / Obj_LightningShield_DestroyUnderwater
    if ((this.kind === 'fire' || this.kind === 'lightning') && (p.status & 0x40)) {
      p.status_secondary &= 0x8e;
      if (this.kind === 'fire') this.game.core.spawn(new FireShieldDissipate(this.game, p.x_pos, p.y_pos));
      else this.game.water?.flashWhite(); // white flash of the underwater palette
      this.setKind('insta');
      return;
    }
    // the player sets (Shield+anim) when an ability is used
    if (p.shield_anim) { this.anim = p.shield_anim; p.shield_anim = 0; }
    if (this.kind === 'insta') {
      // Only Sonic has the Insta-Shield (SpawnLevelMainSprites); Tails' double_jump_flag is flight
      if (p.character_id) { this.visible = false; return; }
      // Obj_InstaShield_Main: idle anim 0 shows nothing (frame 6 = empty)
      this.animate();
      if (this.frame === 7 && p.double_jump_flag === 1) p.double_jump_flag = 2; // attack over
      this.visible = this.anim === 1;
    } else {
      this.animate();
      this.visible = true;
      // Obj_FireShield_Main: frames >= $F are drawn behind the player
      this.order = this.kind === 'fire' && this.frame >= 0xf ? 0x200 : 0x80;
    }
    if (this.anim !== 1 || this.kind !== 'fire') this.flipX = !!(p.status & 1);
    this.loadArt();
  }

  // Animate_Sprite ($19260) incl. the $FF/$FE/$FD/$FC commands.
  animate() {
    const rom = this.rom, base = this.def.ani;
    if (this.anim !== this.prevAnim) { this.prevAnim = this.anim; this.animFrame = 0; this.animTimer = 0; }
    if (--this.animTimer >= 0) return;
    const a = base + rom.u16(base + this.anim * 2);
    this.animTimer = rom.u8at(a);
    let f = rom.u8at(a + 1 + this.animFrame);
    if (f >= 0x80) {
      if (f === 0xff) { this.animFrame = 0; f = rom.u8at(a + 1); }
      else if (f === 0xfe) { const back = rom.u8at(a + 2 + this.animFrame); this.animFrame -= back; f = rom.u8at(a + 1 + this.animFrame); }
      else if (f === 0xfd) { this.anim = rom.u8at(a + 2 + this.animFrame); return; }
      else { this.anim = 0; return; } // $FC: Obj_LightningShield spawns sparks, then returns to idle
    }
    this.frame = f;
    this.animFrame++;
  }

  // PLCLoad_Shields
  loadArt() {
    if (this.frame === this.prevFrame) return;
    this.prevFrame = this.frame;
    const rom = this.rom, d = this.def;
    // frames past the end of the DPLC table (e.g. the lightning flash, $17) use art
    // that is already in VRAM - don't stream anything for them
    if (this.frame * 2 >= rom.u16(d.dplc)) return;
    const o = d.dplc + rom.u16(d.dplc + this.frame * 2);
    const n = rom.u16(o);
    let v = ART_TILE_SHIELD * 32;
    const end = ART_TILE.PlayerLifeIcon * 32; // never spill into the life icon
    for (let i = 0; i < n && i < 32; i++) {
      const w = rom.u16(o + 2 + i * 2);
      const count = Math.min((w >> 12) + 1, (end - v) >> 5);
      if (count <= 0) break;
      const src = d.art + (w & 0xfff) * 32;
      this.game.vdp.writeVram(v, rom.u8.subarray(src, src + count * 32));
      v += count * 32;
    }
  }

  draw(vdp, cx, cy) {
    if (!this.visible) return;
    const p = this.game.player;
    const pieces = this.map[this.frame];
    if (!pieces) return;
    const art = ART_TILE_SHIELD | (p.highPriority ? 0x8000 : 0);
    vdp.addSprite(pieces, p.x_pos - cx, p.y_pos - cy, art, !!this.flipX, false, this.order);
  }
}

export { ART_TILE };
