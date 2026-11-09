# synthetic-808

Twelve analogue-style drum voices in plain JavaScript, with no dependencies: bass drum, snare,
three toms (or congas), rim shot (or claves), hand clap (or maracas), cowbell, cymbal and
open and closed hi-hats.

**Play it:** https://johnnyhawk02.github.io/synthetic-808/ (pads, knobs and a 16-step sequencer;
the page is `index.html` and `demo/`).

This is a port of the Rust drum voices in the `synthetic-808` app (`app/src`).
The voice code is translated line for line and runs in double precision like the Rust, so
the output matches it to within floating-point rounding (see Tests).

## Files

| File | What it is | Ported from |
|---|---|---|
| `voices/bass-drum.js` | `BassDrum` | `bd.rs` |
| `voices/snare.js` | `Snare` | `sd.rs` |
| `voices/tom.js` | `Tom` plus the `LOW`, `MID`, `HIGH` specs (tom or conga) | `tom.rs` |
| `voices/rimshot.js` | `RimShot` (rim shot or claves) | `rs.rs` |
| `voices/clap.js` | `Clap` (hand clap or maracas) | clap block in `synth.rs` |
| `voices/cowbell.js` | `Cowbell` | `cb.rs` |
| `voices/cymbal.js` | `Cymbal`, `stretchFor()` | `cymbal.rs` |
| `voices/hats.js` | `Hats` (closed and open) | `hats.rs` |
| `voices/metal.js` | `Metal`, the shared oscillator bank feeding cowbell, cymbal and hats | `metal.rs` |
| `voices/dsp.js` | shared helpers (noise generators, `sgnpow`) | |
| `params.js` | parameter ids and defaults, `Params` store | `params.rs` |
| `engine.js` | `Engine`: triggers, levels, accent, master drive/VCA/high-pass | `Engine` in `synth.rs` |
| `worklet.js` | AudioWorklet processor wrapping `Engine`, with a sample-accurate step sequencer | `audio.rs` |
| `index.html`, `demo/` | the webpage | |
| `index.js` | re-exports everything | |

## Using a single voice

Each voice is a class you step one sample at a time. Knobs are 0..1, as on the panel.
Velocity is 1 for a normal hit and 2 for an accented one.

```js
import { BassDrum } from './voices/bass-drum.js';

const bd = new BassDrum(48000);
bd.trigger(1);
const out = new Float32Array(48000);
for (let i = 0; i < out.length; i++) {
  // tune, tone (BD_ATK), decay, pitch amount, level
  out[i] = bd.tick(0.5, 0.5, 0.5, 0.5, 0.5) * 0.0625; // 0.0625 = the mixer's bass-drum scale
}
```

The cowbell, cymbal and hats need the metal bank's output each sample:

```js
const metal = new Metal(sr), hats = new Hats(sr);
const knobs = { duty: 0.5, volt: 0.5, cbPw: 0.5, cbTune: 0.5, cbO1: 0.5, cbO2: 0.5, cbFromHats: false };
const m = metal.tick(knobs);              // { hi, lo, cb1, cb2 }
const { closed, open } = hats.tick(m.hi, 0.5, 0.5);
```

The raw voice outputs are large (peaks around 5 to 20). `Engine` applies the per-voice scales
that were calibrated against the original, so use it unless you want to mix yourself.

## Using the whole kit

```js
import { Engine, Params } from './index.js';

const engine = new Engine(48000, new Params({ BD_DEC: 0.7 }));
engine.trigger('bass');            // or 'snare', 'lowTom', 'midTom', 'hiTom', 'rim', 'clap',
engine.trigger('closedHat', true); // 'cowbell', 'cymbal', 'openHat', 'closedHat', 'accent'
const buf = new Float32Array(512);
engine.render(buf);                // mono; engine.render(buf, 2) fills an interleaved stereo buffer
engine.params.set('SD_SNAPPY', 0.8);
```

## In the browser

```js
const ctx = new AudioContext();
await ctx.audioWorklet.addModule('/js/worklet.js');
const node = new AudioWorkletNode(ctx, 'drum-voices', { outputChannelCount: [2] });
node.connect(ctx.destination);
node.port.postMessage({ type: 'trigger', voice: 'snare', accent: false });
node.port.postMessage({ type: 'param', id: 'SD_TONE', value: 0.7 });
node.port.onmessage = (e) => { if (e.data.type === 'meters') console.log(e.data.meters); };

// built-in sequencer: steps[s][voiceIndex] is 0 (off), 1 (hit) or 2 (accented)
node.port.postMessage({ type: 'pattern', steps });
node.port.postMessage({ type: 'transport', playing: true, bpm: 120, swing: 0.1 });
```

To try the page locally, serve the repo folder, for example with `python3 -m http.server`, and open
http://localhost:8000.

The files must be served over http(s), since worklets can't load modules from `file://`.

## Tests

- `npm test` checks that every voice, and each alternate mode, sounds and stays finite and bounded.
- `npm run test:rust` (needs Rust, and `synthetic-808` checked out next to this repo) renders
  reference audio from `synthetic-808/app/src` and compares the JS against it. Last run: the individual voices matched to about 1e-13 of their peak at 44.1 and
  48 kHz, normal and accented. The full engine matched to about 1e-6, and the clap to about 1e-4,
  because the Rust mixer and clap run in single precision.

## Differences from the Rust

- The clap and the mixer run in double precision instead of single precision.
- The Rust `Engine` also ticks an older unused oscillator bank; the port leaves it out.
- Meters are a plain `Float32Array` (`engine.meters`) instead of atomics.
