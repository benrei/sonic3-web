// Player character modes (Player_mode in the original: 0 Sonic & Tails, 1 Sonic alone,
// 2 Tails alone, 3 Knuckles alone). `available` is switched on once a mode is implemented;
// Knuckles needs the Sonic 3 & Knuckles ROM.
export const CHARACTER_MODES = [
  { id: 'sonic-tails', playerMode: 0, label: 'Sonic & Tails', requiresSK: false, available: false },
  { id: 'sonic', playerMode: 1, label: 'Sonic', requiresSK: false, available: true },
  { id: 'tails', playerMode: 2, label: 'Tails', requiresSK: false, available: false },
  { id: 'knuckles', playerMode: 3, label: 'Knuckles', requiresSK: true, available: false },
];

export function modesFor(rom) {
  return CHARACTER_MODES.filter((m) => m.available && (!m.requiresSK || rom?.sk));
}
