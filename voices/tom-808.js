// Toms and congas laid out like the TR-808's tom / conga boards, with the constants fitted to a
// component-level simulation of those boards (across the Tuning knob) and to recordings of a
// real TR-808 (samples/808/LT ... HC).
//
// Each drum is a bridged-T resonator kicked by the 1 ms trigger pulse: a damped sine whose
// pitch is set by the tuning pot. The higher the tuning, the louder the drum (less of the kick
// is lost in the pot). Positive feedback around the resonator's op-amp makes the ring build up
// over the first few milliseconds, modelled as a short swell. The toms add a burst of pink
// noise through a VCA and a low-pass, decaying about as fast as the ring; its spectrum falls
// steeply, so it mostly thickens the low end.
//
// Knobs (centred = as built): TUNE sweeps the pitch over the pot's range, DEC multiplies the
// ring time (x1/3 .. x3), ATK sets the tom noise (0 .. x2, then up to x8), FLT tunes the
// noise low-pass (x1/4 .. x4).

import { XorShift64, follow } from './dsp.js';

/** legacy: true uses the Rust app's toms (voices/tom.js) instead; read when the Engine is built. */
export const TOM_FIT = { legacy: false };

const LN10 = Math.log(10);

/**
 * Fitted constants per drum. f0/f5/f1: pitch (Hz) at tuning min / centre / max; g0/g1: level at
 * min / max relative to centre; t10: ring time to -20 dB (s); sw/swT: swell depth and time
 * constant; toms: nK noise level, nDec its decay (s), nLp its low-pass (Hz). gain: output level.
 */
export const TOM_808 = {
  lt: { f0: 79.72, f5: 87.91, f1: 94.47, g0: 0.6449, g1: 1.165, t10: 0.2048, sw: 0.3102, swT: 0.001523, nK: 69.9, nDec: 0.1339, nLp: 1.587, gain: 9.77 },
  mt: { f0: 129.4, f5: 135.8, f1: 148.3, g0: 0.5521, g1: 0.9786, t10: 0.1275, sw: 0.1062, swT: 1.002, nK: 63.6, nDec: 0.1436, nLp: 1.041, gain: 12.9 },
  ht: { f0: 161, f5: 187.2, f1: 199.3, g0: 0.5063, g1: 0.8871, t10: 0.08124, sw: 0.6703, swT: 0.2891, nK: 48.2, nDec: 0.143, nLp: 0.5886, gain: 28.0 },
  lc: { f0: 175.2, f5: 191.5, f1: 213.9, g0: 0.8144, g1: 1.214, t10: 0.1815, sw: 0.01041, swT: 1, gain: 9.07 },
  mc: { f0: 251.9, f5: 275.8, f1: 307.9, g0: 0.8089, g1: 1.156, t10: 0.09413, sw: 0, swT: 0.01, gain: 9.93 },
  hc: { f0: 368.7, f5: 402.6, f1: 449.8, g0: 0.8302, g1: 1.213, t10: 0.08624, sw: 0, swT: 0.01, gain: 10.5 },
  accent: 2,
};

/** Drum keys per voice slot: [tom, conga]. */
export const TOM_808_KEYS = [['lt', 'lc'], ['mt', 'mc'], ['ht', 'hc']];

const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
const span = (v, s) => s ** ((clamp01(v) - 0.5) * 2);
const map3 = (p, lo, mid, hi) => (p < 0.5 ? lo * (mid / lo) ** (2 * p) : mid * (hi / mid) ** (2 * p - 1));
const lerp = (a, b, t) => a + (b - a) * t;

export class Tom808 {
  /**
   * @param {number} slot 0 low, 1 mid, 2 high  @param {number} sr sample rate the voice runs at
   * @param {number|bigint} seed noise seed  @param {number} [os] oversampling factor included in sr
   */
  constructor(slot, sr, seed, os = 1) {
    this.keys = TOM_808_KEYS[slot];
    this.sr = sr;
    this.k02 = follow(0.02, os);
    this.noise = new XorShift64(BigInt(seed) | 1n);
    this.noiseGain = Math.sqrt(os); // white noise keeps its audible-band power when oversampled
    this.F = TOM_808[this.keys[0]];
    this.tom = true;
    this.tuneS = 0.5; this.decS = 0.5; this.fltS = 0.5;
    this._t = NaN; this._d = NaN; this._f = NaN; this._ns = 0; this.ringH = 0;
    // resonator (trapezoidal SVF band-pass) and its state
    this.g = 0; this.k = 1; this.a1 = 0; this.a2 = 0; this.a3 = 0; this.ic1 = 0; this.ic2 = 0;
    this.pulseN = 0; this.pulseH = 0; this.amp = 0;
    this.sw = 0; this.swK = 0;
    // noise: P.N. bus (271 Hz Sallen-Key low-pass) then a one-pole low-pass
    this.p1 = 0; this.p2 = 0; this.pb = [0, 0, 0, 0, 0]; this.nl = 0; this.nE = 0; this.nK = 0; this.nB = 0; this.nA = 0;
    this._pinkSet();
  }

  _pinkSet() {
    const w = 2 * Math.PI * 271 / this.sr, c = Math.cos(w), al = Math.sin(w) / (2 * 0.74), a0 = 1 + al;
    this.pb = [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - al) / a0];
  }

  /** velocity: 1 for a hit, 2 accented. tomMode: the TOM/CONGA switch (true = tom). */
  trigger(velocity, tomMode) {
    this.tom = !!tomMode;
    this.F = TOM_808[this.keys[this.tom ? 0 : 1]];
    this._t = NaN;
    this.amp = velocity > 1 ? TOM_808.accent : 1;
    this.pulseN = Math.max(1, Math.round(0.001 * this.sr));
    this.pulseH = -1; // set on the next tick, once the knobs are read
    this.sw = this.F.sw;
    this.swK = Math.exp(-1 / (this.F.swT * this.sr));
    this.nE = this.F.nK ? this.amp : 0;
  }

  _set() {
    const F = this.F, sr = this.sr, t = this.tuneS;
    const f = Math.min(map3(t, F.f0, F.f5, F.f1), sr * 0.45);
    const lvl = t < 0.5 ? lerp(F.g0, 1, t * 2) : lerp(1, F.g1, t * 2 - 1);
    const q = Math.PI * f * F.t10 * span(this.decS, 3) / LN10;
    this.g = Math.tan(Math.PI * f / sr); this.k = 1 / q;
    this.a1 = 1 / (1 + this.g * (this.g + this.k)); this.a2 = this.g * this.a1; this.a3 = this.g * this.a2;
    // pulse height that leaves the ring with peak amplitude lvl
    this.ringH = lvl / (2 * this.k * Math.max(Math.abs(Math.sin(Math.PI * f * 0.001)), 0.05));
    if (F.nK) {
      this.nK = Math.exp(-1 / (F.nDec * span(this.decS, 3) * sr));
      const K = Math.tan(Math.PI * Math.min(F.nLp * span(this.fltS, 4), sr * 0.45) / sr);
      this.nB = K / (1 + K); this.nA = (K - 1) / (K + 1);
    }
  }

  /** One sample. Knobs 0..1: xT_TUNE, xT_DEC, xT_ATK (tom noise), xT_FLT (noise filter). */
  tick(tune, dec, atk, flt) {
    this.tuneS += (tune - this.tuneS) * this.k02;
    this.decS += (dec - this.decS) * this.k02;
    this.fltS += (flt - this.fltS) * this.k02;
    if (this.tuneS !== this._t || this.decS !== this._d || this.fltS !== this._f) {
      this._t = this.tuneS; this._d = this.decS; this._f = this.fltS; this._set();
    }
    const F = this.F;

    let x = 0;
    if (this.pulseN > 0) {
      if (this.pulseH < 0) this.pulseH = this.ringH * this.amp;
      this.pulseN -= 1; x = this.pulseH;
    }
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    let y = this.k * v1 * (1 - this.sw);
    this.sw *= this.swK;

    if (this.tom && this.nE > 1e-6) {
      const n = this.noise.next() * this.noiseGain;
      const b = this.pb, p = b[0] * n + this.p1;
      this.p1 = b[1] * n - b[3] * p + this.p2;
      this.p2 = b[2] * n - b[4] * p;
      const a = clamp01(atk), amt = a < 0.5 ? 2 * a : 8 ** (2 * a - 1);
      const s = p * this.nE * F.nK * amt;
      this.nl = this.nB * s + this.nB * this._ns - this.nA * this.nl; this._ns = s;
      this.nE *= this.nK;
      y += this.nl;
    }
    return y * F.gain;
  }
}
