// Player character modes (Player_mode in the original: 0 Sonic & Tails, 1 Sonic alone,
// 2 Tails alone, 3 Knuckles alone). `available` is switched on once a mode is implemented;
// Knuckles needs the Sonic 3 & Knuckles ROM.
export const CHARACTER_MODES = [
  { id: 'sonic-tails', playerMode: 0, label: 'Sonic & Tails', requiresSK: false, available: true },
  { id: 'sonic', playerMode: 1, label: 'Sonic', requiresSK: false, available: true },
  { id: 'tails', playerMode: 2, label: 'Tails', requiresSK: false, available: true },
  { id: 'knuckles', playerMode: 3, label: 'Knuckles', requiresSK: true, available: true },
];

export function modesFor(rom) {
  return CHARACTER_MODES.filter((m) => m.available && (!m.requiresSK || rom?.sk));
}

// Player object factories, registered by each character module:
//   registerCharacter('tails', (rom, level, game) => new Tails(rom, level, game))
// game.js asks createLeadPlayer() for Player_1 and createSidekick() for Player_2 (Tails CPU in
// "Sonic & Tails" mode). The default lead is Sonic (player.js).
const factories = new Map();
export function registerCharacter(id, factory) { factories.set(id, factory); }
export function createCharacter(id, rom, level, game) {
  const f = factories.get(id);
  return f ? f(rom, level, game) : null;
}
// Which object is Player_1 for a mode ('sonic-tails' -> sonic, 'tails' -> tails, ...).
export function leadCharacterFor(mode) {
  return mode === 'tails' ? 'tails' : mode === 'knuckles' ? 'knuckles' : 'sonic';
}
// Which object is Player_2 for a mode (null = none): the Tails CPU in "Sonic & Tails".
export function sidekickFor(mode) {
  return mode === 'sonic-tails' ? 'tails-cpu' : null;
}
