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
| `voices/tom-808.js` | `Tom808`, toms and congas laid out like the TR-808 boards (used by default) | |
| `voices/tom.js` | `Tom` plus the `LOW`, `MID`, `HIGH` specs (the Rust toms, `TOM_FIT.legacy = true`) | `tom.rs` |
| `voices/rimshot.js` | `RimShot` (rim shot or claves) | `rs.rs` |
| `voices/clap-808.js` | `Clap808`, hand clap or maracas laid out like the TR-808 board (used by default) | |
| `voices/clap.js` | `Clap` (the Rust clap, `CLAP_FIT.legacy = true`) | clap block in `synth.rs` |
| `voices/cowbell.js` | `Cowbell` | `cb.rs` |
| `voices/cymbal-808.js` | `Cymbal808`, the cymbal laid out like the TR-808 circuit and fitted to its recordings (used by default) | |
| `voices/cymbal.js` | `Cymbal`, `stretchFor()` (the Rust cymbal, `CYMBAL_FIT.legacy = true`) | `cymbal.rs` |
| `voices/hats.js` | `Hats` (closed and open) | `hats.rs` |
| `voices/metal.js` | `Metal`, the shared oscillator bank feeding cowbell, cymbal and hats | `metal.rs` |
| `voices/dsp.js` | shared helpers (noise generators, `sgnpow`) | |
| `params.js` | parameter ids, defaults and allowed ranges, `Params` store | `params.rs` |
| `engine.js` | `Engine`: triggers, levels, accent, master drive/VCA/high-pass | `Engine` in `synth.rs` |
| `sampler.js` | `Sampler`: plays the 808 recordings in place of voices, picked by knob position | |
| `samples/808/` | the TR-808 recordings and their level calibration | |
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
that balance the kit, so use it unless you want to mix yourself.

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

### Tuning on the webpage

The knobs go past the standard 0..1 range (see `RANGES` in `params.js`; most run from −0.5 to 2,
and a few stop earlier where that voice becomes unstable). The orange arc on each dial marks the
0..1 span. `npm test` checks every parameter at both ends of its range.

- **Save as default** stores the current knobs in this browser, and they load every time.
- **Copy settings** puts all the knob values on the clipboard as JSON. **Paste settings** loads JSON back.
- To make settings the default for everyone, put the copied JSON in `demo/defaults.json` and commit it.
  The page loads the library defaults, then `demo/defaults.json`, then anything saved in the browser.
- **Reset to default** returns the knobs to your defaults; **Factory reset** forgets the browser's saved ones.

To try the page locally, serve the repo folder, for example with `python3 -m http.server`, and open
http://localhost:8000.

The files must be served over http(s), since worklets can't load modules from `file://`.

## Comparing with a real 808

`samples/808/` holds Michael Fischer's free TR-808 sample set (1994): 116 hits recorded from
the individual outputs of a TR-808, with each sound knob at five positions (0, 2.5, 5, 7.5, 10).
On the webpage, the **808 samples** switch (or the **808** chip on a single voice) plays these
recordings instead of the synth. Each hit picks the recording nearest the voice's knobs:

| Voice | Knobs that pick the recording |
|---|---|
| Bass drum | Tone, Decay |
| Snare | Tone, Snappy |
| Toms / congas | Tune (and the Conga/Tom switch) |
| Cymbal | Tone, Decay |
| Open hat | Decay |
| Rim / claves, clap / maracas | their switch |
| Cowbell, closed hat | none |

The Level knobs still work, and accent scales the recording by as much as it would the synth.
`samples/808/calibration.json` sets each recording's level to match the synth at default
settings; `node test/calibrate-samples.mjs` rebuilds it. In code, attach a `Sampler`
(`sampler.js`) to `engine.sampler` and set `engine.useSample[i] = 1` for the voices to swap.

## Oversampling

`new Engine(sampleRate, params)` runs the toms, rim, cowbell, cymbal and hats at twice the sample rate
and filters them back down with a 47-tap halfband filter (flat to about 20 kHz). This removes most of
the aliasing in the hats and cymbal; the bass drum, snare, clap and accent stay at the normal rate.
Decay times and tuning are the same at either rate. Pass `{ oversample: 1 }` as a third argument to
turn it off; at 1x the output matches the Rust exactly.

Voices that have finished sounding stop being computed until they're next triggered, so a typical
beat uses only a few percent of one CPU core.

## Tests

- `npm test` checks that every voice, and each alternate mode, sounds and stays finite and bounded,
  and that every parameter stays stable at both ends of its extended range.
- `npm run test:rust` (needs Rust, and `synthetic-808` checked out next to this repo) renders
  reference audio from `synthetic-808/app/src` and compares the JS (at 1x, with the legacy snare) against it. Last run: the individual voices matched to about 1e-13 of their peak at 44.1 and
  48 kHz, normal and accented. The full engine matched to about 1e-6, and the clap to about 1e-4,
  because the Rust mixer and clap run in single precision.

## Differences from the Rust

- The snare is refitted to the TR-808 recordings in `samples/808/SD`: the noise is much louder
  and darker (Snappy follows the machine's curve), Tone crossfades the two resonators the way
  the machine's knob does, and the upper resonator dies away faster. Across all 25 Tone/Snappy
  recordings the spectrogram error dropped from about 8 dB to 2.6 dB. The kit balance is kept
  by lowering the snare's output gain. `SNARE_FIT.legacy = true` restores the Rust snare
  (the Rust comparison test does this).
- The cymbal is rebuilt along the lines of the TR-808's cymbal circuit (`voices/cymbal-808.js`):
  three envelopes (short, medium, and a long one set by Decay that feeds both the low band and
  one high band), switching VCAs gated by the metal oscillators' high and low bands, the
  circuit's band filters, and its Tone pot network. The constants are fitted to the 25
  recordings in `samples/808/CY`. Spectrogram error against the recordings dropped from about
  14 dB (Rust cymbal) to 3.2 dB, and the decay times match.
  `CYMBAL_FIT.legacy = true` (set before building the Engine) restores the Rust cymbal.
- The hand clap and maracas are rebuilt along the lines of the TR-808's clap / maracas board
  (`voices/clap-808.js`). Clap: band-passed noise through a soft-clipping VCA, opened by a
  sawtooth that restarts every ~11 ms inside the trigger's window (one clap per ramp) and falls
  slowly after it, plus a slower "reverb" envelope on the same noise and a little sawtooth thump.
  Maracas: noise through a gate that opens slowly, holds and snaps shut, then two high-passes.
  The constants are fitted to a component-level simulation of the board across its decay,
  spacing and reverb settings, and to the recordings. Spectrogram error against the recordings
  dropped from about 11 dB to 5 dB for both. Knobs, all centred = as built: Offset sets the clap
  spacing, Claps the window (how many claps), Decay the last clap, Tail and Rev the reverb's
  decay and level, Filter its low-pass; for the maracas, Decay sets the gate length, Offset the
  attack and Filter the high-pass tuning. `CLAP_FIT.legacy = true` restores the Rust clap.
- The toms and congas are rebuilt along the lines of the TR-808's tom / conga boards
  (`voices/tom-808.js`): a bridged-T resonator kicked by the trigger pulse, its pitch and level
  following the tuning pot, a short swell as the ring builds up, and on the toms a burst of
  steeply filtered noise that decays with the ring. The constants are fitted to a
  component-level simulation of the boards across the Tuning knob and to the recordings.
  Spectrogram error against the recordings: low tom 8.5 to 4.9 dB, mid tom 7.6 to 6.8, high
  tom 7.7 to 8.0, congas 10.4 / 7.1 / 8.9 to 6.3 / 5.6 / 7.2. Knobs, centred = as built: Tune
  sweeps the pot's range, Decay scales the ring time (x1/3 to x3), Attack the tom noise, Filter
  its low-pass. `TOM_FIT.legacy = true` restores the Rust toms.
- The Rust clap (legacy) and the mixer run in double precision instead of single precision.
- The Rust `Engine` also ticks an older unused oscillator bank; the port leaves it out.
- Meters are a plain `Float32Array` (`engine.meters`) instead of atomics.
