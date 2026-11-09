// Small helpers shared by the drum voices (ported from the synthetic-808 Rust app).

/** sign(x)·|x|^e, returning 0 when the result isn't finite. */
export function sgnpow(x, e) {
  const y = Math.pow(Math.abs(x), e);
  if (!Number.isFinite(y)) return 0;
  return x < 0 || Object.is(x, -0) ? -y : y;
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
