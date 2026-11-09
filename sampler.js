// Sample playback for comparing the synthesised voices with recordings of a TR-808.
// The Engine calls into a Sampler when a voice is switched to samples (engine.useSample[i] = 1).
//
// Sample names follow the set's convention: two letters, then one two-digit code per knob,
// where the code is the knob position 00, 25, 50, 75 or 10 (10 = fully clockwise).
// Each voice picks the recording whose knob positions are nearest to its current knobs.

import { sgnpow } from './voices/dsp.js';

const CODES = ['00', '25', '50', '75', '10'];
const code = (v) => CODES[Math.min(4, Math.max(0, Math.round(v * 4)))];

const LEVEL_DEFAULT = 0.5;
const level = (v) => sgnpow(v, 1.12);
const linear = (v) => v;
const clapLevel = (v) => v * v * 2.5;

/** Per voice index: which recording to play, and which knob sets its level. */
export const SAMPLE_MAP = {
  1: { vol: 'BD_VOL', law: level, name: (p) => 'BD' + code(p.get('BD_ATK')) + code(p.get('BD_DEC')) },
  2: { vol: 'SD_VOL', law: level, name: (p) => 'SD' + code(p.get('SD_TONE')) + code(p.get('SD_SNAPPY')) },
  3: { vol: 'LT_VOL', law: level, name: (p) => (p.get('LT_SW') > 0.5 ? 'LT' : 'LC') + code(p.get('LT_TUNE')) },
  4: { vol: 'MT_VOL', law: level, name: (p) => (p.get('MT_SW') > 0.5 ? 'MT' : 'MC') + code(p.get('MT_TUNE')) },
  5: { vol: 'HT_VOL', law: level, name: (p) => (p.get('HT_SW') > 0.5 ? 'HT' : 'HC') + code(p.get('HT_TUNE')) },
  6: { vol: 'RS_VOL', law: level, name: (p) => (p.get('RS_SW') > 0.5 ? 'CL' : 'RS') },
  7: { vol: 'HC_VOL', law: clapLevel, name: (p) => (p.get('HC_SW') > 0.5 ? 'MA' : 'CP') },
  8: { vol: 'CB_VOL', law: linear, name: () => 'CB' },
  9: { vol: 'RC_VOL', law: level, name: (p) => 'CY' + code(p.get('RC_TONE')) + code(p.get('RC_DEC')) },
  10: { vol: 'OH_VOL', law: level, name: (p) => 'OH' + code(p.get('OH_DEC')) },
  11: { vol: 'CH_VOL', law: level, name: () => 'CH' },
};

/** Every recording name the map can ask for (116 in the full set). */
export function sampleNames() {
  const names = [];
  for (const a of CODES) for (const b of CODES) names.push('BD' + a + b, 'SD' + a + b, 'CY' + a + b);
  for (const pre of ['LT', 'MT', 'HT', 'LC', 'MC', 'HC', 'OH']) for (const a of CODES) names.push(pre + a);
  names.push('RS', 'CL', 'CP', 'MA', 'CB', 'CH');
  return names;
}

export class Sampler {
  /**
   * @param {Record<string, {gain: number, accent: number}>} [calibration] per two-letter
   *   prefix ('BD', 'LC', ...): gain matches the recording at default knobs to the synth's
   *   loudness, accent is the synth's accented / normal loudness ratio.
   */
  constructor(calibration = {}) {
    this.banks = new Map();
    this.calibration = calibration;
    this.buf = new Array(12).fill(null);
    this.pos = new Float64Array(12);
    this.amp = new Float64Array(12);
    this.lv = new Float64Array(12);
  }

  /** @param {string} name e.g. 'BD2575' @param {Float32Array} data mono, at the engine's rate */
  load(name, data) { this.banks.set(name, data); }

  /** Start voice i; returns false when its recording isn't loaded. */
  trigger(i, accented, params) {
    const m = SAMPLE_MAP[i];
    if (!m) return false;
    const name = m.name(params);
    const data = this.banks.get(name);
    if (!data) return false;
    const cal = this.calibration[name.slice(0, 2)] ?? { gain: 1, accent: 1 };
    this.buf[i] = data;
    this.pos[i] = 0;
    this.amp[i] = cal.gain * (accented ? cal.accent : 1);
    if (i === 11) this.buf[10] = null; // closed hat chokes the open hat, as on the machine
    return true;
  }

  /** Stop voice i's sample (when the synth takes it over again). */
  stop(i) { this.buf[i] = null; }

  /** Read the level knobs; call once per render block. */
  prepare(params) {
    for (const [i, m] of Object.entries(SAMPLE_MAP)) {
      this.lv[i] = m.law(params.get(m.vol)) / m.law(LEVEL_DEFAULT);
    }
  }

  /** Next output sample: the sum of all playing samples. Updates peaks[i] per voice. */
  tick(peaks) {
    let sum = 0;
    const buf = this.buf;
    for (let i = 1; i < 12; i++) {
      const b = buf[i];
      if (!b) continue;
      const p = this.pos[i]++;
      if (p >= b.length) { buf[i] = null; continue; }
      const s = b[p] * this.amp[i] * this.lv[i];
      const a = Math.abs(s);
      if (a > peaks[i]) peaks[i] = a;
      sum += s;
    }
    return sum;
  }
}
