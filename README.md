# synthetic-808

Twelve analogue-style drum voices in plain JavaScript, with no dependencies: bass drum, snare,
three toms (or congas), rim shot (or claves), hand clap (or maracas), cowbell, cymbal and
open and closed hi-hats.

Version 0.2.0 (shown next to the title on the page; each release is tagged `vX.Y.Z` in git).

**Play it:** https://johnnyhawk02.github.io/synthetic-808/ (pads, knobs and a 16-step sequencer;
the page is `index.html` and `demo/`).

This is a port of the Rust drum voices in the `synthetic-808` app (`app/src`).
The voice code is translated line for line and runs in double precision like the Rust, so
the output matches it to within floating-point rounding (see Tests).

## Files

| File | What it is | Ported from |
|---|---|---|
| `voices/bass-808.js` | `Bass808`, the bass drum laid out like the TR-808 circuit (used by default) | |
| `voices/bass-drum.js` | `BassDrum` (the Rust bass drum, `BASS_FIT.legacy = true`) | `bd.rs` |
| `voices/snare.js` | `Snare` | `sd.rs` |
| `voices/snare-808.js` | `Snare808`, the snare laid out like the TR-808 circuit (`SD_SW = 1`) | |
| `voices/tom-808.js` | `Tom808`, toms and congas laid out like the TR-808 boards (used by default) | |
| `voices/tom.js` | `Tom` plus the `LOW`, `MID`, `HIGH` specs (the Rust toms, `TOM_FIT.legacy = true`) | `tom.rs` |
| `voices/rim-808.js` | `Rim808`, rim shot or claves laid out like the TR-808 board (used by default) | |
| `voices/rimshot.js` | `RimShot` (the Rust rim shot, `RIM_FIT.legacy = true`) | `rs.rs` |
| `voices/clap-808.js` | `Clap808`, hand clap or maracas laid out like the TR-808 board (used by default) | |
| `voices/clap.js` | `Clap` (the Rust clap, `CLAP_FIT.legacy = true`) | clap block in `synth.rs` |
| `voices/cowbell-808.js` | `Cowbell808`, the cowbell laid out like the TR-808 circuit (used by default) | |
| `voices/cowbell.js` | `Cowbell` (the Rust cowbell, `COWBELL_FIT.legacy = true`) | `cb.rs` |
| `voices/cymbal-808.js` | `Cymbal808`, the cymbal laid out like the TR-808 circuit and fitted to its recordings (used by default) | |
| `voices/cymbal.js` | `Cymbal`, `stretchFor()` (the Rust cymbal, `CYMBAL_FIT.legacy = true`) | `cymbal.rs` |
| `voices/hats-808.js` | `Hats808`, closed and open hats laid out like the TR-808 circuits (used by default) | |
| `voices/hats.js` | `Hats` (the Rust hats, `HATS_FIT.legacy = true`) | `hats.rs` |
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
- The rim shot and claves are rebuilt along the lines of the TR-808's rim shot / claves board
  (`voices/rim-808.js`). Rim shot: two resonators (about 470 Hz and 1.9 kHz) drive the "swing"
  VCA, whose collector the tones pull down but never below a fast envelope, which chops them
  into the woody click; then a resonant ~590 Hz high-pass and the mute FET. Claves: one ~2.5 kHz
  resonator, cut by the mute timer, with a little leak past it and the FET's thump. Constants are
  fitted to a component-level simulation of the board (decay, pitch and click settings) and to
  the recordings. Spectrogram error against the recordings: rim shot 8.4 to 2.8 dB, claves 8.6
  to 8.1. Knobs, centred = as built: Tune moves the pitch, Decay the envelope and mute timer;
  rim shot only, Osc 1 / Osc 2 set the two resonator levels, Res the drive into the VCA, and
  Filter raises the high-pass (0 = as built). `RIM_FIT.legacy = true` restores the Rust rim shot.
- The cowbell is rebuilt along the lines of the TR-808's cowbell circuit
  (`voices/cowbell-808.js`): each oscillator switches a transistor, and while it is off the
  envelope current flows past it into a band-pass, so each contributes the envelope gated by its
  square (a one-sided pulse train). The envelope drops fast then leaves a long tail; a coupling
  high-pass, the ~890 Hz band-pass and the output high-pass follow. Fitted to a component-level
  simulation of the circuit across Decay and to the recording: spectrogram error 6.3 to 4.0 dB.
  Decay scales both envelope times (x1/3 to x3). `COWBELL_FIT.legacy = true` restores the Rust
  cowbell.
- The bass drum is rebuilt along the lines of the TR-808's bass drum circuit
  (`voices/bass-808.js`): a bridged-T resonator whose first few milliseconds run at about 2.4x
  the pitch (a transistor shorts one resistor), a second kick at the normal pitch, a small pitch
  slide down to the resting ~49 Hz, the trigger's click, and the Tone pot network into a
  one-pole low-pass computed from its parts. Fitted to a component-level simulation of the
  circuit and to all 25 Tone x Decay recordings: spectrogram error 6.4 to 5.4 dB. The Attack
  knob is Tone, as on the machine; Tune moves the pitch (x0.67 to x1.5) and P.Amt the slide
  depth (0 to x2). `BASS_FIT.legacy = true` restores the Rust bass drum.
- The hats are rebuilt along the lines of the TR-808's hi-hat circuits (`voices/hats-808.js`):
  the six metal oscillators through a bridged-T band-pass into a "swing" VCA that chops the
  signal by the envelope (which gives the fast-then-faster decay), then a Sallen-Key high-pass
  and the mixer's roll-off. The open hat's envelope charges softly, leaks, and is dumped when the
  Decay timer runs out or the closed hat chokes it. Fitted to a component-level simulation of
  the circuits and to the recordings: open hat 5.0 to 4.2 dB, closed hat 4.9 to 2.8.
  `HATS_FIT.legacy = true` restores the Rust hats.
- The snare stays the refit described above by default. A rebuild along the lines of the snare
  circuit (two resonators, the loaded Tone pot, the snappy envelope with its Vbe threshold, the
  wires' high-pass) scored 5.9 dB against the recordings, against 2.7 for the refit; it is
  `voices/snare-808.js`, chosen with the snare's Fit / Circuit switch (`SD_SW`, 0 = Fit,
  1 = Circuit), level-matched to the refit and using the same knobs.
- Controls added for the circuit-based voices (all 0..1, centred = as built): bass drum Click
  (`BD_CLICK`, the trigger's click, 0 to x2) and Attack (`BD_HOLD`, how long the fast first
  segment lasts, x1/3 to x3); snare Wires (`SD_WIRES`, the noise high-pass, an octave either
  way); cowbell Ring (`CB_RING`, the band-pass Q, x1/3 to x3); Spread (`SPREAD`, pulls the six
  metal oscillators together or apart; shared by the cymbal, hats and cowbell in HH mode, like
  Duty and Volt); open and closed hat Tone (`OH_TONE`, `CH_TONE`, each hat's high-pass, an
  octave either way). On the page the toms' Attack knob is labelled Noise and the rim shot's
  Res is Drive; knobs that do nothing for claves, maracas or congas are hidden in those modes,
  and the toms' Filter knob (`xT_FLT`) is no longer shown.
- The Rust clap (legacy) and the mixer run in double precision instead of single precision.
- The Rust `Engine` also ticks an older unused oscillator bank; the port leaves it out.
- Meters are a plain `Float32Array` (`engine.meters`) instead of atomics.
