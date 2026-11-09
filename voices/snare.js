// Snare drum (port of app/src/sd.rs). Two rotating resonators (170/334 Hz, or
// 255/489 Hz with the MODEL switch) plus a noise path through a state-variable filter.

import { sgnpow, histLen, XorShift64 } from './dsp.js';

/**
 * @typedef {object} SnareKnobs
 * @property {number} tone    SD_TONE
 * @property {number} snappy  SD_SNAPPY
 * @property {number} decay   SD_DECAY
 * @property {number} ndec    SD_NDEC
 * @property {boolean} modelHi  SD_SW > 0.5
 * @property {number} color   hidden SD_COLOR, default 0.25
 */

export const SNARE_DEFAULT_KNOBS = Object.freeze({
  tone: 0.5, snappy: 0.5, decay: 0.5, ndec: 0.5, modelHi: true, color: 0.25,
});

export class Snare {
  constructor(sr) {
    this.sr = sr;
    this.co = null;
    this.model = true;
    this.balS = 0.5; this.pitchS = 0.5;
    this.gateLeft = 0; this.velIn = 0; this.vel = 0; this.prevTa = 0; this.g = 0;
    this.hist = new Float64Array(histLen(sr));
    this.histPos = 0;
    this.envN = 0; this.e2 = 0; this.prevGv = 0;
    this.p2 = 0; this.p3 = 0;
    this.ic1 = 0; this.ic2 = 0;
    this.nLp = 0; this.prevGv2 = 0;
    this.e0 = 0; this.e1 = 0;
    this.aA = 0; this.bA = 0; this.aB = 0; this.bB = 0;
    this.lpOut = 0;
    this.noise = new XorShift64(0x9E3779B97F4A7C15n);
    this.prepare(SNARE_DEFAULT_KNOBS);
  }

  /** Block-rate coefficients; call when the knobs change (once per block is fine). */
  prepare(k) {
    const sr = this.sr;
    const snapG = sgnpow(k.snappy, 1.2);
    const pN = (k.snappy - 0.5) * 2 * -0.1 + 2.5;
    const ndecP = pN !== 1 ? sgnpow(k.ndec, pN) : k.ndec;
    const nT = ndecP * 3.111 + 0.555;
    const cN1 = Math.exp(-1 / (0.0288 * nT * sr));
    const c10ms = Math.exp(-1 / (0.01 * sr));
    const colorK = k.color * 0.4 + 0.8;
    const cN2 = Math.exp(-1 / ((k.snappy * 0.1 + 0.133) * sr * nT));
    const kq = 1 / ((2 - colorK) * 0.7);
    const g = Math.tan(3015 * colorK * Math.PI / sr);
    const invSr = 1 / sr;
    const alpha = invSr / (invSr + 1.034817575e-4);
    const dec1 = sgnpow(k.decay, 1.1);
    const dec4 = sgnpow(k.decay, 4.0);
    const td = (0.07 + 1.666 * dec4) * sr;
    let r1 = 1, r2 = 1;
    if (td !== 0) { r1 = Math.exp(-4.5 / td); r2 = Math.exp(-3 / td); }
    const toneP = sgnpow(k.tone, 1.2);
    const toneT = toneP * 0.8 + 0.1;
    this.co = {
      cN1, c10ms, cN2, colorK, g,
      negGk: -(kq + g),
      denom: g * g + kq * g + 1,
      alpha,
      r1: Math.min(r1, 0.999999),
      r2: Math.min(r2, 0.999999),
      dampA: 3 - 2.112 * dec1,
      dampB: 3 - 2.667 * dec1,
      toneT,
      toneR: 1 - toneT,
      snapK: snapG * 1.222,
      e2Mix: k.snappy * 0.0001 + 0.0005,
    };
    this.model = !!k.modelHi;
  }

  /** velocity: 1 for a hit, 2 accented. */
  trigger(velocity) {
    this.gateLeft = Math.max(1, Math.round(0.001 * this.sr));
    this.velIn = velocity;
  }

  /** One sample. bal = SD_BAL (TILT), pitch = SD_PITCH. */
  tick(bal, pitch) {
    const sr = this.sr;
    const nz5 = this.noise.next() * 5;
    let ta = 0;
    if (this.gateLeft > 0) { this.gateLeft -= 1; ta = 1; }
    const m = this.model;

    this.balS += (bal - this.balS) * 0.0303030303;
    const balP = sgnpow(this.balS, 1.05);
    const fa = m ? 170 : 255;
    const fb = m ? 334 : 489;
    const freqA = (1.25 - 0.5 * balP) * fa;
    const freqB = (this.balS * 0.67 + 0.66) * fb;
    this.pitchS += (pitch - this.pitchS) * 0.0303030303;
    const pm = this.pitchS * 1.333 + 0.333 + 0.033;

    const delayed = this.hist[this.histPos];
    if (delayed + ta !== 0) this.g = ta;
    if (ta > 0 && this.prevTa <= 0) this.vel = this.velIn;
    this.prevTa = ta;
    const gv = this.g * this.vel * 1.2;

    const c = this.co;
    const gvt = 0.1 < gv ? gv : 0;
    const coef = this.envN < gvt ? c.c10ms : c.cN1;
    this.e2 = gv > 0.1 && this.prevGv <= 0.1 ? gv : this.e2 * c.cN2;
    this.prevGv = gv;
    this.envN += (gvt - this.envN) * (1 - coef);
    const x = this.e2 * c.e2Mix + this.envN;
    this.p2 += (x - this.p2) * (x > this.p2 ? 0.0833333333333 : 1);
    const hp = c.denom !== 0
      ? ((Math.max(nz5, 0) - 0.0563) * this.p2 * c.snapK + c.negGk * this.ic1 - this.ic2) / c.denom
      : 0;
    this.p3 += (gv - this.p3) * (gv > this.p3 ? 1 : 0.0151515151515);
    const wa = (freqA * pm + this.p3 * 80) * 2 * Math.PI / sr;
    const wb = (freqB * pm + this.p3 * 80) * 2 * Math.PI / sr;
    const v1 = c.g * hp + this.ic1;
    const v2 = c.g * v1 + this.ic2;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;

    // excitation from the trigger's edges
    const d = gv - this.prevGv2;
    this.prevGv2 = gv;
    this.e0 += (d - this.e0) * (this.e0 < d ? 0.5 : 1);
    this.e1 += (d - this.e1) * (this.e1 < d ? 1 : 0.5);
    const esel = d > 0 ? this.e0 : this.e1;
    const xexc = gv * 0.1 + esel;

    const sa = Math.sin(wa), ca = Math.cos(wa);
    const ya = c.r1 * (this.bA * ca + this.aA * sa) - xexc;
    this.nLp += (hp - this.nLp) * c.alpha;
    const tabA = m ? -0.000199999994947575 : -0.000399999989895150;
    const ya2 = ya + ya * tabA * c.dampA;
    const oscA = (ya2 * 0.2 + xexc * -0.2) * c.toneR;
    const nOut = this.nLp * 20 * c.colorK;

    const sb = Math.sin(wb), cb = Math.cos(wb);
    const click = gv * 0.12;
    const yb = c.r2 * (this.bB * cb - this.aB * sb) + click;
    const aA2 = c.r1 * (this.aA * ca - this.bA * sa);
    const aB2 = c.r2 * (this.aB * cb + this.bB * sb);
    const tabB = m ? -0.001500000013038516 : -0.001200000010430813;
    const yb2 = yb + tabB * yb * c.dampB;
    const t = (yb2 * -0.3 + click * -0.2) * c.toneT + oscA;
    this.lpOut += (t - this.lpOut) * c.alpha;
    const out = this.lpOut * 6 + click * -7 + nOut;

    this.bA = ya2; this.bB = yb2; this.aA = aA2; this.aB = aB2;
    this.hist[this.histPos] = ta;
    this.histPos = (this.histPos + 1) % this.hist.length;
    return out;
  }
}
