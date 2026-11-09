// Works out how loud to play each 808 recording so that, at default knob settings, it matches
// the synthesised voice's loudness (RMS over the first 150 ms of the hit). Writes
// samples/808/calibration.json, which the webpage loads. Run: node test/calibrate-samples.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { Engine, Params, DEFAULTS, Sampler, SAMPLE_MAP } from '../index.js';

const SR = 44100;
const root = new URL('../samples/808/', import.meta.url);

/** minimal reader for 16-bit mono PCM WAV */
export function readWav(path) {
  const b = readFileSync(path);
  let o = 12, fmt = null;
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4), len = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') {
      if (!fmt || fmt.ch !== 1 || fmt.bits !== 16) throw new Error(`${path}: expected 16-bit mono`);
      const n = Math.floor(Math.min(len, b.length - o - 8) / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(o + 8 + 2 * i) / 32768;
      return { sr: fmt.sr, data: out };
    }
    o += 8 + len + (len & 1);
  }
  throw new Error(`${path}: no data chunk`);
}

// prefix → [voice index, switch overrides]
const PREFIXES = {
  BD: [1, {}], SD: [2, {}],
  LT: [3, { LT_SW: 1 }], MT: [4, { MT_SW: 1 }], HT: [5, { HT_SW: 1 }],
  LC: [3, { LT_SW: 0 }], MC: [4, { MT_SW: 0 }], HC: [5, { HT_SW: 0 }],
  RS: [6, { RS_SW: 0 }], CL: [6, { RS_SW: 1 }], CP: [7, { HC_SW: 0 }], MA: [7, { HC_SW: 1 }],
  CB: [8, {}], CY: [9, {}], OH: [10, {}], CH: [11, {}],
};

const WIN = Math.round(0.15 * SR);
function loudness(voice, accented, values, sampler) {
  const e = new Engine(SR, new Params({ ...DEFAULTS, ...values }));
  if (sampler) { e.sampler = sampler; e.useSample[voice] = 1; }
  const buf = new Float32Array(WIN);
  e.render(new Float32Array(64), 1); // let level smoothing settle
  e.trigger(voice, accented);
  e.render(buf, 1);
  let s = 0;
  for (const x of buf) s += x * x;
  return Math.sqrt(s / WIN);
}

const cal = {};
for (const [prefix, [voice, sw]] of Object.entries(PREFIXES)) {
  const params = new Params({ ...DEFAULTS, ...sw });
  const name = SAMPLE_MAP[voice].name(params);
  if (name.slice(0, 2) !== prefix) throw new Error(`${prefix}: map picked ${name}`);
  const { sr, data } = readWav(new URL(`${prefix}/${name}.WAV`, root));
  if (sr !== SR) throw new Error(`${name}: ${sr} Hz`);
  const sampler = new Sampler({});
  sampler.load(name, data);
  const synth = loudness(voice, false, sw);
  const synthAcc = loudness(voice, true, sw);
  const rec = loudness(voice, false, sw, sampler);
  cal[prefix] = { gain: +(synth / rec).toPrecision(4), accent: +(synthAcc / synth).toPrecision(4) };
  console.log(prefix.padEnd(3), name.padEnd(7), 'gain', cal[prefix].gain, 'accent', cal[prefix].accent);
}
writeFileSync(new URL('calibration.json', root), JSON.stringify(cal, null, 2) + '\n');
