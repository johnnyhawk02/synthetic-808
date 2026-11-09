// Cymbal laid out like the TR-808's cymbal circuit, with its constants fitted to the 25
// recordings of a real TR-808 cymbal in samples/808/CY (Tone and Decay at 0, 2.5, 5, 7.5, 10).
//
// Three envelopes, as on the machine's voicing board:
//   A     short (about 34 ms), feeds high band A
//   B     medium (about 140 ms) plus a share of the long envelope, feeds high band B
//   long  set by DECAY (an RC discharge, about 0.18 to 0.95 s), smoothed, feeds the low band
// Each band is a switching VCA: the envelope is gated by the metal oscillators' high (hi) or
// low (lo) band, then filtered: A through a 7 kHz high-pass and a resonant 8.8 kHz high-pass,
// B through an 8.8 kHz high-pass, low through a 2.5 kHz high-pass and a 480 Hz low-pass.
// TONE is the machine's pot network, crossfading A against B + low; the mixer's feedback
// capacitor rounds off the top.

import { sgnpow, follow } from './dsp.js';

/** legacy: true uses the Rust app's cymbal (voices/cymbal.js) instead; read when the Engine is built. */
export const CYMBAL_FIT = { legacy: false };

/** Fitted constants (times in seconds, frequencies in Hz). */
export const CYMBAL_808 = {
  a0: Math.exp(-1.397), tauA: 0.033977,
  b0: Math.exp(-0.35575), tauB: 0.13642, bLong: Math.exp(-2.753),
  th: 0.00089655, thLong: 0.005665,
  tauLong: 0.38346,             // × (0.47 + 2·DECAY): R93 470k + VR2 2M into 1 µF
  tauLowSmooth: 0.0726,         // R105 33k, 2.2 µF
  kHi: 12.147, bHi: 0.11778,    // gate: 0.5·(1 − tanh(k·(x − b)))
  kLo: 2.9529, bLo: -0.012079,
  gA: Math.exp(-1.2509), gB: Math.exp(-1.9637), gLow: Math.exp(-2.1248),
  qA: 7.5231, qB: 0.98788, qLow: 0.6628,
  lpOut: 3024.8,
  accent: 1.6,
};

// first-order (bilinear, prewarped) and RBJ second-order sections: [b0, b1, b2, a1, a2]
function onePole(type, fc, sr) {
  const K = Math.tan(Math.PI * Math.min(fc, sr * 0.45) / sr), a1 = (K - 1) / (K + 1);
  return type === 'lp' ? [K / (1 + K), K / (1 + K), 0, a1, 0] : [1 / (1 + K), -1 / (1 + K), 0, a1, 0];
}
function hp2(fc, q, sr) {
  const w = 2 * Math.PI * Math.min(fc, sr * 0.45) / sr, cw = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
  return [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, -2 * cw / a0, (1 - al) / a0];
}
class Chain {
  constructor(sections) { this.c = sections; this.z = new Float64Array(sections.length * 2); }
  run(x) {
    const c = this.c, z = this.z;
    for (let i = 0, j = 0; i < c.length; i++, j += 2) {
      const s = c[i], y = s[0] * x + z[j];
      z[j] = s[1] * x - s[3] * y + z[j + 1];
      z[j + 1] = s[2] * x - s[4] * y;
      x = y;
    }
    return x;
  }
}

/** The tone pot (VR4 20k, wiper grounded) and its resistors; returns [weight A, weight B + low]. */
function toneWeights(tone) {
  const t = Math.min(Math.max(tone, 0), 1);
  const par = (a, b) => (a * b) / (a + b);
  const zA = par(Math.max(20e3 * t, 1), 22e3);
  const zL = par(20e3 * (1 - t) + 2.2e3, 15e3);
  return [(zA / (22e3 + zA) / 22e3) * 1e4, (zL / (5e3 + zL) / 15e3) * 0.5e4];
}

export class Cymbal808 {
  /** @param {number} sr  sample rate the voice runs at  @param {number} [os] oversampling factor included in sr */
  constructor(sr, os = 1) {
    const K = CYMBAL_808;
    this.sr = sr;
    this.k02 = follow(0.02, os);
    this.dA = Math.exp(-1 / (K.tauA * sr));
    this.dB = Math.exp(-1 / (K.tauB * sr));
    this.kSmooth = 1 - Math.exp(-1 / (K.tauLowSmooth * sr));
    this.fA = new Chain([onePole('hp', 7090, sr), hp2(8840, K.qA, sr)]);
    this.fB = new Chain([hp2(8840, K.qB, sr)]);
    this.fLow = new Chain([hp2(2500, K.qLow, sr), onePole('hp', 159, sr), onePole('lp', 482, sr)]);
    this.fOut = new Chain([onePole('lp', K.lpOut, sr)]);
    this.eA = 0; this.eB = 0; this.eLong = 0; this.eLow = 0;
    this.toneS = 0.5; this.decS = 1; this.lvlS = 0;
    this._volKey = NaN; this._lvlT = 0; this._toneKey = NaN; this._decKey = NaN;
    this.wA = 0; this.wL = 0; this.dLong = 0;
  }

  /** value: 1 for a hit, 2 accented. The envelope stores charge up to the trigger's level. */
  trigger(value) {
    const K = CYMBAL_808, amp = value > 1 ? K.accent : 1;
    this.eA = Math.max(this.eA, K.a0 * amp);
    this.eB = Math.max(this.eB, K.b0 * amp);
    this.eLong = Math.max(this.eLong, amp);
  }

  /** hi, lo: Metal.tick() band outputs. vol = RC_VOL, tone = RC_TONE, dec = RC_DEC. */
  tick(hi, lo, vol, tone, dec) {
    const K = CYMBAL_808;
    if (vol !== this._volKey) { this._volKey = vol; this._lvlT = sgnpow(vol, 1.12); }
    this.lvlS += (this._lvlT - this.lvlS) * this.k02;
    this.toneS += (tone - this.toneS) * this.k02;
    this.decS += (dec - this.decS) * this.k02;
    if (this.toneS !== this._toneKey) { this._toneKey = this.toneS; [this.wA, this.wL] = toneWeights(this.toneS); }
    if (this.decS !== this._decKey) {
      this._decKey = this.decS;
      const tau = Math.max(K.tauLong * (0.47 + 2 * this.decS), 0.01);
      this.dLong = Math.exp(-1 / (tau * this.sr));
    }

    this.eA *= this.dA; this.eB *= this.dB; this.eLong *= this.dLong;
    const long = Math.max(0, this.eLong - K.thLong);
    this.eLow += (long - this.eLow) * this.kSmooth;
    const envA = Math.max(0, this.eA - K.th);
    const envB = Math.max(0, this.eB - K.th) + K.bLong * long;

    const gHi = 0.5 * (1 - Math.tanh(K.kHi * (hi - K.bHi)));
    const gLo = 0.5 * (1 - Math.tanh(K.kLo * (lo - K.bLo)));
    const a = this.fA.run(envA * gHi) * K.gA;
    const b = this.fB.run(envB * gHi) * K.gB;
    const l = this.fLow.run(this.eLow * gLo) * K.gLow;
    return this.fOut.run(this.wA * a + this.wL * (b + l)) * this.lvlS;
  }
}
