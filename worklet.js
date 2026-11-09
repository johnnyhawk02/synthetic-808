// AudioWorklet processor running the drum Engine in the browser, with a built-in
// sample-accurate step sequencer.
//
//   await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
//   const node = new AudioWorkletNode(ctx, 'drum-voices', { outputChannelCount: [2] });
//   node.connect(ctx.destination);
//
// Messages to the processor (node.port.postMessage):
//   { type: 'trigger', voice: 'bass', accent: false }     play a voice now
//   { type: 'param', id: 'BD_DEC', value: 0.8 }            set one parameter (0..1)
//   { type: 'params', values: { BD_DEC: 0.8, ... } }       set several
//   { type: 'pattern', steps: [[...], ...] }               steps[s][voiceIndex]: 0 off, 1 hit, 2 accented
//   { type: 'transport', playing: true, bpm: 120, swing: 0 }  start/stop (restarts at step 0), tempo, swing 0..0.5
//
// Messages from the processor:
//   { type: 'meters', meters: Float32Array(12) }   about 30 times a second
//   { type: 'step', step: n }                      when the sequencer reaches step n

import { Engine } from './engine.js';
import { Params } from './params.js';

class DrumVoicesProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.engine = new Engine(sampleRate, new Params(options?.processorOptions?.params ?? {}));
    this.buf = new Float32Array(128);
    this.meterEvery = Math.max(1, Math.round(sampleRate / 30 / 128));
    this.blocks = 0;
    this.steps = [];
    this.playing = false;
    this.bpm = 120;
    this.swing = 0;
    this.step = 0;
    this.untilStep = 0; // samples until the next step fires
    this.port.onmessage = ({ data }) => this.onMessage(data);
  }

  onMessage(data) {
    switch (data.type) {
      case 'trigger': this.engine.trigger(data.voice, !!data.accent); break;
      case 'param': this.engine.params.set(data.id, data.value); break;
      case 'params': for (const [id, v] of Object.entries(data.values)) this.engine.params.set(id, v); break;
      case 'pattern': this.steps = data.steps; break;
      case 'transport':
        if (data.bpm) this.bpm = Math.min(Math.max(data.bpm, 30), 300);
        if (data.swing !== undefined) this.swing = Math.min(Math.max(data.swing, 0), 0.5);
        if (data.playing !== undefined && data.playing !== this.playing) {
          this.playing = data.playing;
          this.step = 0;
          this.untilStep = 0;
        }
        break;
    }
  }

  /** samples from the start of `step` to the next step (16th notes, swing delays odd steps) */
  stepLength(step) {
    const base = sampleRate * 60 / this.bpm / 4;
    return base * (step % 2 === 0 ? 1 + this.swing : 1 - this.swing);
  }

  fireStep() {
    const row = this.steps[this.step];
    if (row) for (let v = 0; v < row.length; v++) if (row[v]) this.engine.trigger(v, row[v] === 2);
    this.port.postMessage({ type: 'step', step: this.step });
    this.untilStep += this.stepLength(this.step);
    this.step = (this.step + 1) % Math.max(1, this.steps.length || 16);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    if (this.buf.length !== n) this.buf = new Float32Array(n);
    let pos = 0;
    while (pos < n) {
      if (this.playing && this.untilStep < 1) this.fireStep();
      let len = n - pos;
      if (this.playing) len = Math.min(len, Math.max(1, Math.ceil(this.untilStep)));
      this.engine.render(this.buf.subarray(pos, pos + len), 1);
      if (this.playing) this.untilStep -= len;
      pos += len;
    }
    for (const ch of out) ch.set(this.buf);
    if (++this.blocks >= this.meterEvery) {
      this.blocks = 0;
      this.port.postMessage({ type: 'meters', meters: this.engine.meters.slice() });
    }
    return true;
  }
}

registerProcessor('drum-voices', DrumVoicesProcessor);
