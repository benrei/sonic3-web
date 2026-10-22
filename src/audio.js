// Tiny WebAudio sound effects. The original uses a YM2612 FM + PSG sound
// driver; these are lightweight synthesized stand-ins.
export class Audio {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }
  unlock() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    this.ctx?.resume?.();
  }
  tone(freq, dur, type = 'square', vol = 0.08, when = 0, slide = 0) {
    const c = this.ctx;
    if (!c || this.muted) return;
    const t = c.currentTime + when;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  noise(dur, vol = 0.1, when = 0) {
    const c = this.ctx;
    if (!c || this.muted) return;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const s = c.createBufferSource();
    const g = c.createGain();
    g.gain.value = vol;
    s.buffer = buf;
    s.connect(g).connect(c.destination);
    s.start(c.currentTime + when);
  }
  play(name) {
    switch (name) {
      case 'ring': this.tone(1318, 0.08, 'square', 0.06); this.tone(1760, 0.25, 'square', 0.06, 0.06); break;
      case 'jump': this.tone(300, 0.18, 'square', 0.05, 0, 3); break;
      case 'spindash': this.tone(200, 0.2, 'sawtooth', 0.05, 0, 4); break;
      case 'release': this.noise(0.25, 0.08); this.tone(800, 0.2, 'sawtooth', 0.04, 0, 0.3); break;
      case 'roll': this.tone(500, 0.12, 'triangle', 0.06, 0, 0.5); break;
      case 'skid': this.noise(0.15, 0.05); break;
      case 'spring': this.tone(220, 0.3, 'square', 0.06, 0, 4); break;
      case 'destroy': this.noise(0.35, 0.15); this.tone(120, 0.3, 'square', 0.05, 0, 0.4); break;
      case 'ringloss': for (let i = 0; i < 6; i++) this.tone(1500 - i * 120, 0.08, 'square', 0.04, i * 0.04); break;
      case 'hurt': this.tone(400, 0.3, 'sawtooth', 0.06, 0, 0.3); break;
      case 'death': this.tone(500, 0.6, 'sawtooth', 0.07, 0, 0.2); break;
      case 'starpost': this.tone(880, 0.1, 'square', 0.05); this.tone(1175, 0.2, 'square', 0.05, 0.1); break;
      case 'shield': this.tone(600, 0.3, 'triangle', 0.07, 0, 2); break;
      case '1up': [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.15, 'square', 0.05, i * 0.12)); break;
      case 'clear': [523, 659, 784, 1046, 784, 1046].forEach((f, i) => this.tone(f, 0.2, 'square', 0.05, i * 0.15)); break;
      default: break;
    }
  }
}
