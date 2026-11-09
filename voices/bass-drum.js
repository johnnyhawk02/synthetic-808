// Bass drum (port of app/src/bd.rs). Runs in double precision every sample.

import { sgnpow, clamp, histLen } from './dsp.js';

/** Hidden parameter BD_BASE (range 49..69, default 56). */
export const BD_BASE = 56.0;
/** Length of the trigger gate the voice receives (ms). */
const GATE_MS = 1.0;

/** The panel's TUNE knob is bent through (0,0) (0.3,0.4) (0.5,0.5) (0.7,0.6) (1,1). */
export function skewBdTune(x) {
  const XS = [0.0, 0.3, 0.5, 0.7, 1.0];
  const YS = [0.0, 0.4, 0.5, 0.6, 1.0];
  x = clamp(x, 0, 1);
  let i = 0;
  while (i < 3 && x > XS[i + 1]) i++;
  const t = XS[i + 1] - XS[i] > 0 ? (x - XS[i]) / (XS[i + 1] - XS[i]) : 0;
  return YS[i] + t * (YS[i + 1] - YS[i]);
}

export class BassDrum {
  constructor(sr) {
    this.sr = sr;
    this.decS = 0.5; this.pamtS = 0.5; this.tuneS = 0.5; this.atkS = 0.5;
    this.lvl = 0;
    this.gateLeft = 0; this.gateVal = 0;
    this.vel = 0; this.g = 0;
    this.hist = new Float64Array(histLen(sr));
    this.histPos = 0;
    this.prev0 = 0; this.prev1 = 0;
    this.eFall = 0; this.eRise = 0;
    this.hold = 0;
    this.env1 = 0; this.env2 = 0;
    this.kickFlag = 0;
    this.y1 = 0; this.y2 = 0;
    this.peak = 0;
    this.z = 0;
  }

  /** velocity: 1 for a hit, 2 accented. */
  trigger(velocity) {
    this.gateLeft = Math.max(1, Math.round(GATE_MS * 0.001 * this.sr));
    this.gateVal = 1;
    this.vel = velocity;
  }

  /** One sample. Knobs are panel values 0..1 (BD_TUNE, BD_ATK, BD_DEC, BD_PAMT, BD_VOL). */
  tick(tuneKnob, atk, dec, pamt, vol) {
    const sr = this.sr;
    const tune = skewBdTune(tuneKnob);
    const lvlTarget = sgnpow(vol, 1.12);

    this.decS += 0.02 * (dec - this.decS);
    this.pamtS += 0.02 * (pamt - this.pamtS);
    this.tuneS += 0.02 * (tune - this.tuneS);
    this.atkS += 0.02 * (atk - this.atkS);
    this.lvl += 0.02 * (lvlTarget - this.lvl);

    let trig = 0;
    if (this.gateLeft > 0) { this.gateLeft -= 1; trig = this.gateVal; }
    const delayed = this.hist[this.histPos];
    if (delayed + trig !== 0) this.g = trig;
    const g = this.g;
    const tuneSel = BD_BASE;

    // velocity → accent amount
    const a = ((this.vel - 0.25) * 4 / 3 - 0.25) * 4 / 3;
    const aa = a * 1.5 + 0.5;
    const gm = (g - 0.25) * 4 / 3 * 0.6;
    const tuneMul = this.tuneS * 0.5 + 0.75;

    // edge detectors on the gate
    const d0 = g - this.prev0;
    const d1 = g - this.prev1;
    const t0 = d0 <= 0 ? 0.04 * d0 : 0;
    const t1 = d1 >= 0 ? 0.1 * d1 : 0;
    this.eFall += (t0 - this.eFall) * (this.eFall < t0 ? 1 / 11 : 1);
    this.eRise += (t1 - this.eRise) * (this.eRise < t1 ? 1 : 0.5);
    const k = (aa - 0.25) * 4 / 3 * 0.7 + 0.3;
    this.prev0 = g;
    this.prev1 = g;
    const gk = g * k * 0.01;

    // 5.333 ms hold at 115 Hz, then the pitch sweep
    if (g > 0) { this.hold = sr * 0.005333; this.env1 = 1; this.env2 = 1; }
    let f;
    if (this.hold > 0) {
      this.hold -= 1;
      this.kickFlag = 0;
      f = 115.0;
    } else {
      this.kickFlag = this.env1 === 1 ? 1 : 0;
      const d = this.decS * 0.9 + 0.1;
      this.env1 *= Math.exp(-9 / (sr * 0.35 * d));
      this.env2 *= Math.exp(-3 / (sr * 12 * d));
      const pm = this.pamtS * 1.9 + 0.1;
      const am = a * 0.1 + 0.9;
      f = tuneMul * (tuneSel - 8.67) + this.env2 * pm * 0.5 * am + this.env1 * pm * 15 * am;
    }
    const m = gm + 0.7;
    const w = 2 * Math.PI * f / sr;
    const tau = 0.2 + 3.3 * this.decS * this.decS;
    const r = Math.min(Math.exp(-6 / (tau * sr)), 0.9999999);
    const exc = this.eFall * k + this.eRise * k * 1.5 + gk;
    const s = Math.sin(w), c = Math.cos(w);

    // rotating resonator
    let y2n = r * (this.y2 * c + this.y1 * s) - exc;
    y2n += (1 - this.env1) * (-2e-5 * y2n) * aa;
    const x = t1 * aa;
    this.peak += (x - this.peak) * (x > this.peak ? 1 : 0.125);
    const q = (1.5 - m) * (1.5 * this.env1 * this.env1 + 0.2 * this.env2) * (0.2 * this.env2);
    const neg = Math.max(-y2n, 0);
    const o = (y2n + neg * neg * q) * 0.3;
    const gcoef = Math.tan(Math.PI * (this.atkS * this.atkS * 7200 + 600) / sr);
    const y1n = r * (this.y1 * c - this.y2 * s) + aa * this.kickFlag * 0.08465;
    this.z = (o - this.peak) * gcoef + this.z * (1 - gcoef);
    const out = this.lvl * this.z * -45;

    this.hist[this.histPos] = trig;
    this.histPos = (this.histPos + 1) % this.hist.length;
    this.y1 = y1n;
    this.y2 = y2n;
    return out;
  }
}
