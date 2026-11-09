// Low, mid and high tom / conga (port of app/src/tom.rs). One design, three sets of constants.

import { histLen, XorShift64, follow } from './dsp.js';

/**
 * @typedef {object} TomSpec
 * @property {number} tomHz     base pitch in tom mode (Hz)
 * @property {number} congaHz   base pitch in conga mode (Hz)
 * @property {number} envHz     pitch envelope depth
 * @property {number} yMul      resonator output into the saturator
 * @property {number} flagAdd   envelope offset added to the switch flag
 * @property {number[]} qTab    Q scale [conga, tom]
 * @property {number[]} bTab    band-pass gain [conga, tom]
 * @property {number} satGain   saturator output gain
 * @property {number} nenvA     noise-envelope time: dec·a + b ms
 * @property {number} nenvB
 * @property {number} nenvScale
 * @property {number} hpHz      noise high-pass (×(flt+0.5))
 * @property {number} lpHz      noise low-pass (×(flt+0.5))
 */

/** @type {TomSpec} */
export const LOW = Object.freeze({
  tomHz: 95, congaHz: 185, envHz: 20, yMul: 0.8, flagAdd: 0.33,
  qTab: [1.1, 0.6], bTab: [1.5, 2.0], satGain: 2.3,
  nenvA: 150, nenvB: 100, nenvScale: 0.666, hpHz: 120, lpHz: 280,
});
/** @type {TomSpec} */
export const MID = Object.freeze({
  tomHz: 130, congaHz: 269, envHz: 30, yMul: 0.5, flagAdd: 0.33,
  qTab: [1.0, 0.733], bTab: [1.6, 2.5], satGain: 2.5,
  nenvA: 110, nenvB: 90, nenvScale: 0.666, hpHz: 140, lpHz: 300,
});
/** @type {TomSpec} */
export const HIGH = Object.freeze({
  tomHz: 180, congaHz: 400, envHz: 20, yMul: 0.4, flagAdd: 0.66,
  qTab: [1.4, 0.733], bTab: [1.5, 2.6], satGain: 2.5,
  nenvA: 90, nenvB: 90, nenvScale: 0.555, hpHz: 160, lpHz: 330,
});

export class Tom {
  /**
   * @param {TomSpec} spec  @param {number} sr sample rate the voice runs at
   * @param {number|bigint} seed noise seed  @param {number} [os] oversampling factor included in sr
   */
  constructor(spec, sr, seed, os = 1) {
    this.spec = spec;
    this.sr = sr;
    this.k02 = follow(0.02, os);
    this.kGvUp = follow(0.0909090909091, os);
    this.kGvDn = follow(0.0151515151515, os);
    // white noise has 1/os of its power in the audible band when oversampled
    this.noiseGain = Math.sqrt(os);
    this._fKey = NaN;
    this.tomMode = true;
    this.flag = 1;
    this.tuneS = 0.5; this.decS = 0.5; this.atkS = 0.5; this.fltS = 0.5;
    this.gateLeft = 0; this.velIn = 0; this.vel = 0; this.prevTa = 0; this.g = 0;
    this.hist = new Float64Array(histLen(sr));
    this.histPos = 0;
    this.prevGv = 0; this.vl = 0;
    this.eEdge = 0; this.eGv = 0;
    this.f0 = 0; this.f1 = 0; this.h = 0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
    this.p = 0; this.p2 = 0; this.dc = 0;
    this.hpN = 0; this.nPrev = 0; this.lpN = 0;
    this.noise = new XorShift64(BigInt(seed) | 1n);
  }

  /** velocity: 1 for a hit, 2 accented. tomMode: the TOM/CONGA switch (true = tom). */
  trigger(velocity, tomMode) {
    this.gateLeft = Math.max(1, Math.round(0.001 * this.sr));
    this.velIn = velocity;
    this.tomMode = tomMode;
  }

  /** One sample. Knobs 0..1: xT_TUNE, xT_DEC, xT_ATK (REV), xT_FLT. */
  tick(tune, dec, atk, flt) {
    const sp = this.spec;
    const sr = this.sr;
    const r = sr / 48000;
    const ms = sr * 0.001;
    const noise = this.noise.next() * this.noiseGain;
    let ta = 0;
    if (this.gateLeft > 0) { this.gateLeft -= 1; ta = 1; }

    this.tuneS += (tune - this.tuneS) * this.k02;
    this.decS += (dec - this.decS) * this.k02;
    this.atkS += (atk - this.atkS) * this.k02;
    const nAmt = this.atkS * noise;
    this.fltS += (flt - this.fltS) * this.k02;
    const fltH = this.fltS + 0.5;

    if (ta !== 0) this.flag = this.tomMode ? 1 : 0;
    const tom = this.flag !== 0;
    const base = tom ? sp.tomHz : sp.congaHz;

    const delayed = this.hist[this.histPos];
    if (delayed + ta !== 0) this.g = ta;
    if (ta > 0 && this.prevTa <= 0) this.vel = this.velIn;
    this.prevTa = ta;
    const gv = this.g * this.vel;

    const tuneMul = this.tuneS * 0.5 + 0.75;
    const drive = this.tuneS * -0.3 + 1.2;
    const q0 = this.decS * 50 + 10;

    const d = gv - this.prevGv;
    this.prevGv = gv;
    const edge = 0.01 <= d ? 1 : 0;
    if (d >= 0.01) this.vl = gv;
    const vl = this.vl;
    const aK = ((vl - 0.25) * (4 / 3)) * -0.445 + 1.333;

    // excitation envelopes
    const a6 = 6 * r, b4 = 4 * r;
    const rel0 = a6 > 1 ? 1 / a6 : 1;
    const rel1 = b4 > 1 ? 1 / b4 : 1;
    this.eEdge += (edge - this.eEdge) * (this.eEdge < edge ? 1 : rel1);
    this.eGv += (gv - this.eGv) * (this.eGv < gv ? this.kGvUp : this.kGvDn);
    const t0 = Math.max(Math.abs(aK * r * 300), 1);
    const t1 = Math.max(Math.abs(aK * r * 300 * 10), 1);
    this.f0 += (edge - this.f0) * (this.f0 < edge ? 1 : 1 / t0);
    this.f1 += (edge - this.f1) * (this.f1 < edge ? 1 : 1 / t1);
    const target = this.f0 * 0.8 + this.f1 * 0.2;
    this.h += (target - this.h) * (this.h < target ? rel0 : 1);

    // band-pass "ring"
    const w = (this.h * sp.envHz * vl + base * tuneMul) * 6.283 / sr;
    const idx = tom ? 1 : 0;
    const q = q0 * sp.qTab[idx];
    const s = Math.sin(w), c = Math.cos(w);
    const alpha = q !== 0 ? s * 0.5 / q : 0;
    const a0inv = alpha + 1 !== 0 ? 1 / (1 + alpha) : 0;
    const b = q * alpha * sp.bTab[idx] * a0inv;
    const x = vl * this.eEdge * 20;
    const y = b * x - b * this.x2 + 2 * c * a0inv * this.y1 - (1 - alpha) * a0inv * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    const satIn = drive * (y * sp.yMul + this.eGv * (this.flag + sp.flagAdd)) * 0.333;
    const th = Math.tanh(Math.sinh(satIn));
    const body = th * sp.satGain;

    // noise layer (tom mode only)
    const tn = (this.decS * sp.nenvA + sp.nenvB) * ms;
    this.p += (gv - this.p) * (gv > this.p ? 1 : 1 / Math.max(Math.abs(tn), 1));
    const tn2 = Math.max(Math.abs(tn * 0.01), 1);
    this.p2 += (this.p - this.p2) * (this.p > this.p2 ? 1 / tn2 : 1);
    const nEnv = this.p2 * sp.nenvScale;
    if (fltH !== this._fKey) {
      this._fKey = fltH;
      this._g1 = Math.tan(fltH * sp.hpHz * Math.PI / sr);
      this._g2 = Math.tan(fltH * sp.lpHz * Math.PI / sr);
    }
    const g1 = this._g1, g2 = this._g2;
    const inv1 = 1 / (1 + g1);
    const inv2 = 1 / (1 + g2);
    const n = tom ? nAmt * nEnv : 0;
    this.dc += 0.002 * (th - this.dc);
    this.hpN = (1 - g1) * inv1 * this.hpN + n * inv1 - this.nPrev * inv1;
    this.nPrev = n;
    this.lpN = (1 - g2) * inv2 * this.lpN + g2 * inv2 * this.hpN;

    this.hist[this.histPos] = ta;
    this.histPos = (this.histPos + 1) % this.hist.length;
    return (body + this.lpN) * 5;
  }
}
