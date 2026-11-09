// Every voice (and each alternate mode) makes sound and stays finite and bounded.
// Mirrors the Rust test `every_voice_sounds_and_stays_bounded`.
import { Engine, Params, VOICES } from '../index.js';

let failed = 0;
function check(label, params, voice) {
  const e = new Engine(48000, params);
  e.trigger(voice, false);
  const buf = new Float32Array(48000 * 2);
  e.render(buf, 2);
  let peak = 0, finite = true;
  for (const x of buf) { if (!Number.isFinite(x)) finite = false; peak = Math.max(peak, Math.abs(x)); }
  const ok = finite && peak > 0.01 && peak <= 1;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(18)} peak ${peak.toFixed(3)}`);
}
for (const v of VOICES) check(v, new Params({ TRG_VOL: 0.5 }), v);
for (const [sw, v] of [['LT_SW', 'lowTom'], ['RS_SW', 'rim'], ['HC_SW', 'clap'], ['CB_SW', 'cowbell']]) {
  const p = new Params();
  p.set(sw, 1 - Params.defaultOf(sw));
  check(`alt ${v}`, p, v);
}
process.exit(failed ? 1 : 0);
