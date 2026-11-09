// Rim shot and claves laid out like the TR-808's rim shot / claves board, with the constants
// fitted to a component-level simulation of that board (across its decay, pitch and click
// settings) and to recordings of a real TR-808 (samples/808/RS and CL).
//
// Rim shot: two bridged-T resonators (about 470 Hz and 1.9 kHz) are kicked by the trigger.
//   Their sum drives a "swing" VCA: a transistor whose collector is pulled down by the signal's
//   positive half-waves but never below a fast envelope (a capacitor charged by the trigger).
//   That chops the tones into a woody, harmonic-rich click. A resonant ~590 Hz high-pass
//   follows, and a FET mutes the output a few milliseconds after the hit.
// Claves: one resonator (about 2.5 kHz) rings until the mute timer lets the FET short the
//   output; a little of the ring leaks past it, and switching the FET leaves a small thump.
//
// Knobs (centred = as built): TUNE moves the pitch (x0.5 .. x2), DEC scales the envelope and
// mute timer (x1/3 .. x3). Rim shot only: OSC1 / OSC2 set the low / high resonator levels
// (0 .. x2), RES the drive into the VCA (x1/3 .. x3), FLT raises the high-pass (0 = as built).

/** legacy: true uses the Rust app's rim shot (voices/rimshot.js) instead; read when the Engine is built. */
export const RIM_FIT = { legacy: false };

/** Fitted constants (times in seconds, frequencies in Hz). */
export const RIM_808 = {
  // rim shot
  fH: 1883.8, qH: 12.59, fL: 473.25, qL: 7.984, kH: 0.1879, kL: 0.07698,
  eK: 0.4078, eTau: 0.0043177, vca: 13.242, mute: 0.013039, muteTau: 0.0023122,
  hpF: 586.4, hpQ: 2.872, rsGain: 6.84,
  // claves
  f: 2478.4, ring: 0.45523, k: 0.3709, clMute: 0.022501, clMuteTau: 1.29e-5, floor: 0.022808,
  floorTau: 0.235, thA: 0.23969, thW: 0.010401, clGain: 1.51,
  // trigger bus volts, normal and accented
  vb: 4.44, vbAccent: 8.88,
};

const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
const span = (v, s) => s ** ((clamp01(v) - 0.5) * 2);
const LN10 = Math.log(10);

/** Damped sine started by a hit: y = a·sin(wn)·r^n, as a two-pole recursion. */
class Ring {
  constructor() { this.y1 = 0; this.y2 = 0; this.c = 0; this.r2 = 0; this.out = 0; }
  start(f, q, a, sr) {
    const w = 2 * Math.PI * Math.min(f, sr * 0.45) / sr, r = Math.exp(-Math.PI * f / (q * sr));
    this.c = 2 * r * Math.cos(w); this.r2 = r * r;
    // y[0] = 0, y[1] = a·r·sin(w); the recursion carries on from there
    this.y2 = 0; this.y1 = a * r * Math.sin(w); this.out = 0;
  }
  tick() {
    const y = this.out;
    const n = this.c * this.y1 - this.r2 * this.y2;
    this.out = this.y1; this.y2 = this.y1; this.y1 = n;
    return y;
  }
}

export class Rim808 {
  /** @param {number} sr  sample rate the voice runs at  @param {number} [os] oversampling factor included in sr */
  constructor(sr, os = 1) {
    this.sr = sr; this.os = os;
    this.hi = new Ring(); this.lo = new Ring();
    this.rimMode = true; this.pending = false; this.on = false;
    this.vb = RIM_808.vb; this.t = 0;
    this.e = 0; this.eK = 0; this.g = 0; this.muteN = 0; this.mK = 0; this.m = 0;
    this.fl = 0; this.flK = 0; this.thN = 0; this.thK = 0; this.th = 0;
    this.hb = [0, 0, 0, 0, 0]; this.x1 = 0; this.x2 = 0; this.h1 = 0; this.h2 = 0;
  }

  /** velocity: 1 for a hit, 2 accented. rimMode: true = rim shot, false = claves. */
  trigger(velocity, rimMode) {
    this.rimMode = !!rimMode;
    this.vb = velocity > 1 ? RIM_808.vbAccent : RIM_808.vb;
    this.pending = true;
  }

  _start(k) {
    const K = RIM_808, sr = this.sr, vb = this.vb;
    const d = span(k.dec, 3), m = span(k.tune, 2);
    this.t = 0; this.m = 1; this.on = true;
    if (this.rimMode) {
      this.hi.start(K.fH * m, K.qH, vb * K.kH * 2 * Math.max(k.osc2, 0), sr);
      this.lo.start(K.fL * m, K.qL, vb * K.kL * 2 * Math.max(k.osc1, 0), sr);
      this.e = vb * K.eK; this.eK = Math.exp(-1 / (K.eTau * d * sr));
      this.g = K.vca * span(k.res, 3);
      this.muteN = Math.round(K.mute * d * sr); this.mK = Math.exp(-1 / (K.muteTau * d * sr));
      const w = 2 * Math.PI * Math.min(K.hpF * (1 + 3 * clamp01(k.flt)), sr * 0.45) / sr;
      const cw = Math.cos(w), al = Math.sin(w) / (2 * K.hpQ), a0 = 1 + al;
      this.hb = [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, -2 * cw / a0, (1 - al) / a0];
    } else {
      this.hi.start(K.f * m, Math.PI * K.f * K.ring / LN10, vb * K.k, sr);
      this.muteN = Math.round(K.clMute * d * sr); this.mK = Math.exp(-1 / (K.clMuteTau * d * sr));
      this.fl = K.floor; this.flK = Math.exp(-1 / (K.floorTau * d * sr));
      this.thN = Math.round(K.thW * sr); this.thK = 1 - Math.exp(-1 / (K.thW * sr)); // one-pole at 1 / (2π·thW)
      this.th = 0;
    }
  }

  /** @param {{tune:number, dec:number, osc1:number, osc2:number, flt:number, res:number}} k */
  tick(k) {
    if (this.pending) { this.pending = false; this._start(k); }
    if (!this.on) return 0;
    const K = RIM_808, t = this.t++;
    if (t > this.muteN) this.m *= this.mK;
    let y;
    if (this.rimMode) {
      const s = this.hi.tick() + this.lo.tick();
      const pull = s > 0 ? s * this.g : 0;
      const v = -(pull < this.e ? pull : this.e);
      this.e *= this.eK;
      const b = this.hb, h = b[0] * v + b[1] * this.x1 + b[2] * this.x2 - b[3] * this.h1 - b[4] * this.h2;
      this.x2 = this.x1; this.x1 = v; this.h2 = this.h1; this.h1 = h;
      y = h * this.m * K.rsGain;
    } else {
      if (t > this.muteN) this.fl *= this.flK;
      const r = this.hi.tick() * (this.fl + (1 - K.floor) * this.m);
      const pulse = t > this.muteN && t < this.muteN + this.thN ? this.vb * K.thA : 0;
      this.th += this.thK * (pulse - this.th);
      y = (r + this.th) * K.clGain;
    }
    if (t > this.sr * 3) this.on = false;
    return y;
  }
}
