// Drum voice synth, JavaScript port of the synthetic-808 Rust app.
// Each voice is a standalone class you can drive sample by sample; Engine mixes all twelve.

export { Engine, VOICES, VOICE_INDEX, OVERSAMPLED } from './engine.js';
export { Params, PARAMS, DEFAULTS, RANGES, SWITCHES } from './params.js';
export { Metal } from './voices/metal.js';
export { BassDrum, skewBdTune, BD_BASE } from './voices/bass-drum.js';
export { Snare, SNARE_FIT } from './voices/snare.js';
export { Tom, LOW, MID, HIGH } from './voices/tom.js';
export { RimShot } from './voices/rimshot.js';
export { Clap, CLAP_MODES_HZ } from './voices/clap.js';
export { Cowbell } from './voices/cowbell.js';
export { Cymbal, stretchFor } from './voices/cymbal.js';
export { Hats } from './voices/hats.js';
export { Sampler, SAMPLE_MAP, sampleNames } from './sampler.js';
