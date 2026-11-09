// Hand clap and maracas laid out like the TR-808's clap / maracas board, with the constants
// fitted to a component-level simulation of that board (across its decay, spacing and reverb
// settings) and to recordings of a real TR-808 (samples/808/CP and MA).
//
// Clap
//   White noise through a band-pass (about 1.1 kHz), soft-clipped by the VCA's input stage.
//   A sawtooth control voltage gates it: inside the trigger's window the sawtooth is dumped
//   and restarts every ~11 ms (one clap per ramp); at the end of the window it is dumped once
//   more and that last ramp falls slowly. The VCA opens exponentially with the sawtooth.
//   A second, slower envelope (a peak-hold capacitor charged by the trigger) drives a
//   transistor amplifier on the same band-passed noise: the "reverb" tail, low-passed.
//   A little of the sawtooth leaks into the output as a low thump.
// Maracas
//   Noise through a gate that opens slowly (about 13 ms), stays open about 22 ms and snaps
//   shut, then a 900 Hz high-pass, a resonant 10 kHz high-pass and the mixer's roll-off.
//
// Knobs (all centred = as built):
//   clap:    OFFSET  clap spacing (x0.5 .. x2)        CLPS  window length: number of claps
//            DEC     last clap's decay (x1/3 .. x3)   TAIL  reverb decay (x1/3 .. x3)
//            REV     reverb level (0 .. x2)           FLT   reverb low-pass (x1/4 .. x4)
//   maracas: DEC     gate length (x1/3 .. x3)         OFFSET attack (x0.5 .. x2)
//            FLT     high-pass tuning (x0.5 .. x2)

import { XorShift32 } from './dsp.js';

/** legacy: true uses the Rust app's clap (voices/clap.js) instead; read when the Engine is built. */
export const CLAP_FIT = { legacy: false };

/** Fitted constants (times in seconds, frequencies in Hz). */
export const CLAP_808 = {
  bpF: 1079.8, bpQ: 2.6, drive: 1.2831,
  tooth: 0.011667, win: 0.028223, tTau: 0.0040433, lTau: 0.032754, expK: 1.4608,
  vA: 0.029425, vAtt: 0.04171, vDec: 0.46987, vLp: 2200, vLev: 0.141,
  thump: 0.010681,
  // maracas
  maAtt: 0.012621, maHold: 0.021841, maRel: 0.001999,
  maHp1: 912.32, maHpF: 10111, maHpQ: 1.7524, maLp: 2764.7, maGain: 7.82,
  gain: 8.15, // clap output level, matched to the earlier clap's loudness
};

const span = (v, s) => s ** ((Math.min(Math.max(v, 0), 1) - 0.5) * 2);
const decayK = (t, sr) => Math.exp(-1 / (Math.max(t, 1e-5) * sr));
const NOISE_GAIN = 0.866; // uniform noise in -1..1 scaled to 0.5 rms

/** Direct-form-I biquad from RBJ coefficients. */
class Biquad {
  constructor() { this.b0 = 0; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  set(type, fc, q, sr) {
    const w = 2 * Math.PI * Math.min(fc, sr * 0.45) / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    if (type === 'bp') { this.b0 = al / a0; this.b1 = 0; this.b2 = -al / a0; }
    else { this.b0 = (1 + cw) / 2 / a0; this.b1 = -(1 + cw) / a0; this.b2 = this.b0; }
    this.a1 = -2 * cw / a0; this.a2 = (1 - al) / a0;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** Bilinear one-pole low- or high-pass. */
class OnePole {
  constructor(type, fc, sr) { this.type = type; this.x1 = 0; this.y1 = 0; this.set(fc, sr); }
  set(fc, sr) {
    const K = Math.tan(Math.PI * Math.min(fc, sr * 0.45) / sr);
    this.a1 = (K - 1) / (K + 1);
    if (this.type === 'lp') { this.b0 = K / (1 + K); this.b1 = this.b0; } else { this.b0 = 1 / (1 + K); this.b1 = -this.b0; }
  }
  run(x) { const y = this.b0 * x + this.b1 * this.x1 - this.a1 * this.y1; this.x1 = x; this.y1 = y; return y; }
}

export class Clap808 {
  constructor(sr, seed = 0x12345678) {
    const K = CLAP_808;
    this.sr = sr;
    this.noise = new XorShift32(seed);
    this.bp = new Biquad(); this.bp.set('bp', K.bpF, K.bpQ, sr);
    this.vLp = new OnePole('lp', K.vLp, sr);
    this.thHp = new OnePole('hp', 20, sr);
    this.maHp1 = new OnePole('hp', K.maHp1, sr);
    this.maHp = new Biquad(); this.maHp.set('hp', K.maHpF, K.maHpQ, sr);
    this.maLp = new OnePole('lp', K.maLp, sr);
    this.ek = Math.exp(K.expK) - 1;
    this.maracas = false;
    this.t = 1e9; this.saw = 0; this.vC = 0; this.vS = 0; this.e = 0;
    this.toothN = 1; this.winN = 0; this.fast = 0; this.slow = 0; this.vDk = 0; this.vAk = 0; this.wet = 1; this.rev = 1;
    this.holdN = 0; this.aK = 0; this.rK = 0;
  }

  /** @param {{maracas:boolean, offset:number, clps:number, dec:number, tail:number, rev:number, flt:number}} k */
  trigger(k) {
    const K = CLAP_808, sr = this.sr;
    this.maracas = !!k.maracas;
    this.t = 0;
    if (this.maracas) {
      const d = span(k.dec, 3), a = span(k.offset, 2), m = span(k.flt, 2);
      this.aK = decayK(K.maAtt * d * a, sr); this.rK = decayK(K.maRel * d, sr);
      this.holdN = Math.round(K.maHold * d * sr);
      this.maHp1.set(K.maHp1 * m, sr); this.maHp.set('hp', K.maHpF * m, K.maHpQ, sr);
      return;
    }
    const s = span(k.offset, 2), tail = span(k.tail, 3);
    this.toothN = Math.max(1, Math.round(K.tooth * s * sr));
    this.fast = decayK(K.tTau * s, sr);
    this.winN = Math.round(K.win * span(k.clps, 2.2) * sr);
    this.slow = decayK(K.lTau * span(k.dec, 3), sr);
    this.vDk = decayK(K.vDec * tail, sr);
    this.vAk = decayK(K.vAtt, sr);
    this.rev = 2 * Math.min(Math.max(k.rev, 0), 1);
    this.wet = this.rev * K.vA * tail ** K.vLev;
    this.vLp.set(K.vLp * span(k.flt, 4), sr);
    this.saw = 1; this.vC = 1;
  }

  tick() {
    const K = CLAP_808;
    const t = this.t;
    if (t > this.sr * 4) return 0;
    this.t = t + 1;
    const n = this.noise.next() * NOISE_GAIN;
    if (this.maracas) {
      this.e = t < this.holdN ? 1 + (this.e - 1) * this.aK : this.e * this.rK;
      if (t > this.holdN && this.e < 1e-6) this.t = 1e9;
      return this.maLp.run(this.maHp.run(this.maHp1.run(n * this.e))) * K.maGain;
    }
    if (t < this.winN) { this.saw *= this.fast; if (t > 0 && t % this.toothN === 0) this.saw = 1; }
    else { if (t === this.winN) this.saw = 1; this.saw *= this.slow; }
    const g = (Math.exp(K.expK * this.saw) - 1) / this.ek;
    this.vC *= this.vDk;
    this.vS = this.vC + (this.vS - this.vC) * this.vAk;
    const nz = this.bp.run(n);
    const clap = Math.tanh(nz * K.drive) * g;
    const verb = this.vLp.run(nz * this.vS * this.wet);
    const thump = this.thHp.run(this.saw * K.thump * this.rev);
    if (this.vC < 1e-5 && this.saw < 1e-5) this.t = 1e9;
    return (clap + verb + thump) * K.gain;
  }
}
