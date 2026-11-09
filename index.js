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
export { Cymbal808, CYMBAL_FIT } from './voices/cymbal-808.js';
export { Clap808, CLAP_FIT, CLAP_808 } from './voices/clap-808.js';
export { Tom808, TOM_FIT, TOM_808 } from './voices/tom-808.js';
export { Rim808, RIM_FIT, RIM_808 } from './voices/rim-808.js';
export { Cowbell808, COWBELL_FIT, COWBELL_808 } from './voices/cowbell-808.js';
export { Bass808, BASS_FIT, BASS_808 } from './voices/bass-808.js';
export { Hats } from './voices/hats.js';
export { Sampler, SAMPLE_MAP, sampleNames } from './sampler.js';
