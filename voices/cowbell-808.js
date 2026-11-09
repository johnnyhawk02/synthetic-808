// Cowbell laid out like the TR-808's cowbell circuit, with the constants fitted to a
// component-level simulation of that circuit (across Decay) and to a recording of a real
// TR-808 (samples/808/CB).
//
// The two cowbell oscillators (about 540 and 800 Hz) each switch a transistor. While one is
// off, the envelope current flows past it into a band-pass, so each oscillator contributes the
// envelope gated on and off by its square wave: a one-sided pulse train, not a ±1 square. The
// envelope is a capacitor with a second, slower capacitor as a load: a fast drop, then a long
// tail. A coupling high-pass feeds the band-pass (about 890 Hz), and the output stage
// high-passes again at about 330 Hz.
//
// Knobs: CB_DEC scales both envelope times (x1/3 .. x3), CB_RING the band-pass Q (x1/3 .. x3),
// both centred = as built; CB_VOL is the level.
// The oscillators come from the metal bank, so CB_TUNE, CB_O1, CB_O2 and CB_PW still apply.

import { follow } from './dsp.js';

/** legacy: true uses the Rust app's cowbell (voices/cowbell.js) instead; read when the Engine is built. */
export const COWBELL_FIT = { legacy: false };

/** Fitted constants (times in seconds, frequencies in Hz). */
export const COWBELL_808 = {
  gLo: 0.85348, gHi: 0.76358,    // 540 Hz and 800 Hz paths
  bpF: 887.04, bpQ: 5.9232,      // band-pass
  fast: 0.0082663, slow: 0.12656, mixS: 0.14238, // envelope: fast drop, slow tail and its share
  inHp: 3065.7,                  // coupling into the band-pass
  outHp: 328.8,                  // output stage
  accent: 2,
  gain: 147.9,
};

const clamp01 = (v) => Math.min(Math.max(v, 0), 1);

export class Cowbell808 {
  /** @param {number} sr  sample rate the voice runs at  @param {number} [os] oversampling factor included in sr */
  constructor(sr, os = 1) {
    const K = COWBELL_808;
    this.sr = sr;
    this.kS = follow(0.0151515151515, os);
    this.lvlS = 0; this.decS = 0.5; this._dKey = NaN;
    this.eF = 0; this.eS = 0; this.kF = 0; this.kSl = 0;
    this.pending = false; this.amp = 1; this._ring = 0.5;
    const w = 2 * Math.PI * K.bpF / sr, al = Math.sin(w) / (2 * K.bpQ), a0 = 1 + al;
    this.b = [al / a0, 0, -al / a0, -2 * Math.cos(w) / a0, (1 - al) / a0];
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
    const hp = (f) => { const K2 = Math.tan(Math.PI * f / sr); return [1 / (1 + K2), (K2 - 1) / (K2 + 1)]; };
    [this.ib, this.ia] = hp(K.inHp); [this.ob, this.oa] = hp(K.outHp);
    this.ix = 0; this.iy = 0; this.ox = 0; this.oy = 0;
  }

  /** velocity: 1 for a hit, 2 accented. */
  trigger(velocity) { this.pending = true; this.amp = velocity > 1 ? COWBELL_808.accent : 1; }

  /** cb1, cb2: the cowbell oscillators (±1) from Metal.tick(). vol = CB_VOL, dec = CB_DEC, ring = CB_RING. */
  tick(cb1, cb2, vol, dec, ring = 0.5) {
    const K = COWBELL_808;
    this.lvlS += (vol - this.lvlS) * this.kS;
    this.decS += (dec - this.decS) * this.kS;
    if (this.decS !== this._dKey) {
      this._dKey = this.decS;
      const d = 3 ** ((clamp01(this.decS) - 0.5) * 2);
      this.kF = Math.exp(-1 / (K.fast * d * this.sr)); this.kSl = Math.exp(-1 / (K.slow * d * this.sr));
    }
    if (this.pending) {
      this.pending = false;
      this.eF = Math.max(this.eF, this.amp * (1 - K.mixS)); this.eS = Math.max(this.eS, this.amp * K.mixS);
    }
    if (ring !== this._ring) {
      this._ring = ring;
      const sr = this.sr, w = 2 * Math.PI * K.bpF / sr, al = Math.sin(w) / (2 * K.bpQ * 3 ** ((clamp01(ring) - 0.5) * 2)), a0 = 1 + al;
      this.b = [al / a0, 0, -al / a0, -2 * Math.cos(w) / a0, (1 - al) / a0];
    }
    this.eF *= this.kF; this.eS *= this.kSl;
    const e = this.eF + this.eS;
    // each path conducts while its square is low
    const g = ((1 - cb1) * 0.5 * K.gLo + (1 - cb2) * 0.5 * K.gHi) * e;
    const hi = this.ib * (g - this.ix) - this.ia * this.iy; this.ix = g; this.iy = hi;
    const b = this.b, y = b[0] * hi + b[1] * this.x1 + b[2] * this.x2 - b[3] * this.y1 - b[4] * this.y2;
    this.x2 = this.x1; this.x1 = hi; this.y2 = this.y1; this.y1 = y;
    const o = this.ob * (y - this.ox) - this.oa * this.oy; this.ox = y; this.oy = o;
    return o * this.lvlS * K.gain;
  }
}
