// Small helpers shared by the drum voices (ported from the synthetic-808 Rust app).

/** sign(x)·|x|^e, returning 0 when the result isn't finite. */
export function sgnpow(x, e) {
  const y = Math.pow(Math.abs(x), e);
  if (!Number.isFinite(y)) return 0;
  return x < 0 || Object.is(x, -0) ? -y : y;
}

/**
 * Rate conversion for oversampling. The voices were designed with some per-sample
 * constants; when a voice runs `os` times faster these keep its timing unchanged.
 * `follow(c, os)`: coefficient for x += (target − x)·c.  `decay(c, os)`: factor for x *= c.
 * Both return c unchanged at os = 1, so 1x output stays bit-identical.
 */
export function follow(c, os) {
  return os === 1 || c >= 1 ? c : 1 - Math.pow(1 - c, 1 / os);
}
export function decay(c, os) {
  return os === 1 ? c : Math.pow(c, 1 / os);
}

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Samples in the 1 ms trigger history every voice keeps (round(sr·0.001·scale), min 1). */
export function histLen(sr, scale = 1) {
  return Math.max(1, Math.round(sr * 0.001 * scale));
}

/**
 * 64-bit xorshift (13, 7, 17) returning white noise in −1..1, matching the Rust
 * voices' `white()` bit for bit. Kept as two 32-bit halves so no BigInt is needed
 * on the audio thread.
 */
export class XorShift64 {
  /** seed: a BigInt or a Number below 2^53. */
  constructor(seed) {
    const s = BigInt.asUintN(64, BigInt(seed));
    this.hi = Number(s >> 32n) >>> 0;
    this.lo = Number(s & 0xffffffffn) >>> 0;
  }
  next() {
    let hi = this.hi, lo = this.lo, h, l;
    // x ^= x << 13
    h = (hi << 13) | (lo >>> 19); l = lo << 13;
    hi = (hi ^ h) >>> 0; lo = (lo ^ l) >>> 0;
    // x ^= x >> 7
    h = hi >>> 7; l = (lo >>> 7) | (hi << 25);
    hi = (hi ^ h) >>> 0; lo = (lo ^ l) >>> 0;
    // x ^= x << 17
    h = (hi << 17) | (lo >>> 15); l = lo << 17;
    hi = (hi ^ h) >>> 0; lo = (lo ^ l) >>> 0;
    this.hi = hi; this.lo = lo;
    // (x >> 11) / 2^53 · 2 − 1
    return (hi * 2097152 + (lo >>> 11)) / 9007199254740992 * 2 - 1;
  }
}

/** 32-bit xorshift (13, 17, 5) used by the clap, in f32 like the Rust engine. */
export class XorShift32 {
  constructor(seed) { this.x = seed >>> 0; }
  next() {
    let x = this.x;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    this.x = x;
    return Math.fround(Math.fround(Math.fround(x) / 4294967296) * 2 - 1);
  }
}

/**
 * The trigger every voice receives: a gate held for ~1 ms after `fire()`.
 * `next()` returns the gate's value for this sample (0 when idle).
 */
export class Gate {
  constructor(sr) { this.sr = sr; this.left = 0; this.value = 0; }
  fire(value = 1) { this.left = Math.max(1, Math.round(0.001 * this.sr)); this.value = value; }
  next() {
    if (this.left > 0) { this.left -= 1; return this.value; }
    return 0;
  }
}

function besselI0(x) {
  let sum = 1, term = 1;
  for (let k = 1; k < 50; k++) { term *= (x / (2 * k)) ** 2; sum += term; if (term < 1e-12 * sum) break; }
  return sum;
}

/**
 * 2:1 decimator: a 47-tap Kaiser-windowed half-band low-pass (flat to about 20 kHz at a
 * 48 kHz output, stop band about −80 dB) followed by dropping every other sample.
 * push(a, b) takes two input samples and returns one output sample.
 */
export class HalfbandDecimator {
  constructor(taps = 47, beta = 7.5) {
    const m = (taps - 1) / 2;
    // only the centre tap and the odd-offset taps are non-zero in a half-band filter
    let sum = 0;
    const raw = [];
    for (let n = -m; n <= m; n++) {
      const sinc = n === 0 ? 0.5 : n % 2 === 0 ? 0 : Math.sin(Math.PI * n / 2) / (Math.PI * n);
      const w = besselI0(beta * Math.sqrt(1 - (n / m) ** 2)) / besselI0(beta);
      raw.push(sinc * w);
      sum += sinc * w;
    }
    this.h = Float64Array.from(raw, (x) => x / sum);
    this.n = taps;
    this.nz = [...this.h.keys()].filter((k) => this.h[k] !== 0); // the 25 non-zero taps
    this.hz = Float64Array.from(this.nz, (k) => this.h[k]);
    this.buf = new Float64Array(taps * 2);
    this.pos = 0;
  }
  _in(x) {
    this.pos = (this.pos + 1) % this.n;
    this.buf[this.pos] = x;
    this.buf[this.pos + this.n] = x;
  }
  push(a, b) {
    this._in(a);
    this._in(b);
    // convolve: newest sample at this.pos
    const buf = this.buf, start = this.pos + 1; // oldest sample
    const nz = this.nz, hz = this.hz;
    let y = 0;
    for (let j = 0; j < nz.length; j++) y += hz[j] * buf[start + nz[j]];
    return y;
  }
}
