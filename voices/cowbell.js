// Cowbell (port of app/src/cb.rs). Takes the two cowbell oscillators from the metal bank (metal.js).

import { sgnpow, histLen } from './dsp.js';

export class Cowbell {
  constructor(sr) {
    this.sr = sr;
    this.gateLeft = 0; this.velIn = 0; this.accVel = 0;
    this.lvlS = 0; this.decS = 0.5;
    this.hist = new Float64Array(histLen(sr));
    this.histPos = 0;
    this.g = 0; this.f = 0; this.h = 0; this.p = 0;
    this.x1p = 0; this.y1 = 0; this.x2p = 0; this.y2 = 0;
    this.ic1 = 0; this.ic2 = 0;
    this.hpPrev = 0; this.z1 = 0; this.z1lPrev = 0; this.z2 = 0; this.w = 0; this.dc = 0;
  }

  /** velocity: 1 for a hit, 2 accented. */
  trigger(velocity) {
    this.gateLeft = Math.max(1, Math.round(0.001 * this.sr));
    this.velIn = velocity;
  }

  /** cb1, cb2: the cowbell oscillators (±1) from Metal.tick(). vol = CB_VOL, dec = CB_DEC. */
  tick(cb1, cb2, vol, dec) {
    const sr = this.sr;
    const ms = sr * 0.001;
    const rad = 2 * Math.PI / sr;
    const r500 = 1 / (1 + 500 * rad);
    const g = Math.tan(2706.778789 / sr);
    const kq = 0.1846023136;
    const denom = 1 + kq * g + g * g;
    const invA = 1 / (1 + 328.8 * rad);
    const invB = 1 / (1 + 19.4 * rad);
    const invSr = 1 / sr;
    const alpha = invSr / (1.034817577e-4 + invSr);
    const relF = Math.abs(6.33 * ms) > 1 ? 1 / (6.33 * ms) : 1;
    const attP = Math.abs(0.5 * ms) > 1 ? 1 / (0.5 * ms) : 1;

    let gate = 0;
    if (this.gateLeft > 0) { this.gateLeft -= 1; gate = 1; }
    if (gate !== 0) this.accVel = this.velIn;
    this.lvlS += (vol - this.lvlS) * 0.0151515151515;
    this.decS += (dec - this.decS) * 0.0151515151515;
    const d9 = this.decS * 0.9;
    const e = d9 * -0.666 + 0.999;

    const delayed = this.hist[this.histPos];
    if (delayed + gate !== 0) this.g = gate;
    this.hist[this.histPos] = gate;
    this.histPos = (this.histPos + 1) % this.hist.length;
    const g_ = this.g;

    this.f += (g_ - this.f) * (this.f < g_ ? 1 : relF);
    const fp = e !== 1 ? sgnpow(this.f, e) : this.f;
    const dfac = sgnpow(d9, 2.5) * 3 + 0.33;
    const acc = (this.accVel - 0.25) * (4 / 3);
    const aEnv = acc * 0.467 + 0.333;
    const relH = Math.max(Math.abs(ms * dfac * (acc * 5 + 10)), 1);
    this.h += (g_ - this.h) * (g_ > this.h ? 1 : 1 / relH);
    const e2 = e * 0.1;
    const hp_ = e2 !== 1 ? sgnpow(this.h, e2) : this.h;
    const target = fp * aEnv + (acc * 0.5 + 0.5) * hp_ * 0.1333;
    this.p += (target - this.p) * (this.p < target ? attP : 1);
    const amp = this.p * 0.666;

    // the two oscillators, each half-wave rectified and DC-blocked at 500 Hz
    const x1 = (Math.max(cb2, 0) - 0.25) * amp;
    const x2 = (Math.max(cb1, 0) - 0.25) * amp;
    this.y1 = r500 * (this.y1 + x1 - this.x1p);
    this.y2 = r500 * (this.y2 + x2 - this.x2p);
    this.x1p = x1;
    this.x2p = x2;

    // resonant filter (≈862 Hz, Q≈5.4), high-pass output
    const hp = denom !== 0 ? ((this.y1 + this.y2) * 0.5 - (kq + g) * this.ic1 - this.ic2) / denom : 0;
    const v1 = g * hp + this.ic1;
    const v2 = g * v1 + this.ic2;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;

    // DC blockers, level, RC low-pass, output
    const x = -hp;
    this.z1 = (this.z1 + x - this.hpPrev) * invB;
    this.hpPrev = x;
    const zl = this.lvlS * this.z1;
    this.z2 = (this.z2 + zl - this.z1lPrev) * invA;
    this.z1lPrev = zl;
    this.w += (-this.z2 - this.w) * alpha;
    const o = this.w - this.dc;
    this.dc += 0.002 * o;
    return o * -20;
  }
}
