// Tiny WebAudio sound effects. The original uses a YM2612 FM + PSG sound
// driver; these are lightweight synthesized stand-ins.
export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this._muted = false;
    this.noiseBuffers = new Map();
  }
  get muted() { return this._muted; }
  set muted(v) {
    this._muted = !!v;
    if (this.master) this.master.gain.value = v ? 0 : 1; // also silences sounds already playing
  }
  unlock() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (AC) {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this._muted ? 0 : 1;
        this.master.connect(this.ctx.destination);
      }
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
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  noise(dur, vol = 0.1, when = 0) {
    const c = this.ctx;
    if (!c || this.muted) return;
    let buf = this.noiseBuffers.get(dur);
    if (!buf) {
      const len = Math.floor(c.sampleRate * dur);
      buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      this.noiseBuffers.set(dur, buf);
    }
    const s = c.createBufferSource();
    const g = c.createGain();
    g.gain.value = vol;
    s.buffer = buf;
    s.connect(g).connect(this.master);
    s.start(c.currentTime + when);
  }
  play(name, n = 0) {
    switch (name) {
      case 'ring': this.tone(1318, 0.08, 'square', 0.06); this.tone(1760, 0.25, 'square', 0.06, 0.06); break;
      case 'jump': this.tone(300, 0.18, 'square', 0.05, 0, 3); break;
      case 'spindash': {
        // the S3 driver raises the rev pitch with each consecutive press
        const f = 200 * Math.pow(1.12, Math.min(n, 8));
        this.tone(f, 0.22, 'sawtooth', 0.05, 0, 4);
        break;
      }
      case 'instashield': this.tone(900, 0.12, 'square', 0.05, 0, 0.5); this.noise(0.08, 0.05); break;
      case 'fire': this.noise(0.3, 0.12); this.tone(150, 0.3, 'sawtooth', 0.05, 0, 2); break;
      case 'lightning': this.tone(600, 0.2, 'square', 0.05, 0, 2.5); break;
      case 'bubble': this.tone(300, 0.15, 'sine', 0.08, 0, 0.5); break;
      case 'release': this.noise(0.25, 0.08); this.tone(800, 0.2, 'sawtooth', 0.04, 0, 0.3); break;
      case 'roll': this.tone(500, 0.12, 'triangle', 0.06, 0, 0.5); break;
      case 'skid': this.noise(0.15, 0.05); break;
      case 'spring': this.tone(220, 0.3, 'square', 0.06, 0, 4); break;
      case 'destroy': this.noise(0.35, 0.15); this.tone(120, 0.3, 'square', 0.05, 0, 0.4); break;
      case 'ringloss': for (let i = 0; i < 6; i++) this.tone(1500 - i * 120, 0.08, 'square', 0.04, i * 0.04); break;
      case 'hurt': this.tone(400, 0.3, 'sawtooth', 0.06, 0, 0.3); break;
      case 'death': this.tone(500, 0.6, 'sawtooth', 0.07, 0, 0.2); break;
      case 'starpost': this.tone(880, 0.1, 'square', 0.05); this.tone(1175, 0.2, 'square', 0.05, 0.1); break;
      case 'spikemove': this.noise(0.12, 0.05); this.tone(180, 0.12, 'square', 0.03, 0, 0.6); break;
      case 'tick': this.tone(1200, 0.03, 'square', 0.03); break;
      case 'register': this.tone(1568, 0.25, 'square', 0.05); this.tone(2093, 0.3, 'square', 0.04, 0.05); break;
      case 'shield': this.tone(600, 0.3, 'triangle', 0.07, 0, 2); break;
      case '1up': [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.15, 'square', 0.05, i * 0.12)); break;
      case 'clear': [523, 659, 784, 1046, 784, 1046].forEach((f, i) => this.tone(f, 0.2, 'square', 0.05, i * 0.15)); break;
      // water (water.js / player.js)
      case 'splash': this.noise(0.3, 0.1); this.tone(700, 0.2, 'sine', 0.04, 0, 0.4); break; // sfx_Splash
      case 'airding': this.tone(1568, 0.12, 'square', 0.05); this.tone(1568, 0.12, 'square', 0.05, 0.2); break; // sfx_AirDing
      case 'airbubble': this.tone(400, 0.12, 'sine', 0.08, 0, 3); break; // sfx_Bubble
      case 'drown': this.tone(600, 0.8, 'sawtooth', 0.06, 0, 0.15); break; // sfx_Drown
      case 'drowning': [262, 277, 294, 311, 330, 349].forEach((f, i) => this.tone(f, 0.18, 'square', 0.04, i * 0.2)); break; // mus_Drowning cue
      case 'fly': this.tone(180, 0.1, 'triangle', 0.04, 0, 1.3); break; // sfx_Flying
      case 'grab': this.tone(250, 0.06, 'square', 0.05, 0, 0.6); this.noise(0.05, 0.05); break; // sfx_Grab (Knuckles)
      case 'glideland': this.noise(0.12, 0.08); this.tone(160, 0.1, 'square', 0.04, 0, 0.5); break; // sfx_GlideLand
      case 'groundslide': this.noise(0.1, 0.04); break; // sfx_GroundSlide
      case 'flytired': this.tone(140, 0.12, 'triangle', 0.035, 0, 0.8); break; // sfx_FlyTired
      case 'grab': this.tone(660, 0.08, 'square', 0.05); this.tone(990, 0.08, 'square', 0.04, 0.05); break; // sfx_Grab
      case 'music-level': break; // Player_ResetAirTimer: resume level music (no music here)
      default: break;
    }
  }
}
