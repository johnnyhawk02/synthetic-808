// Closed and open hi-hats (port of app/src/hats.rs). Input: the metal mix from metal.js
// (the ≈7.1 kHz high-passed `hi` output).

import { sgnpow, clamp, histLen } from './dsp.js';

class Biquad {
  constructor() { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  /** high-pass, bilinear, k = tan(w/2) */
  hp(x, k, q) {
    const k2 = k * k;
    const d = 1 + k / q + k2;
    const b0 = 1 / d;
    const b1 = -2 / d;
    const a1n = -2 * (k2 - 1) / d;
    const a2 = (1 - k / q + k2) / d;
    const y = b0 * x + b1 * this.x1 + b0 * this.x2 + a1n * this.y1 - a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class Hat {
  constructor(sr) {
    this.gateLeft = 0; this.trigVal = 0; this.vel = 1;
    this.hist = new Float64Array(histLen(sr));
    this.histPos = 0;
    this.g = 0; this.latched = 0; this.env = 0;
    this.hp = new Biquad();
    this.lpPrevIn = 0; this.lp = 0;
  }
  /** 1 ms delayed-trigger latch, as on every voice */
  gate() {
    let t = 0;
    if (this.gateLeft > 0) { this.gateLeft -= 1; t = this.trigVal; }
    const delayed = this.hist[this.histPos];
    if (delayed + t !== 0) this.g = t;
    if (t !== 0) this.latched = t;
    this.hist[this.histPos] = t;
    this.histPos = (this.histPos + 1) % this.hist.length;
    return this.g;
  }
}

export class Hats {
  /** @param {number} sr  sample rate the hats run at  @param {number} [os] oversampling factor included in sr */
  constructor(sr, os = 1) {
    this.sr = sr;
    this.os = os;
    // one-pole low-pass coefficients: sin/(1+sin+cos) of 2π·10 kHz and 9672.96/sr (≈1539.5 Hz)
    const w1 = 2 * Math.PI * 10000 / sr;
    const s1 = Math.sin(w1), c1 = Math.cos(w1);
    this.g1 = s1 / (1 + s1 + c1);
    const s2 = Math.sin(9672.96378 / sr), c2 = Math.cos(9672.96378 / sr);
    this.g2 = s2 / (1 + s2 + c2);
    this.kC = Math.tan(78539.81634 / (2 * sr));
    this.kO = Math.tan(57302.65 / (2 * sr));
    this._ohKey = NaN; this._ohCoef = 0;
    this.closed = new Hat(sr);
    this.open = new Hat(sr);
    this.out = { closed: 0, open: 0 };
  }

  /** value: 1 for a hit, 2 accented. */
  triggerClosed(value) { this._fire(this.closed, value); }
  triggerOpen(value) { this._fire(this.open, value); }
  _fire(h, value) {
    h.gateLeft = Math.max(1, Math.round(0.001 * this.sr));
    h.trigVal = value;
    h.vel = value;
  }

  /** m: metal signal; chDec = CH_DEC, ohDec = OH_DEC. Returns {closed, open} (reused object). */
  tick(m, chDec, ohDec) {
    const sr = this.sr;
    const g1 = this.g1, g2 = this.g2;

    // closed hat: linear decay 0.000279·(2.2−2.1·dec) per sample (×0.4 below 0.3),
    // raised to (0.1·acc + 2), into tanh VCA, high-pass 12.5 kHz Q 2.5, low-pass 10 kHz, ×(−10)
    const rate = 2.2 - 2.1 * chDec;
    const c = this.closed;
    let g = c.gate();
    let e = g !== 0 ? g : c.env;
    e = clamp(e, 0, 1);
    let r = 0.3 < e ? rate : rate * 0.4;
    e = clamp(e + r * -0.000279 / this.os, 0, 1);
    c.env = e;
    const acc = ((c.vel - 0.25) * 4 / 3) * 0.1 + 2;
    const ep = acc !== 1 ? sgnpow(e, acc) : e;
    const envC = c.vel * ep;
    let th = Math.tanh(m * 6 + 1 + envC * -0.5) - 1;
    let xin = envC * -th;
    let y = c.hp.hp(xin, this.kC, 2.5);
    c.lp = g1 * y + g1 * c.lpPrevIn + c.lp * (1 - g1);
    c.lpPrevIn = y;
    const outC = c.lp * -10;

    // open hat: two-stage decay with coef (1−dec)^3.333·1.25+0.25, cubed × velocity,
    // tanh VCA, high-pass 9.12 kHz Q 2, low-pass ≈1.54 kHz, ×(−20)
    if (ohDec !== this._ohKey) { this._ohKey = ohDec; this._ohCoef = Math.pow(Math.max(1 - ohDec, 0), 3.333) * 1.25 + 0.25; }
    const coef = this._ohCoef;
    const o = this.open;
    g = o.gate();
    e = g !== 0 ? g : o.env;
    e = clamp(e, 0, 1);
    const normal = o.latched === 1;
    const slow = normal ? coef : 2.5;
    const fast = (normal ? 6 : 2) * coef;
    r = 0.44 < e ? slow : fast;
    e = clamp(e + r * -6e-05 / this.os, 0, 1);
    o.env = e;
    const envO = sgnpow(e, 3) * o.vel;
    th = Math.tanh(m * 6 + 1 + envO * -0.5) - 1;
    xin = envO * -th;
    y = o.hp.hp(xin, this.kO, 2);
    o.lp = g2 * y + g2 * o.lpPrevIn + o.lp * (1 - g2);
    o.lpPrevIn = y;
    const outO = o.lp * -20;

    this.out.closed = outC;
    this.out.open = outO;
    return this.out;
  }
}
