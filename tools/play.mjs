// Headless run: node tools/play.mjs <rom> <zone> "<script>" <out-prefix> <snapshot frames,comma>
// script: comma separated "keys:frames", keys joined by + (e.g. "none:60,right:200,right+c:1,right:60")
// CHAR=sonic|sonic-tails|tails picks the character mode; keys prefixed with 2 (2right, 2c...)
// go to the second controller (Ctrl_2).
import fs from 'fs';
import { Rom } from '../src/rom.js';
import { Game } from '../src/game.js';
import { encodePNG } from './png.mjs';
const [romPath, zone = '0', script = 'none:120', out = '/tmp/play', snaps = ''] = process.argv.slice(2);
const rom = new Rom(fs.readFileSync(romPath));
const game = new Game(rom, +zone, null, { character: process.env.CHAR || 'sonic' });
const steps = [];
for (const part of script.split(',')) {
  const [keys, n] = part.split(':');
  for (let i = 0; i < +n; i++) steps.push(keys === 'none' ? [] : keys.split('+'));
}
const snapSet = new Set(snaps.split(',').filter(Boolean).map(Number));
let prev = {}, prev2 = {};
const t0 = Date.now();
let renderMs = 0;
steps.forEach((keys, f) => {
  const held = {}, held2 = {};
  for (const k of keys) { if (k[0] === '2') held2[k.slice(1)] = true; else held[k] = true; }
  const pressed = {}, pressed2 = {};
  for (const k in held) pressed[k] = !prev[k];
  for (const k in held2) pressed2[k] = !prev2[k];
  prev = held;
  prev2 = held2;
  game.update({ held, pressed }, { held: held2, pressed: pressed2 });
  const p = game.player;
  if (f % 30 === 0 || snapSet.has(f)) console.log(f, 'x', p.x_pos, 'y', p.y_pos, 'gv', p.ground_vel, 'xv', p.x_vel, 'yv', p.y_vel, 'ang', p.angle, 'st', p.status.toString(16), 'anim', p.anim, 'fr', p.mapping_frame, 'rings', game.rings, 'cam', game.camX|0, game.camY|0);
  const t = game.sidekick;
  if (t && (f % 30 === 0 || snapSet.has(f))) console.log('   P2', 'x', t.x_pos, 'y', t.y_pos, 'gv', t.ground_vel, 'st', t.status.toString(16), 'anim', t.anim, 'fr', t.mapping_frame, 'rt', t.routine, 'cpu', t.cpuRoutine, 'oc', t.object_control.toString(16), 'dj', t.double_jump_flag, t.double_jump_property);
  if (snapSet.has(f)) {
    const r0 = Date.now();
    game.render();
    renderMs += Date.now() - r0;
    fs.writeFileSync(`${out}_${f}.png`, encodePNG(320, 224, new Uint8Array(game.vdp.frame.buffer)));
  }
});
console.log('total', Date.now() - t0, 'ms for', steps.length, 'frames; render', renderMs, 'ms for', snapSet.size);
