// Every control the panel exposes, with defaults (port of app/src/params.rs). Knobs span 0..1 by default.

export const PARAMS = [
  ['TRG_VOL', 0.0], ['TRG_WIDTH', 0.5], ['AC_LEVEL', 0.0],
  ['BD_VOL', 0.5], ['BD_ATK', 0.5], ['BD_DEC', 0.5], ['BD_TUNE', 0.5], ['BD_PAMT', 0.5],
  ['SD_VOL', 0.5], ['SD_TONE', 0.5], ['SD_SNAPPY', 0.5], ['SD_DECAY', 0.5], ['SD_NDEC', 0.5],
  ['SD_BAL', 0.5], ['SD_PITCH', 0.5],
  ['LT_VOL', 0.5], ['LT_TUNE', 0.5], ['LT_DEC', 0.5], ['LT_ATK', 0.5], ['LT_FLT', 0.5], ['LT_SW', 1.0],
  ['MT_VOL', 0.5], ['MT_TUNE', 0.5], ['MT_DEC', 0.5], ['MT_ATK', 0.5], ['MT_FLT', 0.5], ['MT_SW', 1.0],
  ['HT_VOL', 0.5], ['HT_TUNE', 0.5], ['HT_DEC', 0.5], ['HT_ATK', 0.5], ['HT_FLT', 0.5], ['HT_SW', 1.0],
  ['RS_VOL', 0.5], ['RS_TUNE', 0.5], ['RS_OSC1', 0.5], ['RS_DEC', 0.5], ['RS_OSC2', 0.5],
  ['RS_FLT', 0.0], ['RS_RES', 0.5], ['RS_SW', 0.0],
  ['HC_VOL', 0.5], ['HC_OFFSET', 0.5], ['HC_CLPS', 0.5], ['HC_DEC', 0.5], ['HC_TAIL', 0.5],
  ['HC_REV', 0.5], ['HC_FLT', 0.5], ['HC_SW', 0.0],
  ['CB_VOL', 0.5], ['CB_DEC', 0.5], ['CB_TUNE', 0.5], ['CB_PW', 0.5], ['CB_O1', 0.5], ['CB_O2', 0.5], ['CB_SW', 0.0],
  ['RC_VOL', 0.5], ['RC_TONE', 0.5], ['RC_DEC', 1.0],
  ['OH_VOL', 0.5], ['DUTY', 0.5], ['OH_DEC', 0.5],
  ['CH_VOL', 0.5], ['VOLT', 0.5], ['CH_DEC', 0.5],
  ['DRIVE', 0.0], ['MST_VOL', 0.5], ['MAIN_VCA', 0.0],
].map(([id, def]) => ({ id, default: def }));

export const DEFAULTS = Object.freeze(Object.fromEntries(PARAMS.map((p) => [p.id, p.default])));

/** Two-position switches: always 0 or 1. */
export const SWITCHES = Object.freeze(['LT_SW', 'MT_SW', 'HT_SW', 'RS_SW', 'HC_SW', 'CB_SW', 'MAIN_VCA']);

/**
 * Allowed range for each parameter. The standard knob span is 0..1; these extended ranges
 * are for sound tuning and were checked to keep every voice finite and stable
 * (see test/ranges.mjs).
 */
const EXT = { min: -0.5, max: 2 };
const LEVEL = { min: 0, max: 2 };
const EXT_OVERRIDES = {
  TRG_VOL: { min: 0, max: 1.5 }, AC_LEVEL: LEVEL,
  BD_VOL: LEVEL, BD_ATK: { max: 1.5 }, BD_DEC: { min: 0 },
  SD_VOL: LEVEL, SD_DECAY: { max: 1.1 },
  LT_VOL: LEVEL, MT_VOL: LEVEL, HT_VOL: LEVEL,
  RS_VOL: LEVEL, RS_DEC: { min: 0 }, RS_RES: { min: -0.25 },
  HC_VOL: { min: 0, max: 1.5 },
  CB_VOL: LEVEL, CB_DEC: { max: 1.5 },
  RC_VOL: LEVEL, OH_VOL: LEVEL, CH_VOL: LEVEL,
  DRIVE: LEVEL, MST_VOL: { min: 0, max: 1.5 },
};
export const RANGES = Object.freeze(Object.fromEntries(PARAMS.map(({ id }) => [
  id,
  Object.freeze(SWITCHES.includes(id) ? { min: 0, max: 1 } : { ...EXT, ...EXT_OVERRIDES[id] }),
])));

/** Parameter store: plain object of id → value, clamped to RANGES on set. */
export class Params {
  constructor(values = {}) {
    this.values = { ...DEFAULTS };
    for (const [id, v] of Object.entries(values)) this.set(id, v);
  }
  get(id) {
    const v = this.values[id];
    if (v === undefined) throw new Error(`unknown parameter ${id}`);
    return v;
  }
  set(id, v) {
    if (!(id in DEFAULTS)) throw new Error(`unknown parameter ${id}`);
    const r = RANGES[id];
    this.values[id] = Math.min(Math.max(+v, r.min), r.max);
  }
  static defaultOf(id) { return DEFAULTS[id]; }
}
