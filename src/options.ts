export interface VariationOption {
  label: string;
  code: string;
}

/** Hard-coded replacements for the hi-hat line `s("hh*8").gain(0.6)` (Milestone 1 only). */
export const HIHAT_OPTIONS: VariationOption[] = [
  { label: 'offbeats', code: 's("~ hh ~ hh ~ hh ~ hh").gain(0.6)' },
  { label: 'open accents', code: 's("[hh*8, ~ oh]").gain(0.6)' },
  { label: 'rolls', code: 's("hh hh hh [hh hh hh] hh hh hh [hh*4]").gain(0.6)' },
  { label: 'swung 16ths', code: 's("hh*16").gain("[0.6 0.3]*8").swingBy(1/3, 8)' },
];

export const STARTER_CODE = `setcps(0.5)
stack(
  s("bd*4"),
  s("hh*8").gain(0.6),
  note("c2 [~ c2] eb2 g1").s("sawtooth").lpf(800)
)`;
