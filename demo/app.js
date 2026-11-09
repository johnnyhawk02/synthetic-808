// The demo page: pads, knobs and a 16-step sequencer driving the drum engine in an AudioWorklet.
import { DEFAULTS, RANGES } from '../params.js';
import { VOICE_INDEX } from '../engine.js';

// Panel layout: voice → knobs [param, label] and optional switch [param, offLabel, onLabel].
const COLUMNS = [
  { voice: 'bass', name: 'Bass drum', key: 'a', knobs: [['BD_VOL', 'Level'], ['BD_TUNE', 'Tune'], ['BD_DEC', 'Decay'], ['BD_ATK', 'Tone'], ['BD_PAMT', 'P.Amt']] },
  { voice: 'snare', name: 'Snare', key: 's', knobs: [['SD_VOL', 'Level'], ['SD_TONE', 'Tone'], ['SD_SNAPPY', 'Snappy'], ['SD_DECAY', 'Dec'], ['SD_NDEC', 'N.Dec'], ['SD_BAL', 'Tilt'], ['SD_PITCH', 'Pitch']], sw: ['SD_SW', 'Lo', 'Hi'] },
  { voice: 'lowTom', name: 'Low tom', alt: 'Low conga', key: 'd', knobs: [['LT_VOL', 'Level'], ['LT_TUNE', 'Tune'], ['LT_DEC', 'Dec'], ['LT_ATK', 'Rev'], ['LT_FLT', 'Flt']], sw: ['LT_SW', 'Conga', 'Tom'] },
  { voice: 'midTom', name: 'Mid tom', alt: 'Mid conga', key: 'f', knobs: [['MT_VOL', 'Level'], ['MT_TUNE', 'Tune'], ['MT_DEC', 'Dec'], ['MT_ATK', 'Rev'], ['MT_FLT', 'Flt']], sw: ['MT_SW', 'Conga', 'Tom'] },
  { voice: 'hiTom', name: 'Hi tom', alt: 'Hi conga', key: 'g', knobs: [['HT_VOL', 'Level'], ['HT_TUNE', 'Tune'], ['HT_DEC', 'Dec'], ['HT_ATK', 'Rev'], ['HT_FLT', 'Flt']], sw: ['HT_SW', 'Conga', 'Tom'] },
  { voice: 'rim', name: 'Rim shot', alt: 'Claves', key: 'h', knobs: [['RS_VOL', 'Level'], ['RS_TUNE', 'Tune'], ['RS_DEC', 'Dec'], ['RS_OSC1', 'Osc 1'], ['RS_OSC2', 'Osc 2'], ['RS_FLT', 'Tone'], ['RS_RES', 'Res']], sw: ['RS_SW', 'Rim', 'Claves'] },
  { voice: 'clap', name: 'Hand clap', alt: 'Maracas', key: 'j', knobs: [['HC_VOL', 'Level'], ['HC_OFFSET', 'Offs'], ['HC_CLPS', 'Clps'], ['HC_DEC', 'Dec'], ['HC_TAIL', 'Tail'], ['HC_REV', 'Rev'], ['HC_FLT', 'R.Flt']], sw: ['HC_SW', 'Clap', 'Maracas'] },
  { voice: 'cowbell', name: 'Cowbell', key: 'k', knobs: [['CB_VOL', 'Level'], ['CB_DEC', 'Dec'], ['CB_TUNE', 'Tune'], ['CB_PW', 'PW'], ['CB_O1', 'Osc 1'], ['CB_O2', 'Osc 2']], sw: ['CB_SW', 'CB', 'HH'] },
  { voice: 'cymbal', name: 'Cymbal', key: 'l', knobs: [['RC_VOL', 'Level'], ['RC_TONE', 'Tone'], ['RC_DEC', 'Dec']] },
  { voice: 'openHat', name: 'Open hat', key: ';', knobs: [['OH_VOL', 'Level'], ['OH_DEC', 'Dec'], ['DUTY', 'Duty']] },
  { voice: 'closedHat', name: 'Closed hat', key: "'", knobs: [['CH_VOL', 'Level'], ['CH_DEC', 'Dec'], ['VOLT', 'Volt']] },
  { voice: null, name: 'Master', knobs: [['MST_VOL', 'Volume'], ['DRIVE', 'Drive'], ['AC_LEVEL', 'Accent']], sw: ['MAIN_VCA', 'Clean', 'VCA'] },
];
const SEQ_VOICES = COLUMNS.filter((c) => c.voice).map((c) => c.voice);

const PRESETS = {
  basic: {
    bass: 'X.....x.X.....x.', snare: '....X.......X...', closedHat: 'x.x.x.x.x.x.x.x.',
    openHat: '..............x.', clap: '............x...',
  },
  electro: {
    bass: 'X......x..x.....', snare: '....X.......X..x', closedHat: 'x.xxx.xxx.xxx.xX',
    clap: '....x.......x...', cowbell: '......x.......x.', lowTom: '..........x.....', midTom: '...........x....',
  },
  latin: {
    bass: 'X..x..x.X..x..x.', rim: 'x..x...x..x.x...', cowbell: 'X.x.X.xxX.x.X.xx',
    lowTom: '......x.......x.', hiTom: '..x.......x.....', closedHat: 'x.x.x.x.x.x.x.x.', clap: 'x.........x.....',
  },
  clear: {},
};

// ---- defaults ----
// Library defaults (params.js), overridden by demo/defaults.json (committed to the repo),
// overridden by whatever this browser saved with "Save as default".
const STORE_KEY = 'synthetic808.defaults.v1';
let repoDefaults = {};
try {
  const r = await fetch(new URL('./defaults.json', import.meta.url), { cache: 'no-cache' });
  if (r.ok) repoDefaults = clean(await r.json());
} catch { /* no repo defaults */ }
function readSaved() {
  try { return clean(JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); } catch { return {}; }
}
/** keep only known parameter ids with numeric values, clamped to their range */
function clean(obj) {
  const out = {};
  for (const [id, v] of Object.entries(obj || {})) {
    if (id in DEFAULTS && typeof v === 'number' && Number.isFinite(v)) {
      out[id] = Math.min(Math.max(v, RANGES[id].min), RANGES[id].max);
    }
  }
  return out;
}
const factoryDefaults = () => ({ ...DEFAULTS, ...repoDefaults });
let defaults = { ...factoryDefaults(), ...readSaved() };

// ---- state ----
const params = { ...defaults };
const controls = {}; // id → set(value) for every knob and switch
let pattern = Array.from({ length: 16 }, () => new Array(12).fill(0));
let ctx = null, node = null, playing = false;

function send(msg) { if (node) node.port.postMessage(msg); }

async function ensureAudio() {
  if (ctx) { if (ctx.state !== 'running') await ctx.resume(); return; }
  ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule(new URL('../worklet.js', import.meta.url));
  node = new AudioWorkletNode(ctx, 'drum-voices', { outputChannelCount: [2], processorOptions: { params } });
  node.connect(ctx.destination);
  node.port.onmessage = ({ data }) => {
    if (data.type === 'meters') showMeters(data.meters);
    else if (data.type === 'step') showStep(data.step);
  };
  sendPattern();
  send({ type: 'transport', bpm: +bpmInput.value, swing: +swingInput.value });
  if (ctx.state !== 'running') await ctx.resume();
}

// ---- knobs ----
function makeKnob(id, label) {
  const wrap = document.createElement('div');
  wrap.className = 'knob';
  const dial = document.createElement('div');
  dial.className = 'dial';
  dial.tabIndex = 0;
  dial.setAttribute('role', 'slider');
  dial.setAttribute('aria-label', label);
  dial.setAttribute('aria-valuemin', '0');
  dial.setAttribute('aria-valuemax', '100');
  const lab = document.createElement('label');
  lab.textContent = label;
  const val = document.createElement('output');
  wrap.append(dial, lab, val);

  const { min, max } = RANGES[id];
  const span = max - min;
  dial.setAttribute('aria-valuemin', String(min));
  dial.setAttribute('aria-valuemax', String(max));
  // arc marking the 0..1 range on the dial's 270° sweep
  const a0 = -135 + ((0 - min) / span) * 270, a1 = -135 + ((1 - min) / span) * 270;
  dial.style.setProperty('--a0', `${a0}deg`);
  dial.style.setProperty('--a1', `${a1 - a0}deg`);
  const set = (v) => {
    v = Math.min(Math.max(v, min), max);
    v = Math.round(v * 1000) / 1000;
    params[id] = v;
    dial.style.setProperty('--rot', `${-135 + ((v - min) / span) * 270}deg`);
    dial.setAttribute('aria-valuenow', String(v));
    dial.title = `${label}: ${v.toFixed(2)} (range ${min} to ${max}; double-click for default)`;
    val.textContent = v.toFixed(2);
    wrap.classList.toggle('out', v < 0 || v > 1);
    wrap.classList.toggle('changed', Math.abs(v - defaults[id]) > 1e-9);
    send({ type: 'param', id, value: v });
  };
  controls[id] = set;
  set(params[id]);

  let startY = 0, startV = 0;
  dial.addEventListener('pointerdown', (e) => {
    dial.setPointerCapture(e.pointerId);
    startY = e.clientY; startV = params[id];
    e.preventDefault();
  });
  dial.addEventListener('pointermove', (e) => {
    if (!dial.hasPointerCapture(e.pointerId)) return;
    const px = e.shiftKey ? 600 : 150; // pixels per 0..1
    set(startV + (startY - e.clientY) / px);
  });
  dial.addEventListener('dblclick', () => set(defaults[id]));
  dial.addEventListener('wheel', (e) => { e.preventDefault(); set(params[id] - Math.sign(e.deltaY) * 0.02); }, { passive: false });
  dial.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { set(params[id] + step); e.preventDefault(); e.stopPropagation(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { set(params[id] - step); e.preventDefault(); e.stopPropagation(); }
  });
  return wrap;
}

function makeSwitch([id, off, on], onChange) {
  const el = document.createElement('div');
  el.className = 'switch';
  const bOff = document.createElement('button');
  const bOn = document.createElement('button');
  bOff.textContent = off; bOn.textContent = on;
  const set = (v) => {
    params[id] = v;
    bOff.setAttribute('aria-pressed', String(v < 0.5));
    bOn.setAttribute('aria-pressed', String(v >= 0.5));
    send({ type: 'param', id, value: v });
    onChange?.(v >= 0.5);
  };
  controls[id] = set;
  bOff.onclick = () => set(0);
  bOn.onclick = () => set(1);
  el.append(bOff, bOn);
  set(params[id]);
  return el;
}

// ---- panel ----
const panel = document.getElementById('panel');
const pads = {};
for (const col of COLUMNS) {
  const box = document.createElement('div');
  box.className = 'voice';
  const h = document.createElement('h3');
  const title = document.createElement('span');
  title.textContent = col.name;
  h.append(title);
  if (col.key) {
    const k = document.createElement('kbd');
    k.className = 'key';
    k.textContent = col.key.toUpperCase();
    h.append(k);
  }
  box.append(h);
  if (col.voice) {
    const pad = document.createElement('button');
    pad.className = 'pad';
    const span = document.createElement('span');
    span.textContent = col.name;
    pad.append(span);
    pad.addEventListener('pointerdown', (e) => { hit(col.voice, e.shiftKey); });
    pads[col.voice] = { pad, span, col };
    box.append(pad);
  }
  const knobs = document.createElement('div');
  knobs.className = 'knobs';
  for (const [id, label] of col.knobs) knobs.append(makeKnob(id, label));
  box.append(knobs);
  if (col.sw) {
    box.append(makeSwitch(col.sw, (on) => {
      if (!col.alt) return;
      // tom switch: on = tom; rim/clap switch: on = alternate voice
      const isAlt = col.sw[0].endsWith('T_SW') ? !on : on;
      const label = isAlt ? col.alt : col.name;
      title.textContent = label;
      if (pads[col.voice]) pads[col.voice].span.textContent = label;
      const row = document.querySelector(`.name[data-voice="${col.voice}"]`);
      if (row) row.textContent = label;
    }));
  }
  panel.append(box);
}

async function hit(voice, accent) {
  await ensureAudio();
  send({ type: 'trigger', voice, accent });
}

function showMeters(m) {
  for (const [voice, p] of Object.entries(pads)) {
    const level = Math.min(1, m[VOICE_INDEX[voice]] * 6);
    p.pad.style.setProperty('--lit', (level * 0.85).toFixed(3));
  }
}

// ---- sequencer ----
const seq = document.getElementById('seq');
const cells = [];
for (const voice of SEQ_VOICES) {
  const col = COLUMNS.find((c) => c.voice === voice);
  const name = document.createElement('div');
  name.className = 'name';
  name.dataset.voice = voice;
  name.textContent = col.name;
  seq.append(name);
  const vi = VOICE_INDEX[voice];
  for (let s = 0; s < 16; s++) {
    const c = document.createElement('button');
    c.className = 'cell' + (s % 4 === 0 ? ' beat' : '');
    c.setAttribute('aria-label', `${col.name} step ${s + 1}`);
    c.dataset.v = '0';
    c.onclick = () => {
      pattern[s][vi] = (pattern[s][vi] + 1) % 3;
      c.dataset.v = String(pattern[s][vi]);
      sendPattern();
    };
    (cells[s] ||= []).push(c);
    seq.append(c);
  }
}
// re-apply the switch labels to the sequencer rows now they exist
for (const col of COLUMNS) {
  if (col.alt && col.sw) {
    const on = params[col.sw[0]] >= 0.5;
    const isAlt = col.sw[0].endsWith('T_SW') ? !on : on;
    document.querySelector(`.name[data-voice="${col.voice}"]`).textContent = isAlt ? col.alt : col.name;
  }
}

function sendPattern() { send({ type: 'pattern', steps: pattern }); }

function loadPreset(name) {
  const p = PRESETS[name];
  pattern = Array.from({ length: 16 }, () => new Array(12).fill(0));
  for (const [voice, str] of Object.entries(p)) {
    const vi = VOICE_INDEX[voice];
    [...str].forEach((ch, s) => { pattern[s][vi] = ch === 'X' ? 2 : ch === 'x' ? 1 : 0; });
  }
  SEQ_VOICES.forEach((voice, row) => {
    const vi = VOICE_INDEX[voice];
    for (let s = 0; s < 16; s++) cells[s][row].dataset.v = String(pattern[s][vi]);
  });
  sendPattern();
}

let lastStep = -1;
function showStep(step) {
  if (lastStep >= 0) cells[lastStep]?.forEach((c) => c.classList.remove('now'));
  cells[step]?.forEach((c) => c.classList.add('now'));
  lastStep = step;
}

// ---- transport ----
const playBtn = document.getElementById('play');
const bpmInput = document.getElementById('bpm');
const swingInput = document.getElementById('swing');
async function setPlaying(on) {
  await ensureAudio();
  playing = on;
  playBtn.setAttribute('aria-pressed', String(on));
  playBtn.querySelector('.label').textContent = on ? 'Stop' : 'Play';
  send({ type: 'transport', playing: on, bpm: +bpmInput.value, swing: +swingInput.value });
  if (!on && lastStep >= 0) { cells[lastStep].forEach((c) => c.classList.remove('now')); lastStep = -1; }
}
playBtn.onclick = () => setPlaying(!playing);
bpmInput.oninput = () => send({ type: 'transport', bpm: +bpmInput.value });
swingInput.oninput = () => send({ type: 'transport', swing: +swingInput.value });
document.querySelectorAll('[data-preset]').forEach((b) => { b.onclick = () => loadPreset(b.dataset.preset); });

const KEYS = Object.fromEntries(COLUMNS.filter((c) => c.key).map((c) => [c.key, c.voice]));
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input') || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  if (e.code === 'Space') { e.preventDefault(); setPlaying(!playing); return; }
  const k = e.key.toLowerCase();
  const voice = KEYS[k] ?? KEYS[{ ':': ';', '"': "'" }[k]];
  if (voice) { e.preventDefault(); hit(voice, e.shiftKey); }
});

// ---- sound settings: save / copy / load / reset ----
const toast = document.getElementById('toast');
let toastTimer;
function say(msg) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}
function applySettings(values) {
  for (const [id, v] of Object.entries(values)) controls[id]?.(v);
}
function refreshChanged() {
  for (const id of Object.keys(controls)) controls[id](params[id]);
}
function settingsJson() {
  const out = {};
  for (const id of Object.keys(controls)) out[id] = params[id];
  return JSON.stringify(out, null, 2);
}
document.getElementById('save-default').onclick = () => {
  const save = {};
  for (const id of Object.keys(controls)) save[id] = params[id];
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(save));
    defaults = { ...factoryDefaults(), ...save };
    refreshChanged();
    say('Saved. These knob positions now load by default in this browser.');
  } catch {
    say('This browser would not let the page save settings.');
  }
};
document.getElementById('copy-settings').onclick = async () => {
  const json = settingsJson();
  try {
    await navigator.clipboard.writeText(json);
    say('Copied all knob settings to the clipboard as JSON.');
  } catch {
    window.prompt('Copy these settings:', json);
  }
};
document.getElementById('load-settings').onclick = () => {
  const text = window.prompt('Paste settings JSON:');
  if (!text) return;
  try {
    const values = clean(JSON.parse(text));
    if (!Object.keys(values).length) throw new Error('empty');
    applySettings(values);
    say(`Loaded ${Object.keys(values).length} settings. Use "Save as default" to keep them.`);
  } catch {
    say("That doesn't look like settings JSON.");
  }
};
document.getElementById('reset-settings').onclick = () => {
  applySettings(defaults);
  say('Knobs back to your defaults.');
};
document.getElementById('factory-settings').onclick = () => {
  if (!window.confirm('Forget the defaults saved in this browser and go back to the factory sound?')) return;
  try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
  defaults = factoryDefaults();
  applySettings(defaults);
  say('Back to the factory defaults.');
};

loadPreset('basic');
