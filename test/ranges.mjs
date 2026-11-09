// Every parameter at both ends of its extended range keeps every voice finite and stable:
// all twelve voices are hit (plain and accented) and rendered for 4 seconds, and the engine's
// blow-up safety net must never have to reset a voice.
import { Engine, Params, PARAMS, RANGES, SWITCHES, VOICES } from '../index.js';

let failed = 0;
function run(label, values) {
  const e = new Engine(48000, new Params(values));
  const buf = new Float32Array(512);
  let finite = true, peak = 0;
  for (let b = 0; b < 375; b++) {
    if (b % 94 === 0) for (const v of VOICES) e.trigger(v, b % 188 === 0);
    e.render(buf);
    for (const m of e.meters) { if (!Number.isFinite(m)) finite = false; peak = Math.max(peak, m); }
  }
  const ok = finite && !e.resets;
  if (!ok) { failed++; console.log(`FAIL ${label}: finite=${finite} resets=${e.resets || 0} peak=${peak.toFixed(2)}`); }
}
let n = 0;
for (const { id } of PARAMS) {
  if (SWITCHES.includes(id)) continue;
  for (const end of ['min', 'max']) { run(`${id}=${RANGES[id][end]}`, { [id]: RANGES[id][end] }); n++; }
}
// everything at its max, then everything at its min
for (const end of ['min', 'max']) {
  run(`all ${end}`, Object.fromEntries(PARAMS.filter((p) => !SWITCHES.includes(p.id)).map((p) => [p.id, RANGES[p.id][end]])));
  n++;
}
console.log(`${n - failed}/${n} range checks passed`);
process.exit(failed ? 1 : 0);
