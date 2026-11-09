// Compares the JS voices against reference renders from the Rust app.
// Usage: node test/compare-rust.mjs <dir with *.bin files from the Rust harness>
import fs from 'node:fs';
import path from 'node:path';
import * as D from '../index.js';

D.SNARE_FIT.legacy = true; // the Rust app's snare, cymbal, clap, toms, rim shot, cowbell and bass drum, before fitting them to the 808 recordings
D.CYMBAL_FIT.legacy = true;
D.CLAP_FIT.legacy = true;
D.TOM_FIT.legacy = true;
D.RIM_FIT.legacy = true;
D.COWBELL_FIT.legacy = true;
D.BASS_FIT.legacy = true;

const dir = process.argv[2];
const load = (n) => { const b = fs.readFileSync(path.join(dir, n + '.bin')); return new Float64Array(b.buffer, b.byteOffset, b.length / 8); };
let worst = 0, fails = 0;
function cmp(name, js, tol = 1e-9) {
  const ref = load(name);
  let pk = 0, err = 0;
  for (let i = 0; i < ref.length; i++) { pk = Math.max(pk, Math.abs(ref[i])); err = Math.max(err, Math.abs(ref[i] - js[i])); }
  const rel = err / (pk || 1);
  const ok = rel <= tol && pk > 0;
  if (!ok) fails++;
  worst = Math.max(worst, rel);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(26)} peak ${pk.toExponential(3)}  max rel err ${rel.toExponential(2)}`);
}

for (const sr of [48000, 44100]) {
  const n = sr;
  for (const vel of [1, 2]) {
    const tag = `${sr}_${vel}`;
    const run = (f) => Float64Array.from({ length: n }, (_, i) => f(i));
    const b = new D.BassDrum(sr);
    cmp(`bd_${tag}`, run((i) => { if (i === 100) b.trigger(vel); return b.tick(0.3, 0.7, 0.6, 0.4, 0.8); }));
    const s = new D.Snare(sr);
    s.prepare({ tone: 0.3, snappy: 0.7, decay: 0.6, ndec: 0.4, color: 0.25 });
    cmp(`sd_${tag}`, run((i) => { if (i === 100) s.trigger(vel); return s.tick(0.4, 0.6); }));
    [D.LOW, D.MID, D.HIGH].forEach((spec, k) => {
      const t = new D.Tom(spec, sr, 0x1111 * (k + 1));
      cmp(`tom${k}_${tag}`, run((i) => { if (i === 100) t.trigger(vel, vel === 1); return t.tick(0.4, 0.6, 0.7, 0.3); }));
    });
    const r = new D.RimShot(sr);
    const rk = { tune: 0.4, dec: 0.6, osc1: 0.3, osc2: 0.7, flt: 0.2, res: 0.6 };
    cmp(`rs_${tag}`, run((i) => { if (i === 100) r.trigger(vel, vel === 1); return r.tick(rk); }));
    const mk = { duty: 0.4, volt: 0.6, cbPw: 0.3, cbTune: 0.7, cbO1: 0.45, cbO2: 0.55, cbFromHats: vel === 2 };
    const m = new D.Metal(sr), c = new D.Cowbell(sr), y = new D.Cymbal(sr), h = new D.Hats(sr);
    y.stretch = D.stretchFor(0.6);
    const vm = new Float64Array(n), vc = new Float64Array(n), vy = new Float64Array(n), vh = new Float64Array(n), vo = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (i === 100) { c.trigger(vel); y.trigger(vel); h.triggerClosed(vel); }
      if (i === 300) h.triggerOpen(vel);
      const o = m.tick(mk);
      vm[i] = o.hi + o.lo * 3 + o.cb1 * 5 + o.cb2 * 7;
      vc[i] = c.tick(o.cb1, o.cb2, 0.7, 0.4);
      vy[i] = y.tick(o.hi, o.lo, 0.7, 0.3, 0.6);
      const hh = h.tick(o.hi, 0.4, 0.6);
      vh[i] = hh.closed; vo[i] = hh.open;
    }
    cmp(`metal_${tag}`, vm); cmp(`cb_${tag}`, vc); cmp(`cy_${tag}`, vy); cmp(`ch_${tag}`, vh); cmp(`oh_${tag}`, vo);
  }
}

// Engine (the Rust mixer runs in f32, so the tolerance is looser)
const RUST_NAMES = ['Accent', 'Bass', 'Snare', 'LowTom', 'MidTom', 'HiTom', 'Rim', 'Clap', 'Cowbell', 'Cymbal', 'OpenHat', 'ClosedHat'];
const engine = (name, voice, acc, sw) => {
  const p = new D.Params({ TRG_VOL: 0.5, AC_LEVEL: 0.6, DRIVE: 0.3, MAIN_VCA: 1 });
  if (sw) p.set(sw, 1 - D.Params.defaultOf(sw));
  const e = new D.Engine(48000, p, { oversample: 1 });
  e.trigger(voice, acc);
  const out = new Float32Array(48000);
  for (let o = 0; o < out.length; o += 512) e.render(out.subarray(o, Math.min(o + 512, out.length)), 1);
  cmp(name, out, 2e-4);
};
D.VOICES.forEach((v, i) => { for (const acc of [0, 1]) engine(`eng_${RUST_NAMES[i]}_${acc}`, v, !!acc); });
for (const [sw, v] of [['LT_SW', 'lowTom'], ['RS_SW', 'rim'], ['HC_SW', 'clap'], ['CB_SW', 'cowbell']]) {
  engine(`eng_alt_${RUST_NAMES[D.VOICE_INDEX[v]]}`, v, false, sw);
}
console.log(`\n${fails ? fails + ' FAILED' : 'all match'}; worst relative error ${worst.toExponential(2)}`);
process.exit(fails ? 1 : 0);
