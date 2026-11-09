// Bass drum laid out like the TR-808's bass drum circuit, with the constants fitted to a
// component-level simulation of that circuit (across Tone and Decay) and to the 25 recordings
// of a real TR-808 bass drum in samples/808/BD.
//
// A bridged-T resonator around an op-amp rings as a damped sine. For the first few
// milliseconds after the trigger a transistor shorts one of its resistors, so the first
// half-cycle runs at about two and a half times the pitch; then a second, smaller kick restarts it at
// the normal pitch. The pitch slides down a little to the network's resting ~49 Hz as a
// capacitor recovers; the slide is quicker at short Decay settings. The trigger edge also
// leaks straight through to the output (the click). Tone is the machine's pot network into a
// one-pole low-pass, computed from its parts.
//
// Knobs: BD_ATK is Tone (as on the machine), BD_DEC the ring time, BD_TUNE the pitch
// (x0.67 .. x1.5), BD_PAMT the depth of the pitch slide (0 .. x2), all centred = as built.

import { sgnpow } from './dsp.js';

/** legacy: true uses the Rust app's bass drum (voices/bass-drum.js) instead; read when the Engine is built. */
export const BASS_FIT = { legacy: false };

/** Fitted constants (times in seconds, frequencies in Hz). */
export const BASS_808 = {
  f0: 49.448,        // resting pitch
  glide: 0.10995,    // extra pitch at the start, fraction of f0
  glideK: 0.26297,   // glide time constant, fraction of the ring time
  d0: 0.051816, d5: 0.30798, d1: 0.8824, // ring time to -20 dB at Decay 0 / centre / max
  fast: 2.396,       // pitch multiple while the first segment lasts
  seg: 0.0048509,     // first segment length
  kick1: 1.6009, kick2: 0.31928, // first kick and the re-trigger kick, × ring amplitude
  click: 0.78865,    // trigger feed-through, × ring amplitude
  accent: 2.07,     // accented ring amplitude, × normal
  gain: 8.64,
};

const LN10 = Math.log(10);
const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
const map3 = (p, lo, mid, hi) => (p < 0.5 ? lo * (mid / lo) ** (2 * p) : mid * (hi / mid) ** (2 * p - 1));

export class Bass808 {
  /** @param {number} sr sample rate the voice runs at */
  constructor(sr) {
    this.sr = sr;
    this.t = 1e9; this.amp = 0; this.g = 0; this.segN = 0;
    this.f = 48; this.q = 10;
    this.ic1 = 0; this.ic2 = 0; this.gg = 0; this.k = 1; this.a1 = 0; this.a2 = 0; this.a3 = 0;
    this.pulseN = 0; this.pulseH = 0;
    this.tz = 0; this.tA = 0; this.cz = 0;
    this.cA = 1 - Math.exp(-2 * Math.PI * 400 / sr);
    this.lvl = 0; this._volKey = NaN; this._lvlT = 0;
    this._toneKey = NaN; this.pending = false; this.accented = false;
    this.f0 = 48; this.t10 = 0.3; this.gK = 0; this.glide = 0;
  }

  /** velocity: 1 for a hit, 2 accented. */
  trigger(velocity) { this.pending = true; this.accented = velocity > 1; }

  _res(f) {
    f = Math.min(f, this.sr * 0.45);
    this.f = f;
    this.gg = Math.tan(Math.PI * f / this.sr); this.k = 1 / this.q;
    this.a1 = 1 / (1 + this.gg * (this.gg + this.k)); this.a2 = this.gg * this.a1; this.a3 = this.gg * this.a2;
  }

  /** pulse height that leaves the resonator ringing at peak amplitude amp (1 ms pulse) */
  _kick(amp) {
    const s = Math.abs(Math.sin(Math.PI * this.f * 0.001));
    this.pulseH = amp / (2 * this.k * Math.max(s, 0.05));
    this.pulseN = Math.max(1, Math.round(0.001 * this.sr));
  }

  /** One sample. Knobs are panel values 0..1 (BD_TUNE, BD_ATK = tone, BD_DEC, BD_PAMT, BD_VOL). */
  tick(tune, tone, dec, pamt, vol) {
    const K = BASS_808, sr = this.sr;
    if (vol !== this._volKey) { this._volKey = vol; this._lvlT = sgnpow(vol, 1.12); }
    this.lvl += 0.02 * (this._lvlT - this.lvl);
    if (tone !== this._toneKey) {
      this._toneKey = tone;
      // tone pot (10k, C taper) || 10k, in series with 220R, into 0.1 µF
      const vr = 10e3 * (1 - clamp01(tone)) ** 2 + 1;
      const R = 220 + (vr * 10e3) / (vr + 10e3);
      this.tA = 1 - Math.exp(-2 * Math.PI * Math.min(1 / (2 * Math.PI * R * 0.1e-6), sr * 0.45) / sr);
    }
    if (this.pending) {
      this.pending = false;
      this.t10 = map3(clamp01(dec), K.d0, K.d5, K.d1);
      this.f0 = K.f0 * 1.5 ** ((clamp01(tune) - 0.5) * 2);
      this.q = Math.PI * K.f0 * this.t10 / LN10;
      this.gK = Math.exp(-1 / (K.glideK * this.t10 * sr));
      this.glide = K.glide * 2 * clamp01(pamt);
      this.amp = this.accented ? K.accent : 1;
      this.t = 0; this.g = 1;
      this.segN = Math.max(1, Math.round(K.seg * sr));
      this._res(this.f0 * (1 + this.glide) * K.fast);
      this._kick(this.amp * K.kick1);
    }
    if (this.t > sr * 6) return 0;
    const t = this.t++;
    if (t === this.segN) {
      this._res(this.f0 * (1 + this.glide * this.g));
      this._kick(this.amp * K.kick2);
    } else if (t > this.segN && (t & 15) === 0) {
      this._res(this.f0 * (1 + this.glide * this.g));
    }
    this.g *= this.gK;
    let x = 0;
    if (this.pulseN > 0) { this.pulseN -= 1; x = this.pulseH; }
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    let y = this.k * v1;
    const ck = t < sr * 0.001 ? this.amp * K.click : 0;
    this.cz += this.cA * (ck - this.cz);
    y += ck - this.cz;
    this.tz += this.tA * (y - this.tz);
    return this.tz * this.lvl * K.gain;
  }
}
