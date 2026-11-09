// The twelve-voice mixer (port of Engine in app/src/synth.rs): triggers, per-voice levels,
// master drive / VCA / 42 Hz high-pass / volume, and per-voice peak meters.

import { Params } from './params.js';
import { Metal } from './voices/metal.js';
import { BassDrum } from './voices/bass-drum.js';
import { Snare } from './voices/snare.js';
import { Tom, LOW, MID, HIGH } from './voices/tom.js';
import { RimShot } from './voices/rimshot.js';
import { Clap } from './voices/clap.js';
import { Cowbell } from './voices/cowbell.js';
import { Cymbal, stretchFor } from './voices/cymbal.js';
import { Hats } from './voices/hats.js';
import { sgnpow } from './voices/dsp.js';

export const VOICES = [
  'accent', 'bass', 'snare', 'lowTom', 'midTom', 'hiTom',
  'rim', 'clap', 'cowbell', 'cymbal', 'openHat', 'closedHat',
];
export const VOICE_INDEX = Object.freeze(Object.fromEntries(VOICES.map((v, i) => [v, i])));

export const SAT_GAIN = 1.17647;
export const OUT_HP_HZ = 42.0;
// Output scales calibrated so each voice's peak matches the original at default settings.
const BD_POST_GAIN = 0.0625;
const SD_COLOR = 0.25; // hidden SD_COLOR default
const SD_POST_GAIN = 0.069;
const TOM_POST_GAIN = [0.0513, 0.0457, 0.0393];
const RS_POST_GAIN = 0.0473;
const CB_POST_GAIN = 0.0446;
const RC_POST_GAIN = 0.01174;
const HAT_POST_GAIN = [0.039, 0.0462]; // [closed, open]

const TOM_KEYS = [
  ['LT_VOL', 'LT_TUNE', 'LT_DEC', 'LT_ATK', 'LT_FLT', 'LT_SW'],
  ['MT_VOL', 'MT_TUNE', 'MT_DEC', 'MT_ATK', 'MT_FLT', 'MT_SW'],
  ['HT_VOL', 'HT_TUNE', 'HT_DEC', 'HT_ATK', 'HT_FLT', 'HT_SW'],
];

export class Engine {
  /** @param {number} sr sample rate  @param {Params} [params] */
  constructor(sr, params = new Params()) {
    this.sr = sr;
    this.params = params;
    this.accent = { left: 0, amp: 0 };
    this.bass = new BassDrum(sr);
    this.snare = new Snare(sr);
    this.toms = [new Tom(LOW, sr, 0x1111), new Tom(MID, sr, 0x2222), new Tom(HIGH, sr, 0x3333)];
    this.rim = new RimShot(sr);
    this.clap = new Clap(sr, 0x12345678);
    this.cowbell = new Cowbell(sr);
    this.metal = new Metal(sr);
    this.cymbal = new Cymbal(sr);
    this.hats = new Hats(sr);
    this.gains = new Float64Array(12).fill(1);
    this.hpX = 0; this.hpY = 0;
    this.hpR = Math.exp(-2 * Math.PI * OUT_HP_HZ / sr);
    /** decaying peak per voice, updated once per render() */
    this.meters = new Float32Array(12);
    this._v = new Float64Array(12);
    this._peaks = new Float64Array(12);
  }

  /** @param {string|number} voice  name from VOICES or its index  @param {boolean} accented */
  trigger(voice, accented = false) {
    const i = typeof voice === 'number' ? voice : VOICE_INDEX[voice];
    if (i === undefined) throw new Error(`unknown voice ${voice}`);
    const p = this.params;
    const sr = this.sr;
    const vel = accented ? 2 : 1;
    this.gains[i] = accented ? 1 + 1.5 * p.get('AC_LEVEL') : 1;
    switch (i) {
      case 0: // trigger-out pulse: width 0.5..20 ms
        this.accent.left = (0.0005 + p.get('TRG_WIDTH') * 0.0195) * sr;
        this.accent.amp = 1;
        break;
      case 1: this.bass.trigger(vel); this.gains[i] = 1; break;
      case 2: this.snare.trigger(vel); this.gains[i] = 1; break;
      case 3: case 4: case 5:
        this.toms[i - 3].trigger(vel, p.get(TOM_KEYS[i - 3][5]) > 0.5);
        this.gains[i] = 1;
        break;
      case 6: // RS_SW 0 = rim shot, 1 = claves
        this.rim.trigger(vel, p.get('RS_SW') < 0.5);
        this.gains[i] = 1;
        break;
      case 7:
        this.clap.trigger({
          maracas: p.get('HC_SW') > 0.5,
          offset: p.get('HC_OFFSET'),
          clps: p.get('HC_CLPS'),
          dec: p.get('HC_DEC'),
          tail: p.get('HC_TAIL'),
          rev: p.get('HC_REV'),
          flt: p.get('HC_FLT'),
        });
        break;
      case 8: this.cowbell.trigger(vel); this.gains[i] = 1; break;
      case 9: this.cymbal.trigger(vel); this.gains[i] = 1; break;
      case 10: this.hats.triggerOpen(vel); this.gains[i] = 1; break;
      case 11: this.hats.triggerClosed(vel); this.gains[i] = 1; break;
    }
  }

  /** Rebuild one voice's DSP state (used when extreme settings make it unstable). */
  _resetVoice(i) {
    const sr = this.sr;
    this.resets = (this.resets || 0) + 1;
    switch (i) {
      case 1: this.bass = new BassDrum(sr); break;
      case 2: this.snare = new Snare(sr); break;
      case 3: case 4: case 5:
        this.toms[i - 3] = new Tom([LOW, MID, HIGH][i - 3], sr, 0x1111 * (i - 2)); break;
      case 6: this.rim = new RimShot(sr); break;
      case 7: this.clap = new Clap(sr, 0x12345678); break;
      case 8: this.cowbell = new Cowbell(sr); this.metal = new Metal(sr); break;
      case 9: this.cymbal = new Cymbal(sr); this.metal = new Metal(sr); break;
      case 10: case 11: this.hats = new Hats(sr); this.metal = new Metal(sr); break;
    }
  }

  /**
   * Fill `out` (Float32Array). With channels > 1 the buffer is interleaved and every
   * channel gets the same mono signal. Pass channels = 1 for a mono buffer.
   */
  render(out, channels = 1) {
    const p = this.params;
    const lvl = (id) => { const v = p.get(id); return v * v * 2.5; };
    const trgLevel = lvl('TRG_VOL');
    const hcLevel = lvl('HC_VOL');
    const drive = p.get('DRIVE');
    const mm = p.get('MST_VOL') * 2;
    const master = mm * mm * 0.9;
    const vca = p.get('MAIN_VCA') > 0.5;
    const peaks = this._peaks.fill(0);
    const v = this._v;
    const gains = this.gains;

    this.snare.prepare({
      tone: p.get('SD_TONE'), snappy: p.get('SD_SNAPPY'), decay: p.get('SD_DECAY'),
      ndec: p.get('SD_NDEC'), modelHi: p.get('SD_SW') > 0.5, color: SD_COLOR,
    });
    const bd = [p.get('BD_TUNE'), p.get('BD_ATK'), p.get('BD_DEC'), p.get('BD_PAMT'), p.get('BD_VOL')];
    const sdBal = p.get('SD_BAL'), sdPitch = p.get('SD_PITCH');
    const sdLevel = sgnpow(p.get('SD_VOL'), 1.12) * SD_POST_GAIN;
    const tomK = TOM_KEYS.map((k, i) => ({
      lv: sgnpow(p.get(k[0]), 1.12) * TOM_POST_GAIN[i],
      tune: p.get(k[1]), dec: p.get(k[2]), atk: p.get(k[3]), flt: p.get(k[4]),
    }));
    const rimKnobs = {
      tune: p.get('RS_TUNE'), dec: p.get('RS_DEC'), osc1: p.get('RS_OSC1'),
      osc2: p.get('RS_OSC2'), flt: p.get('RS_FLT'), res: p.get('RS_RES'),
    };
    const rsLevel = sgnpow(p.get('RS_VOL'), 1.12) * RS_POST_GAIN;
    const metalKnobs = {
      duty: p.get('DUTY'), volt: p.get('VOLT'), cbPw: p.get('CB_PW'), cbTune: p.get('CB_TUNE'),
      cbO1: p.get('CB_O1'), cbO2: p.get('CB_O2'), cbFromHats: p.get('CB_SW') > 0.5,
    };
    const cbVol = p.get('CB_VOL'), cbDec = p.get('CB_DEC');
    const rcVol = p.get('RC_VOL'), rcTone = p.get('RC_TONE'), rcDec = p.get('RC_DEC');
    const chDec = p.get('CH_DEC'), ohDec = p.get('OH_DEC');
    const ohLevel = sgnpow(p.get('OH_VOL'), 1.12) * HAT_POST_GAIN[1];
    const chLevel = sgnpow(p.get('CH_VOL'), 1.12) * HAT_POST_GAIN[0];
    this.cymbal.stretch = stretchFor(rcDec);

    const frames = Math.floor(out.length / channels);
    for (let f = 0; f < frames; f++) {
      // accent / trigger-out pulse
      v[0] = 0;
      if (this.accent.left > 0) { this.accent.left -= 1; v[0] = this.accent.amp * 0.8; }

      v[1] = this.bass.tick(bd[0], bd[1], bd[2], bd[3], bd[4]) * BD_POST_GAIN;
      v[2] = this.snare.tick(sdBal, sdPitch) * sdLevel;
      for (let i = 0; i < 3; i++) {
        const t = tomK[i];
        v[3 + i] = this.toms[i].tick(t.tune, t.dec, t.atk, t.flt) * t.lv;
      }
      v[6] = this.rim.tick(rimKnobs) * rsLevel;
      v[7] = this.clap.tick();
      const mo = this.metal.tick(metalKnobs);
      v[8] = this.cowbell.tick(mo.cb1, mo.cb2, cbVol, cbDec) * CB_POST_GAIN;
      v[9] = this.cymbal.tick(mo.hi, mo.lo, rcVol, rcTone, rcDec) * RC_POST_GAIN;
      const hats = this.hats.tick(mo.hi, chDec, ohDec);
      v[10] = hats.open * ohLevel;
      v[11] = hats.closed * chLevel;

      // safety net for extreme knob settings: a voice that blows up is reset instead of
      // leaving the whole kit stuck on NaN
      for (let i = 1; i < 12; i++) {
        if (!(Math.abs(v[i]) < 1e4)) { this._resetVoice(i); v[i] = 0; }
      }

      let sum = 0;
      for (let i = 0; i < 12; i++) {
        const level = i === 0 ? trgLevel : i === 7 ? hcLevel : 1;
        const s = v[i] * level * gains[i];
        const a = Math.abs(s);
        if (a > peaks[i]) peaks[i] = a;
        sum += s;
      }

      // master: drive, VCA mode, output high-pass, volume
      let y = sum * 0.5;
      if (drive > 0) {
        const g = 1 + drive * 9;
        y = Math.tanh(y * g * SAT_GAIN) / Math.max(Math.tanh(g * SAT_GAIN), 0.3);
      }
      if (vca) y = Math.tanh(y * 1.5);
      const hp = y - this.hpX + this.hpR * this.hpY;
      this.hpX = y;
      this.hpY = hp;
      const o = Math.min(Math.max(hp * master, -1), 1);
      for (let c = 0; c < channels; c++) out[f * channels + c] = o;
    }

    for (let i = 0; i < 12; i++) this.meters[i] = Math.max(this.meters[i] * 0.8, peaks[i]);
  }
}
