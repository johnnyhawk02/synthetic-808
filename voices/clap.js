// Hand clap / maracas (port of the clap block inside app/src/synth.rs).
// Noise bursts through band-pass and high-pass filters, plus a modal "room" of 11 resonators.

import { XorShift32 } from './dsp.js';

export const CLAP_MODES_HZ = [
  2498.0, 489.0, 709.25, 9992.5, 8692.5, 1530.0, 1382.3, 9672.96, 6383.25, 2252.86, 245.24,
];

const coef = (tSec, sr) => Math.exp(-1 / (Math.max(tSec, 1e-4) * sr));

/** Trapezoidal state-variable filter; run() returns band-pass, low/high in lp/hp. */
class Svf {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.g = 0; this.k = 0; this.lp = 0; this.bp = 0; this.hp = 0; }
  set(hz, q, sr) {
    hz = Math.min(Math.max(hz, 10), sr * 0.45);
    this.g = Math.tan(Math.PI * hz / sr);
    this.k = 1 / Math.max(q, 0.3);
  }
  run(x) {
    const g = this.g, k = this.k;
    const a1 = 1 / (1 + g * (g + k));
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + g * a1 * v3;
    const v2 = this.ic2 + g * v1;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2; this.bp = v1; this.hp = x - k * v1 - v2;
    return v1;
  }
}

/**
 * @typedef {object} ClapKnobs
 * @property {boolean} maracas  HC_SW > 0.5
 * @property {number} offset    HC_OFFSET (burst spacing)
 * @property {number} clps      HC_CLPS (burst count)
 * @property {number} dec       HC_DEC
 * @property {number} tail      HC_TAIL
 * @property {number} rev       HC_REV
 * @property {number} flt       HC_FLT (reverb low-pass)
 */

export class Clap {
  constructor(sr, seed = 0x12345678) {
    this.sr = sr;
    this.noise = new XorShift32(seed);
    this.burstEnv = 0; this.body = 0; this.tail = 0;
    this.burstsLeft = 0; this.burstGap = 0; this.nextBurst = 0;
    this.burstC = 0; this.bodyC = 0; this.tailC = 0;
    this.tailAmt = 0; this.revAmt = 0;
    this.maracas = false;
    this.bp = new Svf(); this.hp = new Svf();
    this.modes = CLAP_MODES_HZ.map((f) => { const s = new Svf(); s.set(f, 18, sr); return s; });
    this.rlp = 0; this.rlpC = 0;
  }

  /** @param {ClapKnobs} k */
  trigger(k) {
    const sr = this.sr;
    this.maracas = !!k.maracas;
    if (this.maracas) {
      this.hp.set(5000, 0.7, sr);
      this.bodyC = coef(0.008 + k.dec * 0.06, sr);
      this.burstC = coef(0.002 + k.offset * 0.01, sr);
      this.burstsLeft = 0;
      this.burstEnv = 0;
      this.body = 1;
      this.tail = 0;
    } else {
      this.bp.set(1000, 2.2, sr);
      this.hp.set(600, 0.7, sr);
      this.burstGap = (0.004 + k.offset * 0.014) * sr;
      this.burstsLeft = 2 + Math.round(k.clps * 4);
      this.nextBurst = 0;
      this.burstC = coef(0.0035, sr);
      this.bodyC = coef(0.015 + k.dec * 0.15, sr);
      this.tailC = coef(0.06 + k.tail * 0.5, sr);
      this.tailAmt = k.tail;
      this.body = 0;
      this.tail = 0;
    }
    this.revAmt = k.rev;
    const fc = 800 + k.flt * k.flt * 12000;
    this.rlpC = 1 - Math.exp(-2 * Math.PI * fc / sr);
  }

  tick() {
    const n = this.noise.next();
    if (this.maracas) {
      if (this.body > 1e-5) {
        this.hp.run(n);
        const out = this.hp.hp * this.body * 0.9;
        this.body *= this.bodyC;
        return out;
      }
      return 0;
    }
    if (!(this.burstsLeft > 0 || this.body > 1e-5 || this.tail > 1e-5 || this.burstEnv > 1e-5)) return 0;
    if (this.burstsLeft > 0) {
      if (this.nextBurst <= 0) {
        this.burstEnv = 1;
        this.burstsLeft -= 1;
        this.nextBurst = this.burstGap;
        if (this.burstsLeft === 0) { this.body = 1; this.tail = this.tailAmt; }
      }
      this.nextBurst -= 1;
    }
    const bp = this.bp.run(n);
    this.hp.run(bp);
    const env = this.burstEnv + this.body * 0.8 + this.tail * 0.35;
    const dry = this.hp.hp * env * 1.6;
    // modal "room" ringing driven by the clap
    let wet = 0;
    for (let i = 0; i < this.modes.length; i++) wet += this.modes[i].run(dry * 0.15);
    this.rlp += this.rlpC * (wet - this.rlp);
    const out = dry + this.rlp * this.revAmt * 1.2;
    this.burstEnv *= this.burstC;
    this.body *= this.bodyC;
    this.tail *= this.tailC;
    return out;
  }
}
