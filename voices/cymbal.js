// Cymbal (port of app/src/cymbal.rs). Reads the two high-passed metal mixes from metal.js
// (`hi` ≈7.1 kHz, `lo` ≈3.4 kHz).

import { sgnpow, histLen } from './dsp.js';

/** RBJ high-pass coefficients [b0, b1, −a1, −a2] from sin/cos and 2Q. */
function rbjHp(s, c, twoQ) {
  const alpha = s / twoQ;
  const inv = 1 / (1 + alpha);
  return [0.5 * (1 + c) * inv, -(1 + c) * inv, 2 * c * inv, -(1 - alpha) * inv];
}

class Bq {
  constructor() { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  run(x, c) {
    const y = c[0] * x + c[1] * this.x1 + c[0] * this.x2 + c[2] * this.y1 + c[3] * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/**
 * Decay range requested for the app: DEC spans 350 ms (0) to 1,200 ms (1), measured as the
 * time to fall 40 dB. Unstretched, the envelopes give 180 + 260·d − 100·d² ms, so every
 * envelope time is stretched by the ratio.
 */
export function stretchFor(dec) {
  const d = Math.min(Math.max(dec, 0), 1);
  return (350 + 850 * d) / (180 + 260 * d - 100 * d * d);
}

export class Cymbal {
  constructor(sr) {
    this.sr = sr;
    /** stretch applied to every envelope time (1 = unstretched) */
    this.stretch = 1;
    this.gateLeft = 0; this.trigVal = 0; this.vel = 1;
    this.hist = new Float64Array(histLen(sr));
    this.histPos = 0;
    this.g = 0;
    this.toneS = 0.5; this.lvlS = 0; this.decS = 1;
    this.gs = 0; this.q = 0; this.p = 0; this.r0 = 0; this.r1 = 0;
    this.s = 0; this.t = 0; this.u = 0;
    this.hp2498 = new Bq();
    this.l489 = 0; this.hPrev = 0; this.x0 = 0; this.u2Prev = 0;
    this.hp9992 = new Bq(); this.hp8692 = new Bq();
    this.w = 0; this.y1Prev = 0; this.z220 = 0; this.mixPrev = 0; this.dc = 0; this.yvPrev = 0;
    this._sr = 0;
  }

  /** value: 1 for a hit, 2 accented. */
  trigger(value) {
    this.gateLeft = Math.max(1, Math.round(0.001 * this.sr));
    this.trigVal = value;
    this.vel = value;
  }

  _coefs() {
    // fixed filters; computed once (the Rust recomputes them every sample with the same result)
    const sr = this.sr, w = 2 * Math.PI / sr;
    let s, c;
    s = Math.sin(2498 * w); c = Math.cos(2498 * w); this.c2498 = rbjHp(s, c, 1.35);
    s = Math.sin(489 * w); c = Math.cos(489 * w); this.g489 = s / (1 + s + c);
    s = Math.sin(709.25 * w); c = Math.cos(709.25 * w); this.c709 = c / (1 + s);
    s = Math.sin(9992.5 * w); c = Math.cos(9992.5 * w); this.c9992 = rbjHp(s, c, 3.0);
    s = Math.sin(8692.5 * w); c = Math.cos(8692.5 * w); this.c8692 = rbjHp(s, c, 2.1);
    s = Math.sin(1530 * w); c = Math.cos(1530 * w); this.c1530 = c / (1 + s);
    s = Math.sin(1382.300768 / sr); c = Math.cos(1382.300768 / sr); this.c220 = c / (1 + s);
    this.dcc = 1 - 62.83185307 / sr;
    this._sr = sr;
  }

  /** hi, lo: metal mixes. vol = RC_VOL, tone = RC_TONE, dec = RC_DEC. */
  tick(hi, lo, vol, tone, dec) {
    if (this._sr !== this.sr) this._coefs();
    const { c2498, g489, c709, c9992, c8692, c1530, c220, dcc } = this;

    const lvlT = sgnpow(vol, 1.12);
    this.toneS += (tone - this.toneS) * 0.02;
    this.lvlS += (lvlT - this.lvlS) * 0.02;
    this.decS += (dec - this.decS) * 0.02;
    const d = this.decS;
    const x3 = sgnpow(d, 0.333);
    const x6 = sgnpow(d, 0.666);
    const st = this.stretch;
    const t1 = (5000 - 2000 * x3) * st;
    const t2 = (10000 + 40000 * x6) * st;
    const aMul = 0.15 * x6 + 0.75;
    const t3 = (x6 * 2222 + 3333) * st;
    const t4 = t3 * 0.15;

    // trigger
    let trig = 0;
    if (this.gateLeft > 0) { this.gateLeft -= 1; trig = this.trigVal; }
    const delayed = this.hist[this.histPos];
    if (delayed + trig !== 0) this.g = trig;
    this.hist[this.histPos] = trig;
    this.histPos = (this.histPos + 1) % this.hist.length;
    const g = this.g;
    this.gs += (g - this.gs) * (g > this.gs ? 0.1666666666667 : 0.0166666666667 / st);
    const vg = this.vel * this.gs;

    // envelopes
    const rateQ = Math.abs(t2) > 1 ? 1 / Math.abs(t2) : 1;
    this.q += (vg - this.q) * (this.q < vg ? 1 : rateQ);
    const a = aMul * this.q * 0.1;
    const rateP = Math.abs(t1) > 1 ? 1 / Math.abs(t1) : 1;
    this.p += (a * 0.35 - this.p) * rateP;
    const u1 = (this.p * -5) * (Math.tanh(1.5 - 8 * lo) - 1);

    // low band: high-pass 2498 Hz, low-pass 489 Hz
    const h = this.hp2498.run(u1, c2498);
    this.l489 = g489 * h + g489 * this.hPrev + this.l489 * (1 - g489);
    this.hPrev = h;

    const ap = sgnpow(a, 1.333) * 0.15;
    const rateR = 1 / Math.max(Math.abs(t3), 1);
    this.r0 += (vg - this.r0) * (this.r0 < vg ? 1 : 0.002732240437 / st);
    this.r1 += (vg - this.r1) * (this.r1 < vg ? 1 : rateR);
    const rp = sgnpow(this.r1, 1.333) * 0.1;
    this.s += ((this.r0 + rp) * 0.1 - this.s) * 0.25;
    const s5 = this.s * 5;
    const thHi = Math.tanh(0.5 * (16 * hi + 1.5));
    const rateT = 1 / Math.max(Math.abs(t4), 1);
    this.t += (rp - this.t) * (this.t < rp ? 1 : rateT);
    const tgt = ap + this.t;
    this.u += (tgt - this.u) * (this.u < tgt ? rateT : 1);
    const u2 = (thHi - 1) * -1 * s5;

    // high bands: 709 Hz DC-block of u2 → 9992.5 Hz high-pass; VCA'd metal → 8692.5 Hz high-pass
    this.x0 = c709 * (this.x0 + u2 - this.u2Prev);
    this.u2Prev = u2;
    const x1 = (1 - Math.tanh(9 * hi + 1.5)) * this.u * 0.22 * 5;
    const y0 = this.hp9992.run(this.x0, c9992);
    const y1 = this.hp8692.run(x1, c8692);
    this.w = (this.w + y1 - this.y1Prev) * c1530;
    this.y1Prev = y1;

    // TONE mix
    const t = this.toneS;
    const w0 = 0.2 * sgnpow(t, 0.333) + 1;
    const e = 1.222 * sgnpow(t, 1.125) + 0.5;
    const kw = 0.12 - 0.07 * sgnpow(t, 0.888);
    const m3 = sgnpow(1 - t, 1.888) * 0.1 + 0.01;
    const mix = (1.5 * y0 * w0 + 12 * this.w * kw - 6 * this.l489 * m3) * e;
    this.z220 = (this.z220 + mix - this.mixPrev) * c220;
    this.mixPrev = mix;
    const yv = this.lvlS * this.z220;
    this.dc = this.dc * dcc + yv - this.yvPrev;
    this.yvPrev = yv;
    return this.dc * -25;
  }
}
