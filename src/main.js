import { Rom, ZONES } from './rom.js';
import { Game } from './game.js';
import { Audio } from './audio.js';
import { SCREEN_W, SCREEN_H } from './vdp.js';
import { modesFor } from './characters.js';

const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const wrap = document.getElementById('screen-wrap');
const loader = document.getElementById('loader');
const menu = document.getElementById('menu');
const zoneList = document.getElementById('zone-list');
const menuHint = document.getElementById('menu-hint');
const menuNote = document.getElementById('menu-note');
const charSel = document.getElementById('char-select');
const charName = document.getElementById('char-name');
const errorEl = document.getElementById('error');
const romInput = document.getElementById('rom-input');
const audio = new Audio();
const image = ctx.createImageData(SCREEN_W, SCREEN_H);
const COLS = 2, ROWS = Math.ceil(ZONES.length / COLS);

let rom = null;
let game = null; // kept while the menu is open so Esc can resume it
let paused = false;
let menuIndex = 0;
let onCharRow = false; // keyboard/gamepad focus on the character selector
let character = localStorage.getItem('sonic3-character') || 'sonic';
let carry = { lives: 3, score: 0 };
let dirty = true;
let toast = null; // { text, t }
let lastInputKind = matchMedia('(pointer: coarse)').matches ? 'touch' : 'keyboard';

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
async function dbOp(mode, fn) {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const q = fn(db.transaction(STORE, mode).objectStore(STORE));
      q.onsuccess = () => res(q.result ?? null);
      q.onerror = () => res(null);
    });
  } catch { return null; } // private mode etc.
}
const saveRom = (buf) => dbOp('readwrite', (s) => s.put(buf, 'rom'));
const loadSavedRom = () => dbOp('readonly', (s) => s.get('rom'));
const forgetRom = () => dbOp('readwrite', (s) => s.delete('rom'));

function useRomBuffer(buf, remember) {
  try {
    rom = new Rom(new Uint8Array(buf));
    if (remember) saveRom(buf);
    errorEl.textContent = '';
    loader.hidden = true;
    game = null;
    openMenu(rom.checksum !== 0x3ae0 && rom.checksum !== 0xa8f2
      ? 'Merk: Sonic 3-delen av filen er ikke en utgave vi kjenner (sjekksum $3AE0 / $A8F2). Noe kan se rart ut.'
      : '');
  } catch (e) {
    errorEl.textContent = 'Fant ikke Sonic 3 i denne filen. Velg Sonic the Hedgehog 3 (.bin, 2 MB) eller Sonic 3 & Knuckles (.bin, 4 MB) for Mega Drive/Genesis – ikke Sonic & Knuckles alene.';
  }
}

romInput.addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = ''; // allow picking the same file again
  if (f) useRomBuffer(await f.arrayBuffer(), true);
});
// Accept drops anywhere on the page (and never let the browser open the file).
let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) loader.classList.add('drag'); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; loader.classList.remove('drag'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  loader.classList.remove('drag');
  const f = e.dataTransfer?.files[0];
  if (f) useRomBuffer(await f.arrayBuffer(), true);
});

// ---------------- Menu ----------------
function openMenu(note = '') {
  paused = false;
  menu.hidden = false;
  menuNote.textContent = note;
  zoneList.innerHTML = '';
  ZONES.forEach((z, i) => {
    const li = document.createElement('li');
    li.textContent = `${z.name.replace(' Zone', '')} ${z.act}`;
    li.setAttribute('role', 'option');
    li.onclick = () => startZone(i);
    li.onmouseenter = () => { menuIndex = i; highlightMenu(); };
    zoneList.append(li);
  });
  document.getElementById('resume').hidden = !game || game.gameOver;
  updateCharSelect();
  updateMenuHint();
  highlightMenu();
  dirty = true;
}
function closeMenuResume() {
  if (!game || game.gameOver) return;
  menu.hidden = true;
  dirty = true;
}
function updateCharSelect() {
  const modes = modesFor(rom);
  if (!modes.some((m) => m.id === character)) character = modes[0]?.id ?? 'sonic';
  charSel.hidden = modes.length < 2;
  charName.textContent = modes.find((m) => m.id === character)?.label ?? 'Sonic';
  charSel.classList.toggle('sel', onCharRow);
}
function cycleCharacter(dir) {
  const modes = modesFor(rom);
  const i = modes.findIndex((m) => m.id === character);
  character = modes[(i + dir + modes.length) % modes.length].id;
  localStorage.setItem('sonic3-character', character);
  updateCharSelect();
}
document.getElementById('char-prev').onclick = () => cycleCharacter(-1);
document.getElementById('char-next').onclick = () => cycleCharacter(1);
function highlightMenu() {
  [...zoneList.children].forEach((li, i) => {
    li.classList.toggle('sel', i === menuIndex);
    li.setAttribute('aria-selected', i === menuIndex);
  });
}
function updateMenuHint() {
  menuHint.textContent = {
    keyboard: 'Velg med piltastene og trykk Enter – eller klikk. Esc går tilbake til spillet.',
    touch: 'Trykk på en sone for å starte.',
    gamepad: 'Velg med styrekorset og trykk A eller Start. Select går tilbake til spillet.',
  }[lastInputKind];
}
function menuNavigate(p) {
  if (onCharRow) {
    if (p.left) cycleCharacter(-1);
    if (p.right) cycleCharacter(1);
    if (p.down || p.start || p.a || p.b || p.c) { onCharRow = false; updateCharSelect(); highlightMenu(); }
    else if (p.back) closeMenuResume();
    return;
  }
  if (p.up && menuIndex % ROWS === 0 && !charSel.hidden) { onCharRow = true; updateCharSelect(); [...zoneList.children].forEach((li) => li.classList.remove('sel')); return; }
  let col = Math.floor(menuIndex / ROWS), row = menuIndex % ROWS;
  if (p.down) row = (row + 1) % ROWS;
  if (p.up) row = (row + ROWS - 1) % ROWS;
  if (p.right || p.left) col = (col + 1) % COLS;
  const i = Math.min(ZONES.length - 1, col * ROWS + row);
  if (i !== menuIndex) { menuIndex = i; highlightMenu(); }
  if (p.start || p.a || p.b || p.c) startZone(menuIndex);
  else if (p.back) closeMenuResume();
}
document.getElementById('resume').onclick = closeMenuResume;
document.getElementById('change-rom').onclick = async () => {
  await forgetRom();
  rom = null;
  game = null;
  menu.hidden = true;
  loader.hidden = false;
};

function startZone(i, keepCheckpoint = false) {
  audio.unlock();
  menuIndex = i;
  menu.hidden = true;
  const state = { ...carry, character };
  if (keepCheckpoint && game?.checkpoint) state.checkpoint = game.checkpoint;
  game = new Game(rom, i, audio, state);
  paused = false;
  swallowHeld();
  dirty = true;
}

// ---------------- Input ----------------
const KEYMAP = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  KeyZ: 'a', KeyX: 'b', KeyC: 'c', Space: 'c', KeyA: 'a', KeyS: 'b', KeyD: 'c', Enter: 'start', Escape: 'back',
};
const KEYS = ['up', 'down', 'left', 'right', 'a', 'b', 'c', 'start', 'back'];
// Second controller (Ctrl_2): takes over the Tails sidekick in "Sonic & Tails" (I/J/K/L + Q,
// or gamepad #2)
const KEYMAP2 = { KeyI: 'up', KeyJ: 'left', KeyK: 'down', KeyL: 'right', KeyQ: 'a' };
const held2 = {};
const latch2 = {}; // presses shorter than a frame still count
let prevHeld2 = {};
const held = {};
const touchHeld = {};
const latch = {}; // presses shorter than a frame still count
let prevHeld = {};

addEventListener('keydown', (e) => {
  lastInputKind = 'keyboard';
  audio.unlock();
  const k = KEYMAP[e.code];
  if (k) {
    e.preventDefault();
    if (!e.repeat) latch[k] = true;
    held[k] = true;
  }
  const k2 = KEYMAP2[e.code];
  if (k2) { e.preventDefault(); if (!e.repeat) latch2[k2] = true; held2[k2] = true; }
  if (e.code === 'KeyM') toggleMute();
  if (e.code === 'KeyF') toggleFullscreen();
});
addEventListener('keyup', (e) => {
  const k = KEYMAP[e.code];
  if (k) held[k] = false;
  const k2 = KEYMAP2[e.code];
  if (k2) held2[k2] = false;
});

// Releasing everything when focus is lost avoids "stuck" keys after alt-tab.
function releaseAll() {
  for (const k of KEYS) { held[k] = false; touchHeld[k] = false; held2[k] = false; }
  touchPointers.clear();
}
function swallowHeld() { for (const k of KEYS) { prevHeld[k] = true; latch[k] = false; } }
addEventListener('blur', () => { releaseAll(); if (game && menu.hidden) paused = true; dirty = true; });
document.addEventListener('visibilitychange', () => { if (document.hidden) { releaseAll(); if (game && menu.hidden) paused = true; dirty = true; } });

// Touch: one d-pad element (direction from finger position, so sliding works) + buttons.
const touchPointers = new Map(); // pointerId -> keys[]
const dpad = document.getElementById('dpad');
function dpadKeys(e) {
  const r = dpad.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const dead = r.width * 0.12, keys = [];
  if (dx < -dead) keys.push('left');
  if (dx > dead) keys.push('right');
  if (dy < -dead) keys.push('up');
  if (dy > dead) keys.push('down');
  return keys;
}
function refreshTouch() {
  for (const k of KEYS) touchHeld[k] = false;
  for (const keys of touchPointers.values()) for (const k of keys) {
    if (!touchHeld[k]) latch[k] = true;
    touchHeld[k] = true;
  }
}
dpad.addEventListener('pointerdown', (e) => { e.preventDefault(); lastInputKind = 'touch'; audio.unlock(); dpad.setPointerCapture(e.pointerId); touchPointers.set(e.pointerId, dpadKeys(e)); refreshTouch(); });
dpad.addEventListener('pointermove', (e) => { if (touchPointers.has(e.pointerId)) { touchPointers.set(e.pointerId, dpadKeys(e)); refreshTouch(); } });
for (const b of document.querySelectorAll('#touch [data-key]')) {
  const k = b.dataset.key;
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); lastInputKind = 'touch'; audio.unlock(); touchPointers.set(e.pointerId, [k]); refreshTouch(); });
}
for (const ev of ['pointerup', 'pointercancel']) {
  addEventListener(ev, (e) => { if (touchPointers.delete(e.pointerId)) refreshTouch(); });
}
document.getElementById('touch').addEventListener('contextmenu', (e) => e.preventDefault());

let padPrev = '';
function readInput() {
  const cur = {};
  for (const k of KEYS) cur[k] = !!(held[k] || touchHeld[k]);
  const cur2 = {};
  for (const k of KEYS) cur2[k] = !!(held2[k] || latch2[k]);
  const pads = [...(navigator.getGamepads?.() || [])].filter(Boolean);
  for (const [i, pad] of pads.entries()) {
    const ax = pad.axes[0] || 0, ay = pad.axes[1] || 0, bt = (i) => !!pad.buttons[i]?.pressed;
    const p = {
      left: ax < -0.4 || bt(14), right: ax > 0.4 || bt(15), up: ay < -0.4 || bt(12), down: ay > 0.4 || bt(13),
      a: bt(2) || bt(3), b: bt(0), c: bt(1), start: bt(9), back: bt(8),
    };
    if (i === 1) { for (const k in p) cur2[k] ||= p[k]; continue; } // gamepad #2 = Ctrl_2
    const sig = JSON.stringify(p);
    if (sig !== padPrev && Object.values(p).some(Boolean)) lastInputKind = 'gamepad';
    padPrev = sig;
    for (const k in p) cur[k] ||= p[k];
  }
  const pressed = {}, pressed2 = {};
  for (const k of KEYS) { pressed[k] = (cur[k] && !prevHeld[k]) || !!latch[k]; latch[k] = false; }
  for (const k of KEYS) { pressed2[k] = (cur2[k] && !prevHeld2[k]) || !!latch2[k]; latch2[k] = false; }
  prevHeld = cur;
  prevHeld2 = cur2;
  return { held: cur, pressed, input2: { held: cur2, pressed: pressed2 } };
}

// ---------------- Sound / fullscreen ----------------
audio.muted = localStorage.getItem('sonic3-muted') === '1';
function toggleMute() {
  audio.muted = !audio.muted;
  localStorage.setItem('sonic3-muted', audio.muted ? '1' : '0');
  showToast(audio.muted ? 'LYD AV' : 'LYD PÅ');
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else wrap.requestFullscreen?.().catch(() => {});
}
function showToast(text) { toast = { text, t: 90 }; dirty = true; }

// ---------------- Main loop (fixed 59.92 Hz, redraw only when something changed) ----------------
const STEP = 1000 / 59.92;
let last = performance.now(), acc = 0;
function frame(now) {
  acc += Math.min(100, now - last);
  last = now;
  while (acc >= STEP) {
    acc -= STEP;
    tick();
  }
  if (dirty) { dirty = false; draw(); }
  requestAnimationFrame(frame);
}

function tick() {
  const input = readInput();
  if (toast && --toast.t <= 0) { toast = null; dirty = true; }
  if (!rom) return;
  if (!menu.hidden) { menuNavigate(input.pressed); return; }
  if (!game) return;
  if (input.pressed.back) { openMenu(); return; }
  if (input.pressed.start) {
    if (game.gameOver) { carry = { lives: 3, score: 0 }; game = null; openMenu(); return; }
    paused = !paused;
    dirty = true;
  }
  if (paused) return;
  game.update(input, input.input2);
  dirty = true;
  if (game.restartRequested) {
    carry = { lives: game.lives, score: game.score, nextExtraLife: game.nextExtraLife };
    startZone(game.zoneIndex, true);
  } else if (game.resultsDone) {
    carry = { lives: game.lives, score: game.score, nextExtraLife: game.nextExtraLife };
    if (game.zoneIndex + 1 < ZONES.length) startZone(game.zoneIndex + 1);
    else { game = null; carry = { lives: 3, score: 0 }; openMenu('Gratulerer – du har klart alle sonene!'); }
  }
}

function draw() {
  if (game) {
    game.render();
    new Uint32Array(image.data.buffer).set(game.vdp.frame);
    ctx.putImageData(image, 0, 0);
    const o = game.overlay;
    if (o) drawOverlay(o);
    if (paused && menu.hidden) banner('PAUSE', 112);
  } else {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  }
  if (toast) banner(toast.text, 24, '#ffd200', 12);
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
    banner(`${game.character === 'tails' ? 'TAILS' : 'SONIC'} GOT THROUGH`, 64, '#fff', 20);
    banner(`ACT ${game.zone.act}`, 86, '#ffd200', 18);
    const r = o.results;
    if (r) {
      // Obj_LevelResults: TIME BONUS / RING BONUS / TOTAL (values in points)
      const row = (label, v, y) => { tally(label, 88, y, '#ffd200'); tally(String(v * 10), 232, y, '#fff', 'right'); };
      row('TIME BONUS', r.time, 128);
      row('RING BONUS', r.ring, 146);
      row('TOTAL', r.total, 170);
    }
  } else if (o.kind === 'timeover') {
    banner('TIME OVER', 112, '#fff', 28);
  } else if (o.kind === 'gameover' || o.kind === 'timeover-gameover') {
    banner(o.kind === 'gameover' ? 'GAME OVER' : 'TIME OVER', 112, '#fff', 28);
    banner(lastInputKind === 'touch' ? 'trykk START' : 'trykk Enter / Start', 140, '#ffd200', 12);
  }
}

function tally(text, x, y, color, align = 'left') {
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = align;
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#000';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

// Boot: try ?rom=<url> (handy for local testing), else a ROM saved in this browser.
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

// exposed for debugging / automated tests
window.__s3 = { get game() { return game; }, startZone };
