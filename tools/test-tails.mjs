// Headless Tails tests: node tools/test-tails.mjs [rom] [outdir]
// 1. "Tails alone": run, jump, fly (flight timer, tired), land; swim in Hydrocity
// 2. "Sonic & Tails": the CPU sidekick follows Sonic through AIZ1 (autopilot Sonic), collects
//    rings / hits badniks, uses springs, flies back in when left behind; Ctrl_2 takeover
// PNG snapshots go to outdir (default /tmp/tails).
import fs from 'fs';
import { Rom } from '../src/rom.js';
import { Game } from '../src/game.js';
import { encodePNG } from './png.mjs';

const romPath = process.argv[2] || '.local/sonic3.bin';
const out = process.argv[3] || '/tmp/tails';
fs.mkdirSync(out, { recursive: true });
const rom = new Rom(new Uint8Array(fs.readFileSync(romPath)));

let failures = 0;
function check(cond, msg) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`);
  if (!cond) failures++;
}
const hex = (v) => (v < 0 ? '-$' : '$') + Math.abs(v).toString(16);

function mk(keys, prev) {
  const held = {}, pressed = {};
  for (const k of keys) { held[k] = true; pressed[k] = !prev[k]; }
  return { held, pressed };
}
class Driver {
  constructor(zone, character) {
    this.g = new Game(rom, zone, null, { character });
    this.prev = {};
    this.prev2 = {};
    this.f = 0;
  }
  step(keys = [], keys2 = []) {
    const i1 = mk(keys, this.prev), i2 = mk(keys2, this.prev2);
    this.prev = i1.held;
    this.prev2 = i2.held;
    this.g.update(i1, i2);
    this.f++;
  }
  run(n, keys = [], keys2 = [], cb) { for (let i = 0; i < n; i++) { this.step(keys, keys2); cb?.(this.g, i); } }
  snap(name) {
    this.g.render();
    fs.writeFileSync(`${out}/${name}.png`, encodePNG(320, 224, new Uint8Array(this.g.vdp.frame.buffer)));
  }
}

// ------------------------------------------------------------------ 1. Tails alone
{
  console.log('\n[1] Tails alone, AIZ1: run / jump / fly');
  const d = new Driver(0, 'tails');
  const t = d.g.player;
  check(t.constructor.name === 'Tails' && !t.cpu, 'Player_1 is Tails');
  check(t.y_radius === 0xf && t.x_radius === 9, `Tails_Init radii $F/9 (${t.y_radius}/${t.x_radius})`);
  d.run(45); // title card
  let maxGv = 0;
  const frames = new Set();
  d.run(150, ['right'], [], () => { maxGv = Math.max(maxGv, t.ground_vel); frames.add(t.mapping_frame); });
  check(maxGv === 0x600, `top speed $600 (${hex(maxGv)})`);
  check([...frames].some((f) => f >= 0x21 && f <= 0x24 + 6) || [...frames].some((f) => f >= 0xc3), `run frames used (${[...frames].map(hex).join(' ')})`);
  d.snap('1a-run');
  d.step(['right', 'c']);
  check((t.status & 2) && (t.status & 4) && t.y_radius === 0xe, `jump: in air, rolling, radius $E (st ${hex(t.status)})`);
  d.run(10, ['right']);
  d.step(['right', 'c']); // Tails_Test_For_Flight
  check(t.double_jump_flag === 1 && t.double_jump_property === 0xf0, `flight started (flag ${t.double_jump_flag}, timer ${hex(t.double_jump_property)})`);
  check(t.anim === 0x20 || t.anim === 0x21, `flying animation (${hex(t.anim)})`);
  check(!(t.status & 4) && t.y_radius === 0xf, 'flight clears the roll');
  // flap repeatedly: rises
  const y0 = t.y_pos;
  let flightFrames = 0, tiredAt = -1, minY = t.y_pos;
  for (let i = 0; i < 700 && t.double_jump_flag; i++) {
    d.step(i % 16 === 0 ? ['c'] : []);
    flightFrames++;
    minY = Math.min(minY, t.y_pos);
    if (t.anim === 0x24 && tiredAt < 0) { tiredAt = flightFrames; d.snap('1c-tired'); }
    if (flightFrames === 120) d.snap('1b-flying');
  }
  check(minY < y0 - 40, `flapping gains height (${y0} -> ${minY})`);
  check(tiredAt > 470 && tiredAt < 490, `tired after ~8 s (${tiredAt} frames, double_jump_property / 2 frames)`);
  check(t.double_jump_flag === 0 && !(t.status & 2), `landed, flight over (after ${flightFrames} frames)`);
  // can't fly when tired: pressing jump after the timer ran out doesn't climb (checked above by landing)
  d.run(30);
  d.snap('1d-landed');

  console.log('\n[1b] Tails alone, HCZ1: swim');
  const h = new Driver(2, 'tails');
  const p = h.g.player;
  let under = -1;
  h.run(45);
  for (let i = 0; i < 900 && under < 0; i++) {
    h.step(i % 60 < 50 ? ['right'] : ['right', 'c']);
    if (p.status & 0x40) under = h.f;
  }
  check(under > 0, `went underwater at frame ${under} (y ${p.y_pos}, water ${h.g.water.level})`);
  check(p.max_speed === 0x300, `underwater speeds (${hex(p.max_speed)})`);
  h.step(['c']);
  h.run(6);
  h.step(['c']);
  check(p.double_jump_flag !== 0 && (p.anim === 0x25 || p.anim === 0x26), `swimming animation (${hex(p.anim)}, flag ${p.double_jump_flag})`);
  h.run(20, [], [], (g, i) => { if (i % 10 === 0) h.step(['c']); });
  h.snap('1e-swim');
}

// ------------------------------------------------------------------ 2. Sonic & Tails
// Autopilot for Sonic: hold right, spindash when stuck, jump now and then.
function autopilot(d) {
  const s = d.g.player;
  d.best ??= 0; d.stuck ??= 0; d.seq ??= [];
  if (d.seq.length) return d.seq.shift();
  if (s.x_pos > d.best + 2) { d.best = s.x_pos; d.stuck = 0; } else d.stuck++;
  if (d.stuck > 50) {
    d.stuck = 0;
    d.best = s.x_pos;
    const tries = (d.tries = (d.tries ?? 0) + 1);
    if (tries % 2) d.seq = [...Array(40).fill([]), ['right'], [], [], ['down'], ['down'], ['down', 'c'], ['down'], ['down', 'c'], ['down'], ['down', 'c'], ['down'], [], ['right']];
    else if (tries % 3 === 0) d.seq = [...Array(70).fill(['left']), ...Array(60).fill(['right']), ...Array(26).fill(['right', 'c'])];
    else d.seq = [['right', 'c'], ...Array(25).fill(['right', 'c']), ['right']];
    return d.seq.shift();
  }
  return ['right'];
}

{
  console.log('\n[2] Sonic & Tails, AIZ1: CPU sidekick follows Sonic');
  const d = new Driver(0, 'sonic-tails');
  const g = d.g, s = g.player, t = g.sidekick;
  check(t && t.cpu && t.constructor.name === 'Tails', 'Player_2 is the Tails CPU');
  check(t.x_pos === s.x_pos - 0x20 && t.y_pos === s.y_pos + 4, 'placed $20 left of / 4 below Sonic');
  // instrumentation: rings, badniks and springs by Player_2
  const core = g.core;
  let p2Rings = 0, p2Kills = 0, p2Springs = 0, routineLog = [], lastCpu = -1;
  const gr = core.giveRing.bind(core);
  core.giveRing = () => { if (core.player === t) p2Rings++; return gr(); };
  const ten = core.touchEnemyNormal.bind(core);
  core.touchEnemyNormal = (o) => { if (core.player === t) p2Kills++; return ten(o); };
  // springs: wrap the launch routines of the Spring class the first time one is loaded
  const springLog = [];
  const wrapSprings = () => {
    const sp = core.objects.find((o) => o.constructor.name === 'Spring');
    if (!sp || wrapSprings.done) return;
    wrapSprings.done = true;
    const P = Object.getPrototypeOf(sp);
    for (const m of ['launchUp', 'launchHorizontal', 'launchDown', 'sub_21B74', 'launchDownDiag']) {
      const orig = P[m];
      P[m] = function (...a) {
        const pl = a.find((x) => x && typeof x === 'object') ?? g.player;
        if (pl === t) { p2Springs++; springLog.push(`${m}@${this.x_pos},${this.y_pos}`); }
        return orig.apply(this, a);
      };
    }
  };
  let near = 0, follow = 0, maxGap = 0, respawns = 0, sx0 = s.x_pos, warped = false;
  const N = 3600;
  for (let i = 0; i < N; i++) {
    wrapSprings();
    if (i === 1600) {
      // stuck at the left-pointing springs ($1F39): warp Sonic to the star post at $2778 (the
      // real route goes over the top); Tails is left behind and has to fly back in
      console.log(`  warp Sonic ${s.x_pos},${s.y_pos} -> star post area`);
      s.x_pos = 10104 + 0x30;
      s.y_pos = 604;
      s.x_vel = s.ground_vel = s.y_vel = 0;
      s.status |= 2;
      d.best = 0;
      warped = true;
    }
    d.step(autopilot(d));
    if (t.cpuRoutine !== lastCpu) {
      routineLog.push(`${d.f}:${t.cpuRoutine}`);
      if (t.cpuRoutine === 2 && lastCpu === 6) respawns++;
      lastCpu = t.cpuRoutine;
    }
    if (t.cpuRoutine === 6) {
      follow++;
      const gap = Math.hypot(t.x_pos - s.x_pos, t.y_pos - s.y_pos);
      if (gap < 0x80) near++;
      maxGap = Math.max(maxGap, gap);
    }
    if (i % 500 === 250) d.snap(`2-follow-${d.f}`);
  }
  console.log(`  Sonic x ${sx0} -> ${s.x_pos} (rings ${g.rings}), CPU routines ${routineLog.slice(0, 20).join(' ')}${routineLog.length > 20 ? ' ...' : ''}`);
  check(s.x_pos - sx0 > 0x1000, `Sonic made progress through AIZ1 (${s.x_pos - sx0} px)`);
  check(follow > N * 0.6, `Tails in follow mode most of the time (${follow}/${N})`);
  check(near / Math.max(1, follow) > 0.6, `Tails within $80 px of Sonic while following (${(100 * near / Math.max(1, follow)).toFixed(0)}%)`);
  console.log(`  info: rings by Tails ${p2Rings}, badniks destroyed by Tails ${p2Kills}, max gap ${maxGap | 0}, springs ${springLog.join(' ')}`);
  check(p2Springs > 0, `Tails used springs (${p2Springs})`);
  check(respawns >= 1, `Tails left behind after the warp flew back in (${respawns} respawns)`);
  d.snap('2-end');
  check(t.routine !== 8 && !t.dead, 'Tails never dies permanently');

  console.log('\n[2b] left behind: Tails flies back in from above');
  // park Sonic far ahead: Tails goes off screen, after 5 s (sub_14B8A) he respawns flying
  const d2 = new Driver(0, 'sonic-tails');
  const s2 = d2.g.player, t2 = d2.g.sidekick;
  d2.run(400, ['right']);
  check(t2.cpuRoutine === 6, `following after the fly-in at the start (routine ${t2.cpuRoutine})`);
  for (let i = 0; i < 300 && !t2.onScreen; i++) d2.step([]);
  // Sonic gets far ahead (warped to the star post area): Tails can't keep up
  s2.x_pos = 10104 + 0x30;
  s2.y_pos = 604;
  s2.status |= 2;
  let offAt = -1, gone = -1, flying = -1, back = -1, startedAboveSonic = false;
  for (let i = 0; i < 900 && back < 0; i++) {
    d2.step([]);
    if (offAt < 0 && !t2.onScreen) offAt = i;
    if (gone < 0 && t2.cpuRoutine === 2) gone = i;
    if (flying < 0 && t2.cpuRoutine === 4) { flying = i; startedAboveSonic = t2.y_pos < s2.y_pos && Math.abs(t2.x_pos - s2.x_pos) < 0x20; d2.snap('2b-flying-in'); }
    if (flying >= 0 && t2.cpuRoutine === 6) back = i;
  }
  check(gone - offAt + 1 === 300, `off screen for 5 s -> sub_14B58 (${gone - offAt + 1} frames off screen)`);
  check(flying > gone && startedAboveSonic, `Tails_Catch_Up_Flying: appears $C0 above Sonic (frame ${flying})`);
  check(back > flying, `lands next to Sonic and follows again (frame ${back}, dx ${t2.x_pos - s2.x_pos})`);
  d2.run(30);
  d2.snap('2c-back');

  // ring collection by Player_2: put Tails onto a ring that is still there
  {
    const core = d2.g.core, g = d2.g;
    let gr = 0;
    const orig = core.giveRing.bind(core);
    core.giveRing = () => { if (core.player === t2) gr++; return orig(); };
    const r = core.rings.findIndex((rg, k) => k >= core.ringStart && k < core.ringEnd && core.ringStatus[k] === 0);
    const before = g.rings;
    if (r >= 0) { t2.x_pos = core.rings[r].x; t2.y_pos = core.rings[r].y; }
    d2.step([]);
    check(r >= 0 && gr === 1 && g.rings === before + 1, `Tails' TouchResponse collects a ring into Ring_count (${before} -> ${g.rings})`);
    core.giveRing = orig;
  }

  console.log('\n[2c] Tails falls into a pit: no death, respawns');
  t2.y_pos = d2.g.maxY + 0x100; // below the level
  t2.status |= 2;
  let respawned = false;
  for (let i = 0; i < 400 && !respawned; i++) { d2.step([]); if (t2.cpuRoutine === 2 || t2.cpuRoutine === 4) respawned = true; }
  check(respawned && t2.routine === 2 && !d2.g.player.dead, `respawn via sub_14B58 (routine ${t2.routine}, cpu ${t2.cpuRoutine})`);
  check(d2.g.lives === 3, `lives unchanged (${d2.g.lives})`);

  console.log('\n[2d] second controller takes over');
  for (let i = 0; i < 1500 && !(t2.cpuRoutine === 6 && !(t2.status & 2)); i++) d2.step([]);
  const tx = t2.x_pos;
  d2.run(60, [], ['left']); // (Sonic stands still: the CPU alone wouldn't walk away from him)
  check(t2.idleTimer > 0 && t2.x_pos < tx - 30, `Ctrl_2 moves Tails (idle timer ${t2.idleTimer}, x ${tx} -> ${t2.x_pos})`);
  d2.step([], ['c']);
  d2.run(8, [], []);
  d2.step([], ['c']);
  check(t2.double_jump_flag !== 0, `a human-controlled sidekick can fly (flag ${t2.double_jump_flag})`);
  d2.run(30, [], ['c']);
  d2.snap('2d-p2-fly');
  d2.run(700, []);
  check(t2.idleTimer === 0, 'the CPU takes over again after 10 s without input');
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
