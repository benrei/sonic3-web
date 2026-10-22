// Headless Knuckles test: node tools/test-knuckles.mjs [s3k rom] [png-dir]
// Runs the whole game (Game + objects) as Knuckles in AIZ1/AIZ2 and checks his moves
// against the values of the S3&K code (knuckles.js); writes a few PNG snapshots.
import fs from 'fs';
import { Rom } from '../src/rom.js';
import { Game } from '../src/game.js';
import { encodePNG } from './png.mjs';
import { R } from '../src/ram.js';

const romPath = process.argv[2] || '.local/s3k.bin';
const pngDir = process.argv[3] || '/tmp';
const rom = new Rom(new Uint8Array(fs.readFileSync(romPath)));
if (!rom.sk) throw new Error('needs the Sonic 3 & Knuckles ROM');

let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`);
  if (!cond) failures++;
}
// each test runs in its own function scope so the previous Game (~400 MB) can be freed
function section(fn) { fn(); }
const hex = (v) => (v < 0 ? '-$' : '$') + Math.abs(v).toString(16).toUpperCase();

function newGame(zone, character = 'knuckles') {
  const g = new Game(rom, zone, null, { character });
  g.titleCard = 0;
  return g;
}
// keys: 'right+c' etc. Returns per-frame log entries.
function run(g, keys, frames, onFrame) {
  const held = {};
  for (const k of keys ? keys.split('+') : []) held[k] = true;
  for (let i = 0; i < frames; i++) {
    const pressed = {};
    for (const k in held) pressed[k] = !g._prevHeld?.[k];
    g._prevHeld = held;
    g.update({ held, pressed });
    onFrame?.(g.player, i);
  }
}
// Put the player somewhere (in the air, as if jumping) and let the camera / objects catch up.
function teleport(g, x, y, frames = 200, minX = null) {
  const p = g.player;
  for (let i = 0; i < frames; i++) {
    // move the camera along (and below the level's bottom boundary checks)
    const step = (sym, t) => { const c = g.ram.w(sym); g.ram.setW(sym, c + Math.max(-16, Math.min(16, t - c))); };
    step(R.Camera_X_pos, x - 0xa0);
    step(R.Camera_Y_pos, y - 0x60);
    if (minX !== null) g.ram.setW(R.Camera_min_X_pos, minX);
    if (g.ram.w(R.Camera_max_Y_pos) < y) { // don't hit the death plane
      g.ram.setW(R.Camera_max_Y_pos, y);
      g.ram.setW(R.Camera_target_max_Y_pos, y);
      p.bounds.maxY = y;
    }
    p.x_pos = x; p.y_pos = y; p.x_vel = 0; p.y_vel = -0x100; p.ground_vel = 0;
    p.status = (p.status & ~0x28) | 6; p.jumping = 1; p.anim = 2; p.double_jump_flag = 0;
    run(g, '', 1);
  }
}
function snap(g, name) {
  g.render();
  const f = `${pngDir}/knux_${name}.png`;
  fs.writeFileSync(f, encodePNG(320, 224, new Uint8Array(g.vdp.frame.buffer)));
  return f;
}

// ---------------------------------------------------------------- 1. start, palette, art
section(() => {
  console.log('\n[1] AIZ1 start, palette, art');
  const g = newGame(0);
  const p = g.player;
  check(p.character_id === 2, 'character_id 2');
  check(p.x_pos === 0x13a0 && p.y_pos === 0x41a, `Knux_Start_Locations AIZ1 ${hex(p.x_pos)},${hex(p.y_pos)}`);
  const pal = [...g.level.palette.slice(0, 16)].map((c) => c.toString(16));
  check(pal[2] === '64e' && pal[3] === '20c' && pal[4] === '206', `Pal_Knuckles in line 0: ${pal.slice(1, 5).join(' ')}`);
  check(g.level.palette[0x38] === 0xee4 && g.level.palette[0x3b] === 0xe40, 'AIZ1 Knuckles colours (word_4FAE4) in line 4');
  check(g.level.objects.length === 153, `S3&K object layout (${g.level.objects.length} objects)`);
  run(g, '', 30);
  // red pixels around Knuckles on screen
  g.render();
  const px = new Uint32Array(g.vdp.frame.buffer);
  const sx = p.x_pos - g.camX, sy = p.y_pos - g.camY;
  let red = 0;
  for (let y = sy - 20; y < sy + 20; y++) for (let x = sx - 16; x < sx + 16; x++) {
    const c = px[y * 320 + x], r = c & 0xff, gg = (c >> 8) & 0xff, b = (c >> 16) & 0xff;
    if (r > 150 && gg < 90 && b < 150) red++;
  }
  check(red > 80, `red Knuckles sprite on screen (${red} red pixels)`);
  console.log('  snapshot', snap(g, 'stand'));
});

// ---------------------------------------------------------------- 2. run, jump, glide, slide
section(() => {
  console.log('\n[2] run, jump ($600), glide, turn, land sliding');
  const g = newGame(0);
  const p = g.player;
  run(g, 'right', 60);
  check(p.ground_vel > 0x200 && !(p.status & 2), `running: gv=${hex(p.ground_vel)}`);
  let jumpYv = 0;
  run(g, 'right+c', 1, (pl) => { jumpYv = pl.y_vel; });
  check(jumpYv === -0x600 + 0x38 || jumpYv === -0x600, `Knux_Jump y_vel ${hex(jumpYv)} (-$600, Sonic -$680)`);
  run(g, 'right', 4);
  run(g, 'right+c', 1);
  check(p.double_jump_flag === 1 && p.anim === 0x20 && p.mapping_frame === 0xc0, `gliding: dj=${p.double_jump_flag} anim=${hex(p.anim)} frame=${hex(p.mapping_frame)}`);
  check(p.x_radius === 0xa && p.y_radius === 0xa, 'glide radii $A');
  const gv0 = p.ground_vel;
  let maxYv = -9999;
  run(g, 'c', 20, (pl) => { if (pl.double_jump_flag === 1) maxYv = Math.max(maxYv, pl.y_vel); });
  check(p.ground_vel > gv0, `glide accelerates: ${hex(gv0)} -> ${hex(p.ground_vel)}`);
  check(maxYv <= 0xa0, `glide descent: y_vel settles around $80 (max ${hex(maxYv)})`);
  console.log('  snapshot', snap(g, 'glide'));
  // landing slide (the floor is right below)
  let sawSlide = false, sawGetUp = false;
  run(g, 'c', 60, (pl) => { if (pl.double_jump_flag === 3 && pl.mapping_frame === 0xcc) sawSlide = true; });
  run(g, '', 20, (pl) => { if (pl.anim === 0x22) sawGetUp = true; });
  check(sawSlide, 'Knux_Gliding_HitFloor: slides (double_jump_flag 3, frame $CC)');
  check(sawGetUp && !(p.status & 2) && p.double_jump_flag === 0, 'gets up (anim $22) and stands');
});
section(() => {
  console.log('\n[2b] glide turning');
  const g = newGame(0);
  const p = g.player;
  teleport(g, 0x1600, 0x300, 220);
  run(g, 'c', 1);
  run(g, 'c', 4);
  check(p.double_jump_flag === 1 && p.x_vel > 0, `gliding right x_vel=${hex(p.x_vel)}`);
  const frames = [];
  run(g, 'left+c', 70, (pl) => frames.push(pl.mapping_frame));
  check(p.double_jump_property === 0x80 && p.x_vel < 0, `turned left: property=${hex(p.double_jump_property)} x_vel=${hex(p.x_vel)}`);
  check([0xc1, 0xc2, 0xc3].every((f) => frames.includes(f)), 'turning frames $C1-$C3 (RawAni_Knuckles_GlideTurn)');
  check(p.status & 1, 'facing left after the turn');
  console.log('  snapshot', snap(g, 'glide_left'));
  run(g, '', 1);
  check(p.double_jump_flag === 2 && p.anim === 0x21, `button released: falls (dj=${p.double_jump_flag}, anim ${hex(p.anim)})`);
});

// ---------------------------------------------------------------- 3. climbing
section(() => {
  console.log('\n[3] wall grab, climb up/down, jump off the wall');
  const g = newGame(0);
  const p = g.player;
  teleport(g, 0x1600, 0xc0, 250);
  run(g, 'right+c', 1);
  let grabbed = false;
  run(g, 'right+c', 40, (pl) => { if (pl.double_jump_flag === 4) grabbed = true; });
  check(grabbed && p.double_jump_flag === 4 && p.mapping_frame >= 0xb7 && p.mapping_frame <= 0xbc, `grabbed the wall at ${hex(p.x_pos)},${hex(p.y_pos)}`);
  console.log('  snapshot', snap(g, 'climb'));
  const y0 = p.y_pos;
  run(g, 'up', 40);
  check(p.y_pos === y0 - 40 && p.double_jump_flag === 4, `climbs up 1px/frame: ${hex(y0)} -> ${hex(p.y_pos)}`);
  run(g, 'down', 20);
  check(p.y_pos === y0 - 20, `climbs down: ${hex(p.y_pos)}`);
  run(g, 'c', 1);
  check(p.double_jump_flag === 0 && p.x_vel === -0x400 && p.anim === 2 && (p.status & 1), `jumped off the wall: x_vel=${hex(p.x_vel)} y_vel=${hex(p.y_vel)}`);
});
section(() => {
  console.log('\n[3b] climb over a ledge (Knuckles_ClimbLedge_Frames)');
  const g = newGame(0);
  const p = g.player;
  teleport(g, 0x1b40, 0x2d0, 250);
  run(g, 'right+c', 1);
  run(g, 'right+c', 30);
  check(p.double_jump_flag === 4, `grabbed at ${hex(p.x_pos)},${hex(p.y_pos)}`);
  const seen = new Set();
  let snapped = false;
  run(g, 'up', 80, (pl) => {
    if (pl.double_jump_flag === 5) seen.add(pl.mapping_frame);
    if (pl.mapping_frame === 0xbe && !snapped) { snapped = true; console.log('  snapshot', snap(g, 'ledge')); }
  });
  check(seen.has(0xbd) && seen.has(0xbe) && seen.has(0xbf), `ledge frames ${[...seen].map(hex).join(' ')}`);
  check(p.double_jump_flag === 0 && !(p.status & 2) && p.anim !== 0x20, `standing on top at ${hex(p.x_pos)},${hex(p.y_pos)}`);
});

// ---------------------------------------------------------------- 4. Knuckles-only breakables
section(() => {
  console.log('\n[4] AIZ1 side-breakable rock (subtype 4): Knuckles breaks it by walking into it');
  for (const ch of ['knuckles', 'sonic']) {
    const g = newGame(0, ch);
    const p = g.player;
    teleport(g, 0x1d70, 0x490, 250);
    run(g, '', 30);
    const has = () => g.objects.some((o) => o.constructor.name === 'Rock' && o.x_pos === 0x1d00);
    const before = has();
    run(g, 'left', 60);
    const after = has();
    check(before && (ch === 'knuckles' ? !after : after), `${ch}: rock ${before ? 'present' : 'missing'} -> ${after ? 'still there' : 'broken'} (x=${hex(p.x_pos)})`);
  }
});
section(() => {
  console.log('\n[4b] AIZ2 Knuckles-only rock (subtype $84) and stand-to-break rock (subtype $1F)');
  for (const ch of ['knuckles', 'sonic']) {
    const g = newGame(1, ch);
    const p = g.player;
    // (Knuckles normally arrives here from AIZ1: the direct AIZ2 start keeps the camera right of $1040)
    teleport(g, 0xf70, 0x440, 300, 0xd00);
    run(g, '', 40);
    const rockAt = (x) => g.objects.some((o) => o.constructor.name === 'Rock' && o.x_pos === x);
    const before = rockAt(0xf30);
    if (ch === 'knuckles') console.log('  snapshot', snap(g, 'aiz2_rock_before'));
    run(g, 'left', 40);
    const after = rockAt(0xf30);
    check(before && (ch === 'knuckles' ? !after : after), `${ch}: Knuckles-only rock ($84) at $F30 ${before ? 'present' : 'missing'} -> ${after ? 'still there' : 'broken'}`);
    if (ch === 'knuckles') console.log('  snapshot', snap(g, 'aiz2_rock_after'));
  }
  const g = newGame(1);
  const p = g.player;
  teleport(g, 0xef8, 0x3a0, 300, 0xd00);
  const rockAt = (x) => g.objects.some((o) => o.constructor.name === 'Rock' && o.x_pos === x);
  const before = rockAt(0xef8);
  let bounced = false;
  run(g, '', 30, (pl) => { if (pl.y_vel === -0x300 + 0x38 || (pl.anim === 2 && pl.y_vel < 0)) bounced = true; });
  check(before && !rockAt(0xef8) && bounced, `rock $1F at $EF8 breaks when Knuckles stands on it (${before ? 'present' : 'missing'} -> ${rockAt(0xef8) ? 'still there' : 'broken'})`);
});

// ---------------------------------------------------------------- 5. hurt / no insta-shield
section(() => {
  console.log('\n[5] hurt, death, no insta-shield');
  const g = newGame(0);
  const p = g.player;
  run(g, '', 10);
  run(g, 'c', 1);
  run(g, '', 8);
  run(g, 'c', 1);
  check(p.shield_anim === 0 && !p.instaShieldActive, 'second press in the air is no insta-shield');
  run(g, '', 60);
  g.rings = 5;
  p.hurt(p.x_pos + 10);
  check(p.routine === 4 && p.anim === 0x1a && p.x_vel === -0x200 && p.y_vel === -0x400, `HurtCharacter: routine 4 anim $1A xv=${hex(p.x_vel)}`);
  run(g, '', 120);
  check(p.routine === 2 && p.invulnerable_time > 0, 'back to control, invulnerable');
  p.kill();
  check(p.routine === 6 && p.anim === 0x18 && p.y_vel === -0x700, 'Kill_Character: anim $18, y_vel -$700');
  run(g, '', 10);
  console.log('  snapshot', snap(g, 'death'));
});

// ---------------------------------------------------------------- 6. other acts
section(() => {
  console.log('\n[6] every Sonic 3 act loads and runs as Knuckles');
  for (let z = 0; z < 12; z++) {
    let ok = true, err = '';
    try {
      const g = newGame(z);
      run(g, 'right', 120);
      run(g, 'right+c', 1);
      run(g, 'right', 10);
      run(g, 'right+c', 1);
      run(g, 'right+c', 30);
      if (z === 2 || z === 9) console.log('  snapshot', snap(g, `act${z}`));
    } catch (e) { ok = false; err = e.message; }
    check(ok, `act ${z} ${err}`);
  }
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
