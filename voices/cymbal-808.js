// Cymbal fitted to recordings of a TR-808 cymbal (the 25 CY files in samples/808, Tone and
// Decay at 0, 2.5, 5, 7.5 and 10).
//
// The metal oscillator bank's raw square-wave mix is split by steep (24 dB/octave) crossovers
// into three bands: low (up to about 4 kHz), mid and top (above about 8.5 kHz), each shaped
// by a few more filters to the recordings' spectrum. Each band has
// its own envelope, level(dB) − 8.69·(t/τ)^p. On the recordings the low band rings long with a
// rounded fade (p ≈ 2) and sets the cymbal's tail; the mid and top bands fall fast and then
// linger (p < 1), and Tone mostly raises and shortens the top. Level, τ and p per band come
// from CYMBAL_TABLE, interpolated between the recorded knob positions.

import { sgnpow, follow } from './dsp.js';
import { CYMBAL_TABLE } from './cymbal-table.js';

/** legacy: true uses the Rust app's cymbal (voices/cymbal.js) instead; read when the Engine is built. */
export const CYMBAL_FIT = { legacy: false };

const BANDS = CYMBAL_TABLE.bands;
const NB = BANDS.length;
const BLOCK = 16; // envelope update interval, in samples

/** RBJ biquad coefficients [b0, b1, b2, a1, a2]: 'lp', 'hp', or 'pk' (peaking, gain in dB) */
function rbj(type, fc, q, sr, gainDb = 0) {
  const w = 2 * Math.PI * Math.min(fc, sr * 0.45) / sr;
  const cw = Math.cos(w), alpha = Math.sin(w) / (2 * q);
  if (type === 'pk') {
    const A = 10 ** (gainDb / 40), a0 = 1 + alpha / A;
    return [(1 + alpha * A) / a0, -2 * cw / a0, (1 - alpha * A) / a0, -2 * cw / a0, (1 - alpha / A) / a0];
  }
  const a0 = 1 + alpha;
  const b0 = type === 'lp' ? (1 - cw) / 2 : (1 + cw) / 2;
  const b1 = type === 'lp' ? 1 - cw : -(1 + cw);
  return [b0 / a0, b1 / a0, b0 / a0, -2 * cw / a0, (1 - alpha) / a0];
}

/** bilinear lookup in a 5×5 grid [tone][dec], extrapolating linearly outside 0..1 */
function grid(rows, tone, dec) {
  const x = tone * 4, y = dec * 4;
  const i = Math.min(Math.max(Math.floor(x), 0), 3), j = Math.min(Math.max(Math.floor(y), 0), 3);
  const fx = x - i, fy = y - j;
  const a = rows[i][j] + (rows[i + 1][j] - rows[i][j]) * fx;
  const b = rows[i][j + 1] + (rows[i + 1][j + 1] - rows[i][j + 1]) * fx;
  return a + (b - a) * fy;
}

export class Cymbal808 {
  /** @param {number} sr  sample rate the voice runs at  @param {number} [os] oversampling factor included in sr */
  constructor(sr, os = 1) {
    this.sr = sr;
    this.k02 = follow(0.02, os);
    // each band: a chain of biquads given as [type, Hz, Q, gain dB]
    this.chains = BANDS.map((chain) => chain.map(([type, fc, q, g]) => rbj(type, fc, q, sr, g)));
    this.z = this.chains.map((ch) => new Float64Array(ch.length * 2));
    this.gain = new Float64Array(NB);    // envelope at the start of the block
    this.step = new Float64Array(NB);    // per-sample envelope increment within the block
    this.lv = new Float64Array(NB);
    this.tau = new Float64Array(NB);
    this.pw = new Float64Array(NB);
    this.t = Infinity; this.left = 0; this.amp = 0;
    this.toneS = 0.5; this.decS = 1; this.lvlS = 0;
    this._key = NaN; this._volKey = NaN; this._lvlT = 0;
  }

  /** value: 1 for a hit, 2 accented. */
  trigger(value) {
    this.t = 0;
    this.left = 0;
    this.amp = value > 1 ? CYMBAL_TABLE.accent : 1;
    this._key = NaN; // re-read the knobs for this hit
  }

  _params() {
    const T = CYMBAL_TABLE, tone = this.toneS, dec = this.decS;
    for (let k = 0; k < NB; k++) {
      this.lv[k] = 10 ** (grid(T.level[k], tone, dec) / 20);
      this.tau[k] = Math.max(grid(T.tau[k], tone, dec), 0.01) * this.sr;
      this.pw[k] = Math.min(Math.max(grid(T.p[k], tone, dec), 0.3), 3);
    }
  }

  _env(k, t) { return this.lv[k] * Math.exp(-((t / this.tau[k]) ** this.pw[k])); }

  /** src: Metal.tick().raw. vol = RC_VOL, tone = RC_TONE, dec = RC_DEC. */
  tick(src, vol, tone, dec) {
    if (vol !== this._volKey) { this._volKey = vol; this._lvlT = sgnpow(vol, 1.12); }
    this.lvlS += (this._lvlT - this.lvlS) * this.k02;
    this.toneS += (tone - this.toneS) * this.k02;
    this.decS += (dec - this.decS) * this.k02;

    if (this.left === 0) {
      // new envelope block: values at t and t + BLOCK, interpolated linearly in between
      if (this.toneS * 1e3 + this.decS !== this._key) { this._key = this.toneS * 1e3 + this.decS; this._params(); }
      const t = this.t;
      for (let k = 0; k < NB; k++) {
        const a = t === Infinity ? 0 : this._env(k, t);
        const b = t === Infinity ? 0 : this._env(k, t + BLOCK);
        this.gain[k] = a; this.step[k] = (b - a) / BLOCK;
      }
      this.left = BLOCK;
    }
    this.left--;
    if (this.t !== Infinity) this.t++;

    let sum = 0;
    for (let k = 0; k < NB; k++) {
      const chain = this.chains[k], z = this.z[k];
      let x = src;
      for (let i = 0, j = 0; i < chain.length; i++, j += 2) {
        // transposed direct form II
        const c = chain[i];
        const y = c[0] * x + z[j];
        z[j] = c[1] * x - c[3] * y + z[j + 1];
        z[j + 1] = c[2] * x - c[4] * y;
        x = y;
      }
      sum += x * this.gain[k];
      this.gain[k] += this.step[k];
    }
    return sum * this.amp * this.lvlS;
  }
}
