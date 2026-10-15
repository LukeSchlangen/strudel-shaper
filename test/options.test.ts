// Evaluates every hard-coded option with the real Strudel transpiler and pattern engine (no audio),
// the same way the REPL does, and checks that each one produces hi-hat events.
import { beforeAll, describe, expect, it } from 'vitest';
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import { transpiler } from '@strudel/transpiler';
import { HIHAT_OPTIONS, STARTER_CODE } from '../src/options';
import { splice } from '../src/splice';

const HH = 's("hh*8").gain(0.6)';

beforeAll(async () => {
  await core.evalScope(core, mini, { setcps: () => core.silence });
});

async function evaluate(code: string) {
  const { pattern } = await core.evaluate(code, transpiler, {});
  expect(core.isPattern(pattern)).toBe(true);
  return pattern;
}

describe('hard-coded options', () => {
  for (const [i, option] of HIHAT_OPTIONS.entries()) {
    it(`${i + 1} "${option.label}" evaluates on its own and yields hats`, async () => {
      const haps = (await evaluate(option.code)).queryArc(0, 2).filter((h: any) => h.hasOnset());
      expect(haps.length).toBeGreaterThan(0);
      for (const h of haps) expect(['hh', 'oh']).toContain(h.value.s);
    });

    it(`${i + 1} "${option.label}" evaluates spliced into the starter buffer`, async () => {
      const from = STARTER_CODE.indexOf(HH);
      const code = splice(STARTER_CODE, { from, to: from + HH.length }, option.code);
      const haps = (await evaluate(code)).queryArc(0, 1).filter((h: any) => h.hasOnset());
      const sounds = new Set(haps.map((h: any) => h.value.s));
      expect(sounds).toContain('bd');
      expect(sounds).toContain('sawtooth');
    });
  }

  it('option 2 actually contains open hats', async () => {
    const haps = (await evaluate(HIHAT_OPTIONS[1].code)).queryArc(0, 1);
    expect(haps.some((h: any) => h.value.s === 'oh')).toBe(true);
  });

  it('option 4 is swung: some 16th onsets are delayed off the grid', async () => {
    const haps = (await evaluate(HIHAT_OPTIONS[3].code)).queryArc(0, 1).filter((h: any) => h.hasOnset());
    expect(haps).toHaveLength(16);
    const offGrid = haps.filter((h: any) => (h.whole.begin.valueOf() * 16) % 1 !== 0);
    expect(offGrid).toHaveLength(8);
  });
});
