// Open and closed hi-hats laid out like the TR-808's hi-hat circuits, with the constants fitted
// to a component-level simulation of those circuits and to recordings of a real TR-808
// (samples/808/OH and CH).
//
// Both hats take the six metal oscillators through a bridged-T band-pass (about 5.1 kHz for the
// open hat, 7 kHz for the closed one, which also has a lower Q). Each hat
// has a "swing" VCA: the band signal pulls the transistor's collector down, but never below the
// envelope, so the output is the signal chopped by the envelope. With a finite gain the chopping
// only starts once the envelope has fallen below the signal swing, which gives the hats their
// fast-then-faster decay. A Sallen-Key high-pass (from the parts) and the mixer's roll-off follow.
//   open:   the envelope capacitor charges through a resistor (a soft onset) and leaks slowly;
//           when the decay timer (set by DECAY) runs out, a transistor dumps it. The closed hat
//           dumps it the same way (the choke).
//   closed: the envelope capacitor is charged by the hit and discharges into the VCA.
//
// Knobs, centred = as built: OH_DEC sets when the open hat is cut off, CH_DEC scales the closed
// hat's envelope (x1/3 .. x3); tone (OH_TONE / CH_TONE) moves each hat's high-pass (x0.5 .. x2).

/** legacy: true uses the Rust app's hats (voices/hats.js) instead; read when the Engine is built. */
export const HATS_FIT = { legacy: false };

/** Fitted constants (times in seconds, frequencies in Hz). */
export const HATS_808 = {
  oh: { bpF: 5096, bpQ: 5.844, vca: 13.75, e: 0.3081, att: 0.0121, dec: 0.2311, cut0: 0.03961, cut5: 0.6256, cut1: 1.066, dump: 0.009703, hpF: 7830, hpQ: 7.28, lp: 8084, gain: 17.6 },
  ch: { bpF: 7033, bpQ: 1.699, vca: 40.63, e: 0.3817, att: 0.002217, dec: 0.01497, hpF: 11746, hpQ: 2.351, lp: 13904, gain: 44.5 },
  in: 1,       // metal bank sum into the band-pass
  accent: 2,
};

const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
const span = (v, s) => s ** ((clamp01(v) - 0.5) * 2);
const map3 = (p, lo, mid, hi) => (p < 0.5 ? lo * (mid / lo) ** (2 * p) : mid * (hi / mid) ** (2 * p - 1));

class Hat {
  constructor(sr, F) {
    this.sr = sr; this.F = F;
    const g = Math.tan(Math.PI * Math.min(F.bpF, sr * 0.45) / sr), k = 1 / F.bpQ;
    this.k = k; this.a1 = 1 / (1 + g * (g + k)); this.a2 = g * this.a1; this.a3 = g * this.a2; this.ic1 = 0; this.ic2 = 0;
    this.aK = Math.exp(-1 / (F.att * sr));
    this.dK = Math.exp(-1 / (F.dec * sr)); this.decK = this.dK;
    this.dumpK = F.dump ? Math.exp(-1 / (F.dump * sr)) : 0;
    this.lA = 1 - Math.exp(-2 * Math.PI * Math.min(F.lp, sr * 0.45) / sr); this.lz = 0;
    this.hb = [0, 0, 0, 0, 0]; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; this._tone = NaN;
    this.eC = 0; this.e = 0; this.t = 1e9; this.cutN = Infinity;
  }
  setTone(tone) {
    if (tone === this._tone) return;
    this._tone = tone;
    const F = this.F, sr = this.sr, w = 2 * Math.PI * Math.min(F.hpF * span(tone, 2), sr * 0.45) / sr;
    const cw = Math.cos(w), al = Math.sin(w) / (2 * F.hpQ), a0 = 1 + al;
    this.hb = [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, -2 * cw / a0, (1 - al) / a0];
  }
  fire(amp, decSec, cutSec) {
    this.eC = amp * this.F.e; this.t = 0;
    this.dK = Math.exp(-1 / (decSec * this.sr));
    this.cutN = cutSec === Infinity ? Infinity : Math.round(cutSec * this.sr);
  }
  choke() { this.dK = this.dumpK; this.cutN = Infinity; }
  tick(x) {
    // the band-pass keeps running between hits
    const v3 = x - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    const b = this.k * v1;
    if (this.t++ === this.cutN) this.dK = this.dumpK;
    this.eC *= this.dK;
    this.e = this.eC + (this.e - this.eC) * this.aK;
    if (this.e < 1e-6 && this.eC < 1e-6 && Math.abs(this.lz) < 1e-7) return 0;
    const pull = b > 0 ? b * this.F.vca : 0;
    const v = -(pull < this.e ? pull : this.e);
    const h = this.hb, y = h[0] * v + h[1] * this.x1 + h[2] * this.x2 - h[3] * this.y1 - h[4] * this.y2;
    this.x2 = this.x1; this.x1 = v; this.y2 = this.y1; this.y1 = y;
    this.lz += this.lA * (y - this.lz);
    return this.lz * this.F.gain;
  }
}

export class Hats808 {
  /** @param {number} sr  sample rate the voice runs at  @param {number} [os] oversampling factor included in sr */
  constructor(sr, os = 1) {
    this.sr = sr;
    this.open = new Hat(sr, HATS_808.oh); this.closed = new Hat(sr, HATS_808.ch);
    this.open.setTone(0.5); this.closed.setTone(0.5);
    this.pendO = 0; this.pendC = 0;
    this.out = { open: 0, closed: 0 };
  }
  triggerClosed(value) { this.pendC = value > 1 ? HATS_808.accent : 1; }
  triggerOpen(value) { this.pendO = value > 1 ? HATS_808.accent : 1; }

  /** raw: Metal.tick().raw (the six oscillators' sum). chDec, ohDec: CH_DEC, OH_DEC. */
  tick(raw, chDec, ohDec, chTone = 0.5, ohTone = 0.5) {
    const K = HATS_808;
    if (this.pendC) {
      this.closed.fire(this.pendC, K.ch.dec * span(chDec, 3), Infinity);
      this.open.choke();
      this.pendC = 0;
    }
    if (this.pendO) {
      this.open.fire(this.pendO, K.oh.dec, map3(clamp01(ohDec), K.oh.cut0, K.oh.cut5, K.oh.cut1));
      this.pendO = 0;
    }
    this.open.setTone(ohTone); this.closed.setTone(chTone);
    const x = raw * K.in;
    this.out.open = this.open.tick(x);
    this.out.closed = this.closed.tick(x);
    return this.out;
  }
}
