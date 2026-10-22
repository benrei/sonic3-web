import { Rom, ZONES } from './rom.js';
import { Game } from './game.js';
import { Audio } from './audio.js';
import { SCREEN_W, SCREEN_H } from './vdp.js';

const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const loader = document.getElementById('loader');
const menu = document.getElementById('menu');
const zoneList = document.getElementById('zone-list');
const errorEl = document.getElementById('error');
const audio = new Audio();
const image = ctx.createImageData(SCREEN_W, SCREEN_H);

let rom = null;
let game = null;
let paused = false;
let menuIndex = 0;
let carry = { lives: 3, score: 0 };

// ---------------- ROM loading (file picker, drag & drop, IndexedDB cache) --------
const DB = 'sonic3-web', STORE = 'rom';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function saveRom(buf) {
  try {
    const db = await idb();
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(buf, 'rom');
  } catch { /* private mode etc. */ }
}
async function loadSavedRom() {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const q = db.transaction(STORE).objectStore(STORE).get('rom');
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    });
  } catch { return null; }
}

async function useRomBuffer(buf, remember) {
  try {
    rom = new Rom(new Uint8Array(buf));
    if (rom.checksum !== 0x3ae0) console.warn('Uventet sjekksum', rom.checksum.toString(16), '- forventer Sonic 3 (W) $3AE0');
    if (remember) saveRom(buf);
    errorEl.textContent = '';
    loader.hidden = true;
    openMenu();
  } catch (e) {
    errorEl.textContent = e.message;
  }
}

document.getElementById('rom-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) useRomBuffer(await f.arrayBuffer(), true);
});
loader.addEventListener('dragover', (e) => { e.preventDefault(); loader.classList.add('drag'); });
loader.addEventListener('dragleave', () => loader.classList.remove('drag'));
loader.addEventListener('drop', async (e) => {
  e.preventDefault();
  loader.classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f) useRomBuffer(await f.arrayBuffer(), true);
});

// ---------------- Zone menu ----------------
function openMenu() {
  game = null;
  menu.hidden = false;
  zoneList.innerHTML = '';
  ZONES.forEach((z, i) => {
    const li = document.createElement('li');
    li.textContent = `${z.name.replace(' Zone', '')} ${z.act}`;
    li.onclick = () => startZone(i);
    zoneList.append(li);
  });
  highlightMenu();
}
function highlightMenu() {
  [...zoneList.children].forEach((li, i) => li.classList.toggle('sel', i === menuIndex));
}
function startZone(i, keepCheckpoint = false) {
  audio.unlock();
  menuIndex = i;
  menu.hidden = true;
  const state = { ...carry };
  if (keepCheckpoint && game?.checkpoint) state.checkpoint = game.checkpoint;
  game = new Game(rom, i, audio, state);
  paused = false;
  // swallow the key that started the zone so it doesn't immediately pause the game
  for (const k of Object.keys(held)) if (held[k]) prevHeld[k] = true;
}

// ---------------- Input ----------------
const KEYMAP = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  KeyZ: 'a', KeyX: 'b', KeyC: 'c', Space: 'c', KeyA: 'a', KeyS: 'b', KeyD: 'c', Enter: 'start',
};
const held = {};
const touchHeld = {};
let prevHeld = {};
addEventListener('keydown', (e) => {
  if (e.code in KEYMAP) { held[KEYMAP[e.code]] = true; e.preventDefault(); }
  audio.unlock();
  if (!menu.hidden) {
    const cols = Math.ceil(ZONES.length / 2);
    if (e.code === 'ArrowDown') menuIndex = (menuIndex + 1) % ZONES.length;
    if (e.code === 'ArrowUp') menuIndex = (menuIndex + ZONES.length - 1) % ZONES.length;
    if (e.code === 'ArrowRight') menuIndex = Math.min(ZONES.length - 1, menuIndex + cols);
    if (e.code === 'ArrowLeft') menuIndex = Math.max(0, menuIndex - cols);
    if (e.code === 'Enter' || e.code === 'Space' || e.code === 'KeyZ') startZone(menuIndex);
    highlightMenu();
    return;
  }
  if (e.code === 'Escape' && rom) openMenu();
  if (e.code === 'KeyM') audio.muted = !audio.muted;
  if (e.code === 'KeyF') document.getElementById('screen-wrap').requestFullscreen?.();
});
addEventListener('keyup', (e) => { if (e.code in KEYMAP) held[KEYMAP[e.code]] = false; });
for (const b of document.querySelectorAll('#touch button')) {
  const k = b.dataset.key;
  const on = (e) => { e.preventDefault(); touchHeld[k] = true; audio.unlock(); };
  const off = (e) => { e.preventDefault(); touchHeld[k] = false; };
  b.addEventListener('pointerdown', on);
  b.addEventListener('pointerup', off);
  b.addEventListener('pointercancel', off);
  b.addEventListener('pointerleave', off);
}

function readInput() {
  const cur = {};
  for (const k of ['up', 'down', 'left', 'right', 'a', 'b', 'c', 'start']) cur[k] = !!(held[k] || touchHeld[k]);
  for (const pad of navigator.getGamepads?.() || []) {
    if (!pad) continue;
    const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0, bt = (i) => pad.buttons[i]?.pressed;
    cur.left ||= ax < -0.4 || bt(14); cur.right ||= ax > 0.4 || bt(15);
    cur.up ||= ay < -0.4 || bt(12); cur.down ||= ay > 0.4 || bt(13);
    cur.a ||= bt(2); cur.b ||= bt(0); cur.c ||= bt(1); cur.start ||= bt(9);
  }
  const pressed = {};
  for (const k in cur) pressed[k] = cur[k] && !prevHeld[k];
  prevHeld = cur;
  return { held: cur, pressed };
}

// ---------------- Main loop (fixed 60 Hz) ----------------
const STEP = 1000 / 59.92;
let last = performance.now(), acc = 0;
function frame(now) {
  acc += Math.min(100, now - last);
  last = now;
  while (acc >= STEP) {
    acc -= STEP;
    tick();
  }
  draw();
  requestAnimationFrame(frame);
}

function tick() {
  if (!game) return;
  const input = readInput();
  if (input.pressed.start) {
    if (game.gameOver) { carry = { lives: 3, score: 0 }; openMenu(); return; }
    paused = !paused;
  }
  if (paused) return;
  game.update(input);
  if (game.restartRequested) {
    carry = { lives: game.lives, score: game.score };
    startZone(game.zoneIndex, true);
  } else if (game.actClear > 300) {
    carry = { lives: game.lives, score: game.score };
    startZone(Math.min(ZONES.length - 1, game.zoneIndex + 1));
  }
}

function draw() {
  if (!game) return;
  game.render();
  new Uint32Array(image.data.buffer).set(game.vdp.frame);
  ctx.putImageData(image, 0, 0);
  const o = game.overlay;
  if (o) drawOverlay(o);
  if (paused) banner('PAUSE', 112);
}

function banner(text, y, color = '#fff', size = 20) {
  ctx.font = `bold italic ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#000';
  ctx.strokeText(text, 160, y);
  ctx.fillStyle = color;
  ctx.fillText(text, 160, y);
}

function drawOverlay(o) {
  if (o.kind === 'title') {
    const slide = Math.max(0, o.t - 120) * 12;
    const out = o.t < 30 ? (30 - o.t) * 14 : 0;
    ctx.fillStyle = '#d02020';
    ctx.fillRect(-slide - out, 0, 64, 224);
    ctx.fillStyle = '#ffd200';
    ctx.fillRect(40, 150 + slide + out, 280, 18);
    const name = game.zone.name.toUpperCase();
    ctx.save();
    ctx.translate(slide + out, 0);
    banner(name, 110, '#fff', 22);
    banner(`ACT ${game.zone.act}`, 140, '#ffd200', 16);
    ctx.restore();
  } else if (o.kind === 'clear') {
    banner('SONIC GOT THROUGH', 80, '#fff', 20);
    banner(`ACT ${game.zone.act}`, 104, '#ffd200', 18);
  } else if (o.kind === 'gameover') {
    banner('GAME OVER', 112, '#fff', 28);
    banner('trykk Enter', 140, '#ffd200', 12);
  }
}

// Boot: try a saved ROM, or ?rom=<url> (handy for local testing).
(async () => {
  const url = new URLSearchParams(location.search).get('rom');
  if (url) {
    try {
      const r = await fetch(url);
      if (r.ok) return useRomBuffer(await r.arrayBuffer(), false);
    } catch { /* fall through */ }
  }
  const saved = await loadSavedRom();
  if (saved) useRomBuffer(saved, false);
})();
requestAnimationFrame(frame);

// expose for debugging
window.__s3 = { get game() { return game; }, startZone };
