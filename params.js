// Every control the panel exposes, with defaults (port of app/src/params.rs). Values are 0..1.

export const PARAMS = [
  ['TRG_VOL', 0.0], ['TRG_WIDTH', 0.5], ['AC_LEVEL', 0.0],
  ['BD_VOL', 0.5], ['BD_ATK', 0.5], ['BD_DEC', 0.5], ['BD_TUNE', 0.5], ['BD_PAMT', 0.5],
  ['SD_VOL', 0.5], ['SD_TONE', 0.5], ['SD_SNAPPY', 0.5], ['SD_DECAY', 0.5], ['SD_NDEC', 0.5],
  ['SD_BAL', 0.5], ['SD_PITCH', 0.5], ['SD_SW', 1.0],
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

/** Parameter store: plain object of id → value (0..1), clamped on set. */
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
    this.values[id] = Math.min(Math.max(+v, 0), 1);
  }
  static defaultOf(id) { return DEFAULTS[id]; }
}
