// Headless run: node tools/play.mjs <rom> <zone> "<script>" <out-prefix> <snapshot frames,comma>
// script: comma separated "keys:frames", keys joined by + (e.g. "none:60,right:200,right+c:1,right:60")
import fs from 'fs';
import { Rom } from '../src/rom.js';
import { Game } from '../src/game.js';
import { encodePNG } from './png.mjs';
const [romPath, zone = '0', script = 'none:120', out = '/tmp/play', snaps = ''] = process.argv.slice(2);
const rom = new Rom(fs.readFileSync(romPath));
const game = new Game(rom, +zone, null);
const steps = [];
for (const part of script.split(',')) {
  const [keys, n] = part.split(':');
  for (let i = 0; i < +n; i++) steps.push(keys === 'none' ? [] : keys.split('+'));
}
const snapSet = new Set(snaps.split(',').filter(Boolean).map(Number));
let prev = {};
const t0 = Date.now();
let renderMs = 0;
steps.forEach((keys, f) => {
  const held = {};
  for (const k of keys) held[k] = true;
  const pressed = {};
  for (const k in held) pressed[k] = !prev[k];
  prev = held;
  game.update({ held, pressed });
  const p = game.player;
  if (f % 30 === 0 || snapSet.has(f)) console.log(f, 'x', p.x_pos, 'y', p.y_pos, 'gv', p.ground_vel, 'xv', p.x_vel, 'yv', p.y_vel, 'ang', p.angle, 'st', p.status.toString(16), 'anim', p.anim, 'fr', p.mapping_frame, 'rings', game.rings, 'cam', game.camX|0, game.camY|0);
  if (snapSet.has(f)) {
    const r0 = Date.now();
    game.render();
    renderMs += Date.now() - r0;
    fs.writeFileSync(`${out}_${f}.png`, encodePNG(320, 224, new Uint8Array(game.vdp.frame.buffer)));
  }
});
console.log('total', Date.now() - t0, 'ms for', steps.length, 'frames; render', renderMs, 'ms for', snapSet.size);
