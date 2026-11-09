// Snare drum laid out like the TR-808's snare circuit (the later boards' revised parts), with
// the constants fitted to a component-level simulation of that circuit (across Tone and
// Snappy) and to the 25 recordings of a real TR-808 snare in samples/808/SD. An alternative to
// the default snare (voices/snare.js), picked with the snare's Fit / Circuit switch (SD_SW).
//
//   drum    two bridged-T resonators (about 175 and 310 Hz) kicked by the 1 ms trigger
//   Tone    the loaded pot between the two drums, computed from its parts
//   snappy  the Snappy pot drives a transistor one Vbe down, so near the bottom of its travel
//           there is no noise at all; above that the noise envelope grows with it. The envelope
//           is a capacitor charged by the trigger, smoothed and discharging. White noise gated by
//           it goes through a transistor's roll-off, the Sallen-Key high-pass of the snare wires
//           (about 2.7 kHz) and a coupling high-pass.
//   mixer   both paths into the output op-amp, whose feedback capacitor rounds off the top.
//
// Knobs, centred = as built: SD_DECAY scales the drums' ring (x1/3 .. x3), SD_NDEC the snappy
// decay (x1/3 .. x3), SD_PITCH both drums (x0.67 .. x1.5), SD_BAL tilts drum against snappy,
// SD_WIRES moves the wires' high-pass (x0.5 .. x2).

import { XorShift32 } from './dsp.js';

/** Fitted constants (times in seconds, frequencies in Hz). */
export const SNARE_808 = {
  fLo: 173.4, qLo: 15.6, fHi: 311.96, qHi: 9.3346,
  kLo: 0.16556, kHi: 0.25863,         // ring amplitude per volt of trigger
  nK: 1.4254,                         // noise per volt of snappy drive
  nAtt: 9.2e-6, nDec: 0.033062,       // snappy envelope attack / decay
  nLp: 861.69,                        // transistor roll-off
  outLp: 9227.3,                      // output op-amp feedback capacitor
  wires: 2750, wiresQ: 0.731,         // Sallen-Key high-pass of the wires
  vb: 4.44, vbAccent: 8.88,           // trigger volts, normal / accented
  gain: 13.73,                        // level matched to the default snare
};

const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
const span = (v, s) => s ** ((clamp01(v) - 0.5) * 2);
const onePoleA = (f, sr) => 1 - Math.exp(-2 * Math.PI * Math.min(f, sr * 0.45) / sr);

/** Trapezoidal SVF band-pass with unity peak gain, kicked by a rectangular pulse. */
class Drum {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.k = 1; this.a1 = 0; this.a2 = 0; this.a3 = 0; this.f = 100; }
  set(f, q, sr) {
    this.f = Math.min(f, sr * 0.45);
    const g = Math.tan(Math.PI * this.f / sr); this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }
  height(amp) { return amp / (2 * this.k * Math.max(Math.abs(Math.sin(Math.PI * this.f * 0.001)), 0.05)); }
  tick(x) {
    const v3 = x - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    return this.k * v1;
  }
}

export class Snare808 {
  /** @param {number} sr sample rate the voice runs at */
  constructor(sr, seed = 808) {
    const K = SNARE_808;
    this.sr = sr;
    this.noise = new XorShift32(seed);
    this.lo = new Drum(); this.hi = new Drum();
    this.pulseN = 0; this.hLo = 0; this.hHi = 0;
    this.eC = 0; this.eS = 0;
    this.att = Math.exp(-1 / (K.nAtt * sr));
    this.dec = 0; this.gLo = 0.5; this.gHi = 0.5;
    this.k = null;
    this.nA = onePoleA(K.nLp, sr); this.nz = 0;
    this.oA = onePoleA(K.outLp, sr); this.oz = 0;
    this.cA = onePoleA(1 / (2 * Math.PI * 27e3 * 0.01e-6), sr); this.cz = 0;
    this.hb = [0, 0, 0, 0, 0]; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
    this.vb = K.vb; this.pending = false;
  }

  /** Read the knobs once per block: {tone, snappy, decay, ndec, wires?} (0..1). */
  prepare(k) {
    const K = SNARE_808, sr = this.sr, o = this.k, wires = k.wires ?? 0.5;
    if (!o || k.tone !== o.tone) {
      // Tone pot 100k between the drums, its wiper loaded by 100k
      const t = clamp01(k.tone), R = 100e3, ra = Math.max(1, t * R), rb = Math.max(1, R - ra);
      const load = 100e3 / ((ra * rb) / R + 100e3);
      this.gLo = (rb / R) * load; this.gHi = (ra / R) * load;
    }
    if (!o || k.ndec !== o.ndec) this.dec = Math.exp(-1 / (K.nDec * span(k.ndec, 3) * sr));
    if (!o || wires !== o.wires) {
      const w = 2 * Math.PI * Math.min(K.wires * span(wires, 2), sr * 0.45) / sr;
      const cw = Math.cos(w), al = Math.sin(w) / (2 * K.wiresQ), a0 = 1 + al;
      this.hb = [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, -2 * cw / a0, (1 - al) / a0];
    }
    this.k = { tone: k.tone, snappy: k.snappy, decay: k.decay, ndec: k.ndec, wires };
  }

  /** velocity: 1 for a hit, 2 accented. */
  trigger(velocity) { this.pending = true; this.vb = velocity > 1 ? SNARE_808.vbAccent : SNARE_808.vb; }

  _start(pitch) {
    const K = SNARE_808, sr = this.sr, m = span(pitch, 1.5), d = span(this.k.decay, 3), vb = this.vb;
    this.lo.set(K.fLo * m, K.qLo * d, sr); this.hi.set(K.fHi * m, K.qHi * d, sr);
    this.hLo = this.lo.height(vb * K.kLo); this.hHi = this.hi.height(vb * K.kHi);
    this.pulseN = Math.max(1, Math.round(0.001 * sr));
    // the transistor's emitter: wiper volts minus a Vbe
    const s = clamp01(this.k.snappy);
    this.eC = Math.max(0, vb * (1e3 + 10e3 * s) / 11e3 - 0.6) * K.nK;
  }

  /** bal = SD_BAL (0 drum only .. 0.5 as built .. 1 snappy only), pitch = SD_PITCH. */
  tick(bal, pitch) {
    const K = SNARE_808;
    if (this.pending && this.k) { this.pending = false; this._start(pitch); }
    let xl = 0, xh = 0;
    if (this.pulseN > 0) { this.pulseN -= 1; xl = this.hLo; xh = this.hHi; }
    const b = clamp01(bal);
    const drum = (this.gLo * this.lo.tick(xl) + this.gHi * this.hi.tick(xh)) * Math.min(1, 2 - 2 * b);
    this.eC *= this.dec;
    this.eS = this.eC + (this.eS - this.eC) * this.att;
    let snap = 0;
    if (this.eS > 1e-6 || this.eC > 1e-6) {
      this.nz += this.nA * (this.noise.next() * this.eS - this.nz);
      const h = this.hb, x = this.nz;
      const y = h[0] * x + h[1] * this.x1 + h[2] * this.x2 - h[3] * this.y1 - h[4] * this.y2;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
      this.cz += this.cA * (y - this.cz);
      snap = (y - this.cz) * Math.min(1, 2 * b);
    }
    this.oz += this.oA * (drum + snap - this.oz);
    return this.oz * K.gain;
  }
}
