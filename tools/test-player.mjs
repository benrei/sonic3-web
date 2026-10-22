// Headless physics test: node tools/test-player.mjs [rom]
// Loads Angel Island Act 1, spawns Sonic and runs scripted input sequences.
import fs from 'fs';
import { Rom, ZONES } from '../src/rom.js';
import { Level } from '../src/level.js';
import { Player } from '../src/player.js';

const romPath = process.argv[2] || '/home/agent/sonic3_extract/Sonic_The_Hedgehog_3.bin';
// Plain Uint8Array copy: with a Node Buffer, Level's `rom.u8.slice(..).buffer` would
// be the whole ROM (Buffer.slice returns a view), corrupting heights/heightsRot.
const rom = new Rom(new Uint8Array(fs.readFileSync(romPath)));
const level = new Level(rom, ZONES[0]);
console.log(`${level.name} ${level.act}: start`, level.start, 'bounds', level.bounds, 'size', level.widthPx, 'x', level.heightPx);

const KEYS = ['up', 'down', 'left', 'right', 'a', 'b', 'c', 'start'];
function mkInput(held, prevHeld) {
  const h = {}, p = {};
  for (const k of KEYS) {
    h[k] = held.includes(k);
    p[k] = h[k] && !prevHeld.includes(k);
  }
  return { held: h, pressed: p };
}

let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`);
  if (!cond) failures++;
}

const hex = (v) => (v < 0 ? '-$' + (-v).toString(16) : '$' + v.toString(16)).toUpperCase().replace('X', 'x');
const fmt = (p) =>
  `x=${p.x_pos} y=${p.y_pos} xv=${hex(p.x_vel)} yv=${hex(p.y_vel)} gv=${hex(p.ground_vel)} ang=${hex(p.angle)} st=${hex(p.status)} anim=${hex(p.anim)} frame=${hex(p.mapping_frame)}${p.flipX ? ' fx' : ''}`;

// Runs `frames` frames holding `held`; calls onFrame(player, frameIndex) each frame.
function run(p, frames, held = [], onFrame, state = { prev: [] }) {
  for (let i = 0; i < frames; i++) {
    p.update(mkInput(held, state.prev));
    state.prev = held;
    onFrame?.(p, i);
  }
}

function fresh() {
  const p = new Player(rom, level);
  return p;
}

// Settle: idle until standing on the ground
function settle(p) {
  run(p, 120, []);
}

// ---------------------------------------------------------------- 1. idle
{
  console.log('\n[1] idle 120 frames');
  const p = fresh();
  console.log('  spawn:', fmt(p));
  const ys = [];
  run(p, 120, [], (pl, i) => {
    if (i % 20 === 0) console.log(`  f${i}:`, fmt(pl));
    if (i >= 60) ys.push(pl.y_pos);
  });
  console.log('  end:', fmt(p));
  check(!p.inAir, 'on the ground after 120 frames');
  check(Math.min(...ys) === Math.max(...ys), `y stable over the last 60 frames (y=${p.y_pos})`);
  check(p.anim === 5, 'standing/idle animation (5)');
}

// ---------------------------------------------------------------- 2. hold right
{
  console.log('\n[2] hold right 400 frames');
  const p = fresh();
  settle(p);
  const x0 = p.x_pos;
  let maxGv = 0, angles = new Set(), minY = 1e9, maxY = -1e9, airFrames = 0, frames = new Set();
  run(p, 400, ['right'], (pl, i) => {
    maxGv = Math.max(maxGv, pl.ground_vel);
    angles.add(pl.angle);
    minY = Math.min(minY, pl.y_pos);
    maxY = Math.max(maxY, pl.y_pos);
    if (pl.inAir) airFrames++;
    frames.add(pl.mapping_frame);
    if (i % 25 === 0) console.log(`  f${i}:`, fmt(pl));
  });
  console.log('  end:', fmt(p));
  console.log(`  max gv ${hex(maxGv)}, distinct angles ${[...angles].map(hex).join(' ')}, y range ${minY}..${maxY}, air frames ${airFrames}`);
  console.log(`  mapping frames seen: ${[...frames].map(hex).join(' ')}`);
  check(p.x_pos > x0 + 1000, `x increased (${x0} -> ${p.x_pos})`);
  check(maxGv >= 0x600, 'ground_vel reached $600');
  check(angles.size > 1, 'angle changed (followed slopes)');
  check(maxY < level.heightPx && minY > 0, 'y stays within level');
  check(p.routine === 2 && !p.dead, 'still alive');
}

// ---------------------------------------------------------------- 3. jump
{
  console.log('\n[3] jump');
  const p = fresh();
  settle(p);
  const y0 = p.y_pos;
  let minY = y0, landedAt = -1, leftGround = false;
  const st = { prev: [] };
  run(p, 1, ['a'], null, st);
  run(p, 100, ['a'], (pl, i) => {
    if (pl.inAir) leftGround = true;
    minY = Math.min(minY, pl.y_pos);
    if (leftGround && !pl.inAir && landedAt < 0) landedAt = i;
    if (i % 8 === 0) console.log(`  f${i}:`, fmt(pl));
  }, st);
  console.log('  end:', fmt(p));
  check(leftGround, 'left the ground');
  check(y0 - minY > 50, `rose ${y0 - minY}px (expected ~100 for a full jump)`);
  check(landedAt > 0 && p.y_pos === y0 && !p.inAir, `landed again (frame ${landedAt}) at y=${p.y_pos}`);
  check(!p.rolling, 'roll status cleared on landing');

  console.log('  short hop (release jump after 4 frames)');
  const q = fresh();
  settle(q);
  let minY2 = q.y_pos;
  const st2 = { prev: [] };
  run(q, 4, ['a'], null, st2);
  run(q, 80, [], (pl) => { minY2 = Math.min(minY2, pl.y_pos); }, st2);
  check(q.y_pos - minY2 < y0 - minY, `short hop is lower (${q.y_pos - minY2}px)`);
}

// ---------------------------------------------------------------- 4. spindash
{
  console.log('\n[4] spindash');
  const p = fresh();
  settle(p);
  const st = { prev: [] };
  run(p, 10, ['down'], null, st);
  console.log('  ducking:', fmt(p));
  check(p.anim === 8, 'duck animation (8)');
  for (let i = 0; i < 4; i++) {
    run(p, 1, ['down', 'a'], null, st);
    run(p, 2, ['down'], null, st);
  }
  console.log('  charging:', fmt(p), 'counter', hex(p.spin_dash_counter));
  check(p.spin_dash_flag === 1 && p.anim === 9, 'spindash charging (anim 9)');
  const x0 = p.x_pos;
  run(p, 1, [], null, st);
  console.log('  released:', fmt(p));
  check(p.rolling && p.ground_vel >= 0x800, `rolling with ground_vel ${hex(p.ground_vel)}`);
  run(p, 40, [], (pl, i) => { if (i % 10 === 0) console.log(`  f${i}:`, fmt(pl)); }, st);
  check(p.x_pos - x0 > 200, `travelled ${p.x_pos - x0}px in 40 frames`);
}

// ---------------------------------------------------------------- 5. run left into the level bound
{
  console.log('\n[5] hold left 300 frames (left level bound)');
  const p = fresh();
  settle(p);
  run(p, 300, ['left'], (pl, i) => { if (i % 50 === 0) console.log(`  f${i}:`, fmt(pl)); });
  console.log('  end:', fmt(p));
  check(p.x_pos === level.bounds.minX + 0x10, `stopped at left bound minX+$10 = ${level.bounds.minX + 0x10} (x=${p.x_pos})`);
  check(p.flipX, 'facing left (flipX)');
}

// ---------------------------------------------------------------- 6. roll by pressing down while running
{
  console.log('\n[6] run then roll');
  const p = fresh();
  settle(p);
  const st = { prev: [] };
  run(p, 60, ['right'], null, st);
  run(p, 1, ['down'], null, st);
  check(p.rolling && p.anim === 2, 'rolling (anim 2) after pressing down at speed');
  run(p, 200, [], null, st);
  console.log('  end:', fmt(p));
  check(!p.rolling || p.ground_vel !== 0, 'roll ends when stopped (or still moving)');
}

// ---------------------------------------------------------------- 7. hurt
{
  console.log('\n[7] hurt + invulnerability');
  const p = fresh();
  settle(p);
  let lost = 0;
  p.onRingLoss = () => { lost++; return true; };
  const hurt = p.hurt(p.x_pos + 10);
  console.log('  hit:', fmt(p));
  check(hurt && p.x_vel === -0x200 && p.y_vel === -0x400 && p.anim === 0x1a && lost === 1, 'knocked back away from the hazard');
  let landed = -1, vis = 0;
  run(p, 150, [], (pl, i) => {
    if (landed < 0 && pl.routine === 2) landed = i;
    if (!pl.visible) vis++;
  });
  console.log('  after:', fmt(p), 'invuln', p.invulnerable_time);
  check(landed > 0, `back in control after landing (frame ${landed})`);
  check(vis > 0, `flashing while invulnerable (${vis} invisible frames)`);
  check(!p.hurt(p.x_pos) || p.invulnerable_time === 0, 'no damage while invulnerable');
}

// ---------------------------------------------------------------- 8. death
{
  console.log('\n[8] hurt with no rings -> death');
  const p = fresh();
  settle(p);
  p.onRingLoss = () => false;
  p.hurt(p.x_pos - 10);
  check(p.routine === 6 && p.anim === 0x18, 'dying');
  let n = 0;
  while (!p.dead && n < 300) { run(p, 1, []); n++; }
  check(p.dead, `dead flag set after ${n} frames (y=${p.y_pos})`);
}

// ---------------------------------------------------------------- 9. long run with jumps
{
  console.log('\n[9] hold right 3000 frames, jumping every 90 frames');
  const p = fresh();
  // The static LevelSizes max Y ($390) only covers the start; in the game the AIZ1
  // level events lower Camera_max_Y_pos further right. Stand in for them here.
  p.bounds.maxY = level.heightPx - 224;
  settle(p);
  const st = { prev: [] };
  let bad = 0, maxX = 0, deaths = 0, stuck = 0, lastX = p.x_pos;
  for (let i = 0; i < 3000; i++) {
    const held = i % 90 < 30 ? ['right', 'a'] : ['right'];
    run(p, 1, held, null, st);
    if (!Number.isFinite(p.x_pos + p.y_pos + p.x_vel + p.y_vel + p.ground_vel)) bad++;
    if (p.y_pos < 0 || p.y_pos >= level.heightPx) bad++;
    maxX = Math.max(maxX, p.x_pos);
    if (i % 300 === 0 || (process.env.TRACE && i > +process.env.TRACE && i < +process.env.TRACE + 80)) console.log(`  f${i}:`, fmt(p));
    if (p.dead) { deaths++; break; }
  }
  console.log('  end:', fmt(p), 'routine', p.routine);
  check(bad === 0, 'no invalid / out-of-level positions');
  check(deaths === 0, `did not die (max x ${maxX})`);
}

// ---------------------------------------------------------------- 10. misc
{
  console.log('\n[10] insta-shield, look up, spring');
  const p = fresh();
  settle(p);
  const st = { prev: [] };
  run(p, 12, ['a'], null, st); // full jump, still rising
  run(p, 1, [], null, st);
  run(p, 1, ['a'], null, st); // second press in the air (y_vel >= -$400)
  check(p.double_jump_flag === 1 && p.instaShieldActive, 'insta-shield attack started on second press');
  run(p, 20, ['a'], null, st);
  check(p.double_jump_flag === 2, `insta-shield attack over (double_jump_flag = ${p.double_jump_flag}, inAir ${p.inAir})`);
  run(p, 80, [], null, st);
  check(!p.inAir && p.double_jump_flag === 0, 'flag reset on landing');

  run(p, 200, ['up'], null, st);
  check(p.anim === 7 && p.cameraLookOffset < 0, `look up anim 7, camera offset ${p.cameraLookOffset}`);
  run(p, 100, [], null, st);
  check(p.cameraLookOffset === 0, 'camera offset back to 0');

  p.springLaunch(0, -0xa00);
  run(p, 1, [], null, st);
  check(p.inAir && p.anim === 0x10 && p.y_vel < -0x900, `spring: in air, anim $10, yv=${hex(p.y_vel)}`);
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
