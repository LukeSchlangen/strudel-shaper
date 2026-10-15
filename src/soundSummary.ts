/**
 * A compact description of the loaded sound names for the model prompt. The live soundMap has
 * about 1650 keys, mostly `bank_sound` drum-machine samples (with aliases such as `tr909` and
 * `rolandtr909` for the same kit) and `gm_*` General MIDI soundfonts. Listing them all would cost
 * several thousand tokens on every request, so this groups them:
 *   - the common drum names first (always, when loaded),
 *   - well-known drum machines with their sounds, the other banks by name (aliases folded),
 *   - General MIDI instruments (`gm_` prefix) on one line,
 *   - every other plain name, and the multi-sample instrument families by prefix.
 */

export const COMMON_DRUMS = ['bd', 'sd', 'hh', 'oh', 'cp', 'rim', 'lt', 'mt', 'ht', 'cr', 'rd', 'cb', 'sh', 'perc'];
const SYNTHS = ['sine', 'sawtooth', 'square', 'triangle', 'supersaw', 'white', 'pink', 'brown'];
const POPULAR_BANKS = ['rolandtr808', 'rolandtr909', 'rolandtr707', 'rolandtr606', 'rolandcr78', 'linndrum', 'oberheimdmx', 'akaimpc60', 'emusp12', 'korgminipops', 'casiorz1', 'alesishr16'];

export function summariseSounds(names: string[]): string {
  const all = new Set(names.map((n) => n.toLowerCase()));
  const banks = new Map<string, string[]>();
  const gm: string[] = [];
  const plain: string[] = [];
  for (const name of [...all].sort()) {
    const m = /^([a-z0-9]+)_(.+)$/.exec(name);
    if (!m) plain.push(name);
    else if (m[1] === 'gm') gm.push(m[2]);
    else banks.set(m[1], [...(banks.get(m[1]) ?? []), m[2]]);
  }

  // A bank whose sounds are all drum names is a drum machine; the rest (ocarina_small, …) are instruments.
  const drumSet = new Set(COMMON_DRUMS.concat(['tb', 'misc']));
  const drumBanks = [...banks].filter(([, s]) => s.every((x) => drumSet.has(x)));
  const otherBanked = [...banks].filter(([, s]) => !s.every((x) => drumSet.has(x))).flatMap(([b, s]) => s.map((x) => `${b}_${x}`));

  // Fold aliases: `tr909` and `rolandtr909` with the same kit become one entry under the longer name.
  const kept = drumBanks.filter(
    ([name, sounds]) => !drumBanks.some(([other, os]) => other !== name && other.endsWith(name) && os.join() === sounds.join()),
  );
  // Full sound lists for the well-known machines only; the rest by name (they cost ~2k tokens in full).
  const listed = kept.filter(([name]) => POPULAR_BANKS.includes(name));
  const named = kept.filter(([name]) => !POPULAR_BANKS.includes(name)).map(([name]) => name);

  const lines: string[] = [];
  const drums = COMMON_DRUMS.filter((d) => all.has(d));
  if (drums.length) lines.push(`Drums (s("bd sd hh")): ${drums.join(' ')}`);
  const synths = SYNTHS.filter((s) => all.has(s));
  if (synths.length) lines.push(`Synths (note("c3").s("sawtooth")): ${synths.join(' ')}`);
  if (listed.length) {
    lines.push('Drum machines, with exactly these sounds (s("bd sd").bank("rolandtr909")):');
    for (const [name, sounds] of listed) lines.push(`  ${name}: ${sounds.join(' ')}`);
  }
  if (named.length) lines.push(`More drum machine banks (sounds vary; bd sd hh are safest): ${named.join(' ')}`);
  if (gm.length) lines.push(`General MIDI (note("c3").s("gm_piano")): ${gm.join(' ')}`);
  const families = [...new Set(otherBanked.map((n) => n.split('_')[0]))];
  const rest = plain.filter((n) => !drums.includes(n) && !synths.includes(n));
  if (rest.length) lines.push(`Other sounds: ${rest.join(' ')}`);
  if (families.length) lines.push(`Sampled instruments with articulations (e.g. ${otherBanked[0]}): ${families.map((f) => `${f}_*`).join(' ')}`);
  return lines.join('\n');
}
