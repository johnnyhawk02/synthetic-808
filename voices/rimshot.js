// Rim shot / claves (port of app/src/rs.rs).

import { sgnpow, histLen, follow } from './dsp.js';

/**
 * @typedef {object} RimKnobs
 * @property {number} tune  RS_TUNE
 * @property {number} dec   RS_DEC
 * @property {number} osc1  RS_OSC1
 * @property {number} osc2  RS_OSC2
 * @property {number} flt   RS_FLT (TONE)
 * @property {number} res   RS_RES
 */

export class RimShot {
  /** @param {number} sr  sample rate the voice runs at  @param {number} [os] oversampling factor included in sr */
  constructor(sr, os = 1) {
    this.sr = sr;
    this.os = os;
    this.k005 = follow(0.005, os);
    this.kClvDn = follow(0.25, os);
    this.kRimDn = follow(0.1111111111, os);
    this.kQ2Up = follow(0.2, os);
    this.kQ2Dn = follow(0.3333333333333333, os);
    this.kDc = follow(0.002, os);
    this._fKey = NaN; this._rKey = NaN; this._hc = {};
    this._dKey = NaN; this._rc = { tm: NaN };
    this.rimMode = true;
    this.gateLeft = 0; this.velIn = 0; this.v = 0;
    this.oscS = [1, 1]; // (osc2, osc1) level smoothing
    this.decS = 0.5; this.tuneS = 0.5;
    this.p = [0, 0]; // trigger followers (claves, rim)
    this.bx1 = 0; this.bx2 = 0; this.by1 = 0; this.by2 = 0; // claves band-pass
    this.y1 = [0, 0]; this.y2 = [0, 0]; this.xprev = [0, 0]; // rim resonator pair
    this.hist = new Float64Array(histLen(sr, 1.333));
    this.histPos = 0;
    this.latched = 0; this.penv = 0;
    this.q2 = 0; this.q2prev = 0;
    this.c1 = 0; this.c2 = 0; this.h1 = 0; this.h2 = 0; // tone high-pass
    this.dc = 0;
  }

  /** velocity: 1 for a hit, 2 accented. rimMode: true = rim shot, false = claves. */
  trigger(velocity, rimMode) {
    this.gateLeft = Math.max(1, Math.round(0.001 * this.sr));
    this.velIn = velocity;
    this.rimMode = rimMode;
  }

  /** @param {RimKnobs} k */
  tick(k) {
    const sr = this.sr;
    const rad = 6.283 / sr;
    let gate = 0;
    if (this.gateLeft > 0) { this.gateLeft -= 1; gate = 1; }
    if (gate !== 0) this.v = this.velIn;

    // tone high-pass (RBJ) from FLT and RES, recomputed only when they change
    if (k.flt !== this._fKey || k.res !== this._rKey) {
      this._fKey = k.flt; this._rKey = k.res;
      const w8 = ((k.flt * 2) * 110 + 470) * 6.283 / sr;
      const q2x = ((k.res * 2) * 1.872281 + 1) * 2;
      const alpha = q2x !== 0 ? Math.sin(w8) / q2x : 0;
      const a0 = 1 + alpha;
      const cw = Math.cos(w8);
      const hc = this._hc;
      hc.hb0 = (cw + 1) / (2 * a0);
      hc.hb1 = -(cw + 1) / a0;
      hc.ha1n = 2 * cw / a0;
      hc.ha2n = -(1 - alpha) / a0;
    }
    const { hb0, hb1, ha1n, ha2n } = this._hc;
    const hb2 = hb0;

    // smoothed knobs
    this.oscS[0] += (k.osc2 * 0.5 + 0.75 - this.oscS[0]) * this.k005;
    this.oscS[1] += (k.osc1 * 0.5 + 0.75 - this.oscS[1]) * this.k005;
    this.decS += (k.dec - this.decS) * this.k005;
    const d = this.decS;
    if (d !== this._dKey) {
      this._dKey = d;
      this._k1 = (sgnpow(d, 1.66) * 2.3 + 0.2) * 18;
      this._k2 = (d * d * 2.65 + 0.15) * 8;
      this._kz = (sgnpow(d, 2.22) * 200 + 22) * 1.2;
      this._rel = Math.max(Math.abs(sgnpow(d, 3.33) * 945 + 166) * this.os, 1);
    }
    const k1 = this._k1, k2 = this._k2, kz = this._kz;
    const acc = ((this.v - 0.25) * 4 / 3) * 0.7 + 0.3;
    this.tuneS += (k.tune - this.tuneS) * this.k005;
    const tm = this.tuneS * 0.667 + 0.666;

    const f2 = 1786.386963;
    const fOsc2 = f2 * tm * this.oscS[0];
    const f1 = 452.5100098;
    const fOsc1 = this.oscS[1] * f1 * tm;
    const trigClv = this.rimMode ? 0 : gate;
    const trigRim = this.rimMode ? gate : 0;

    // claves: band-pass ring at (1786+740)·tm Hz
    // resonator coefficients, recomputed only while TUNE, DEC or the OSC levels move
    const rc = this._rc;
    if (tm !== rc.tm || kz !== rc.kz || this.oscS[0] !== rc.o0 || this.oscS[1] !== rc.o1) {
      rc.tm = tm; rc.kz = kz; rc.o0 = this.oscS[0]; rc.o1 = this.oscS[1];
      const w2 = (f2 + 740) * tm * rad;
      const s2 = Math.sin(w2);
      rc.c2 = Math.cos(w2);
      rc.alpha2 = kz !== 0 ? s2 / kz : 0;
      rc.inv2 = 1 / (1 + rc.alpha2);
      rc.b = kz * rc.alpha2 * rc.inv2;
      rc.rb = k2 !== 0 ? Math.exp(-fOsc1 / k2 * rad) : 1;
      rc.cb = Math.cos(fOsc1 * rad);
      rc.ra = k1 !== 0 ? Math.exp(-fOsc2 / k1 * rad) : 1;
      rc.ca = Math.cos(fOsc2 * rad);
    }
    const { c2, alpha2, inv2, b } = rc;

    this.p[0] += (trigClv - this.p[0]) * (this.p[0] < trigClv ? 1 : this.kClvDn);
    this.p[1] += (trigRim - this.p[1]) * (this.p[1] < trigRim ? 1 : this.kRimDn);
    const x = this.v * this.p[0];
    const y = b * x - b * this.bx2 + 2 * c2 * inv2 * this.by1 - (1 - alpha2) * inv2 * this.by2;
    this.bx2 = this.bx1; this.bx1 = x; this.by2 = this.by1; this.by1 = y;
    const clv = 0.9 * (Math.tanh(1.2 * y) + 1.2 * y * 0.6);

    // rim: two decaying resonators, impulse-invariant
    const { rb, cb, ra, ca } = rc;
    // lane 0: osc1 resonator, lane 1: osc2 resonator
    const xin0 = this.p[1], xin1 = 3 * this.p[1];
    const yn0 = 2 * rb * cb * this.y1[0] - rb * rb * this.y2[0] + (1 - rb) * (xin0 - rb * this.xprev[0]);
    const yn1 = 2 * ra * ca * this.y1[1] - ra * ra * this.y2[1] + (1 - ra) * (xin1 - ra * this.xprev[1]);
    this.y2[0] = this.y1[0]; this.y2[1] = this.y1[1];
    this.y1[0] = yn0; this.y1[1] = yn1;
    this.xprev[0] = xin0; this.xprev[1] = xin1;
    const diff = Math.min(Math.max(1.5 * yn0 - 2.5 * yn1, -0.02), 0.02);

    // rim envelope (attack 1.25 ms, release 945·dec^3.33 + 166 samples)
    const delayed = this.hist[this.histPos];
    if (delayed + trigRim !== 0) this.latched = trigRim;
    this.hist[this.histPos] = trigRim;
    this.histPos = (this.histPos + 1) % this.hist.length;
    const rel = this._rel;
    const att = Math.max(Math.abs(1.25 * sr * 0.001), 1);
    const div = this.penv < this.latched ? att : rel;
    this.penv += (this.latched - this.penv) / div;
    const xq = diff * this.penv * 4;
    this.q2 += (xq - this.q2) * (xq > this.q2 ? this.kQ2Up : this.kQ2Dn);
    const c = ((this.q2 - this.q2prev) * this.os + xq) * 3;
    this.q2prev = this.q2;

    // tone high-pass, soft clip, accent
    const h = hb1 * this.c1 + hb0 * c + hb2 * this.c2 + ha1n * this.h1 + ha2n * this.h2;
    this.c2 = this.c1; this.c1 = c; this.h2 = this.h1; this.h1 = h;
    const s = h * 3.33 * 2.333;
    const den = Math.abs(s) * 0.9850746269 + 1;
    const sc = den === 0 ? 0 : s * 1.985074627 / den * 1.666;
    const total = clv + acc * sc;

    const v = total - this.dc;
    this.dc += v * this.kDc;
    return 2 * v;
  }
}
