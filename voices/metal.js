// Shared "metal" oscillator bank and the cowbell's two oscillators (port of app/src/metal.rs).
// Every sample it produces two high-passed metal mixes (≈7.1 kHz `hi` and ≈3.4 kHz `lo`,
// used by the cymbal and hi-hats) and the cowbell's two pulse waves (`cb1`, `cb2`, ±1).

import { sgnpow, follow } from './dsp.js';

/** knob → 0..1 with an S-shaped curve: 0.5 ± 0.5·|2v−1|^pow */
function shape(v, pow) {
  const x = 2 * v - 1;
  let m = Math.pow(Math.abs(x), pow);
  if (!Number.isFinite(m)) m = 0;
  return 0.5 + (x >= 0 ? 0.5 : -0.5) * m;
}

/** Pulse oscillator: phase steps by 1/period, output is high while 0 < phase ≤ duty. */
class Pulse {
  constructor() { this.flag = 0; this.phase = 0; }
  step(periodSamples, duty) {
    if (0 >= duty) { this.flag = 0; return 0; }
    if (duty >= 1) { this.flag = 1; return 1; }
    this.phase += 1 / Math.max(periodSamples, 1);
    if (this.flag !== 0) {
      if (this.phase > duty) {
        this.flag = 0;
        this.phase -= Math.floor(this.phase + 1 - duty);
      }
    } else if (this.phase > 0) {
      this.flag = 1;
    }
    return this.flag;
  }
}

/** Metal oscillator periods (ms) for 205.35, 304.4, 369.72, 522.7, 540.54, 800 Hz. */
const SM_MS = [4.869810045, 3.285189867, 2.705450058, 1.913139969, 1.850000024, 1.25];
export const CB_HZ = [540.54, 800.0];
/** shaping exponent for the DUTY, VOLT, CB_PW and CB_TUNE knobs */
const HH_POW = 2.33;
const SM_GM = Math.exp(SM_MS.reduce((a, v) => a + Math.log(v), 0) / SM_MS.length);
/** SPREAD 0..1 → exponent on each oscillator's ratio to the group's geometric mean (0.25 .. 1 .. 2.5). */
const spreadExp = (v) => { v = Math.min(Math.max(v, 0), 1); return v < 0.5 ? 0.25 + 1.5 * v : 1 + 3 * (v - 0.5); };

class Biquad {
  constructor() { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
}

function highpass(st, x, k, q) {
  const k2 = k * k;
  const d = 1 + k / q + k2;
  const inv = 1 / d;
  const a1n = (k2 - 1) * -2 / d;
  const a2 = (1 - k / q + k2) / d;
  const y = inv * x - 2 * inv * st.x1 + inv * st.x2 + a1n * st.y1 - a2 * st.y2;
  st.x2 = st.x1; st.x1 = x; st.y2 = st.y1; st.y1 = y;
  return y;
}

/**
 * @typedef {object} MetalKnobs
 * @property {number} duty    DUTY 0..1
 * @property {number} volt    VOLT 0..1
 * @property {number} cbPw    CB_PW 0..1
 * @property {number} cbTune  CB_TUNE 0..1
 * @property {number} cbO1    CB_O1 0..1
 * @property {number} cbO2    CB_O2 0..1
 * @property {boolean} cbFromHats  CB_SW: take the cowbell's oscillators from the metal bank
 * @property {number} [spread] SPREAD 0..1 (0.5 = as built): pulls the six oscillators together or apart
 */

export class Metal {
  /** @param {number} sr  sample rate the bank runs at  @param {number} [os] oversampling factor included in sr */
  constructor(sr, os = 1) {
    this.sr = sr;
    this.kS = follow(0.0303030303, os);
    // fixed filter coefficients
    this.g = Math.tan(2 * Math.PI * Math.min(sr * 0.25, 3333) / sr);
    this.k1 = Math.tan(44717.42765 / (2 * sr));
    this.k2 = Math.tan(21633.00596 / (2 * sr));
    this._key = [NaN, NaN, NaN, NaN];
    this._shaped = [0, 0, 0, 0];
    this.dutyS = 0.5; this.voltS = 0.5; this.pwS = 0.5; this.tuneS = 0.5;
    this.osc = Array.from({ length: 6 }, () => new Pulse());
    this.cb = [new Pulse(), new Pulse()];
    this.lpS = 0;
    this.hp1 = new Biquad();
    this.hp2 = new Biquad();
    this.low = new Float64Array(6);
    this.periods = SM_MS.slice(); this._spread = 0.5;
    /** last output; reused every tick to avoid allocation */
    this.out = { raw: 0, hi: 0, lo: 0, cb1: 0, cb2: 0 };
  }

  /** @param {MetalKnobs} k  @returns {{hi:number, lo:number, cb1:number, cb2:number}} */
  tick(k) {
    const sr = this.sr;
    const ms = sr * 0.001;
    const sp = k.spread ?? 0.5;
    if (sp !== this._spread) {
      this._spread = sp;
      const e = spreadExp(sp);
      for (let i = 0; i < 6; i++) this.periods[i] = e === 1 ? SM_MS[i] : SM_GM * (SM_MS[i] / SM_GM) ** e;
    }
    this.dutyS += (k.duty - this.dutyS) * this.kS;
    this.voltS += (k.volt - this.voltS) * this.kS;
    this.pwS += (k.cbPw - this.pwS) * this.kS;
    this.tuneS += (k.cbTune - this.tuneS) * this.kS;
    // knob curves, recomputed only while a knob is moving
    const key = this._key, sh = this._shaped;
    if (key[0] !== this.dutyS) { key[0] = this.dutyS; sh[0] = sgnpow(shape(this.dutyS, HH_POW), 0.6) * 0.4 + 0.2; }
    if (key[1] !== this.pwS) { key[1] = this.pwS; sh[1] = sgnpow(shape(this.pwS, HH_POW), 0.6) * 0.4 + 0.2; }
    if (key[2] !== this.voltS) { key[2] = this.voltS; sh[2] = 1.5 - shape(this.voltS, HH_POW); }
    if (key[3] !== this.tuneS) { key[3] = this.tuneS; sh[3] = 1.5 - shape(this.tuneS, HH_POW); }
    const duty = sh[0], cbDuty = sh[1], voltF = sh[2], tuneF = sh[3];

    const low = this.low;
    let sum = 0;
    for (let i = 0; i < 6; i++) {
      const f = this.osc[i].step(ms * this.periods[i] * voltF, duty);
      low[i] = 1 - f;
      sum += low[i];
    }
    const m = 0.5 * sum;

    // one-pole low-pass, then two high-passes
    const g = this.g;
    const v = (g * m + this.lpS) / (1 + g);
    this.lpS = v + g * (m - v);
    const hi = highpass(this.hp1, v, this.k1, 3.33);
    const lo = highpass(this.hp2, v, this.k2, 3.22);

    // cowbell oscillators (or two of the metal ones with SOURCE = HH)
    const f1 = this.cb[0].step(ms * (CB_HZ[0] / 540.54 * 1.850000024) * (1.5 - k.cbO1) * tuneF, cbDuty);
    const f2 = this.cb[1].step(ms * (CB_HZ[1] / 800.0 * 1.25) * (1.5 - k.cbO2) * tuneF, cbDuty);
    const c1 = k.cbFromHats ? low[4] : f1;
    const c2 = k.cbFromHats ? low[5] : f2;
    const o = this.out;
    o.raw = m; o.hi = hi; o.lo = lo; o.cb1 = (c1 - 0.5) * 2; o.cb2 = (c2 - 0.5) * 2;
    return o;
  }
}
