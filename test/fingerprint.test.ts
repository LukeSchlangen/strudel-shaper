import { beforeAll, describe, expect, it } from 'vitest';
import { STARTER_CODE } from '../src/options';
import type { Option } from '../src/provider';
import { FINGERPRINT_CYCLES, Sandbox } from '../src/sandbox';
import { Validator, type Baseline } from '../src/validator';

const HH = 's("hh*8").gain(0.6)';
const from = STARTER_CODE.indexOf(HH);
const range = { from, to: from + HH.length };
const opt = (code: string): Option => ({ id: code, label: code, code });
const withHat = (code: string) => STARTER_CODE.replace(HH, code);

let sandbox: Sandbox;
let validator: Validator;
let baseline: Baseline;
beforeAll(async () => {
  sandbox = await Sandbox.create();
  validator = new Validator({ backend: sandbox, hasSound: () => true, cps: () => 0.5 });
  baseline = await validator.baseline(STARTER_CODE);
});

const print = async (code: string) => {
  const r = await sandbox.check(code, 0.5, undefined, { fingerprint: true });
  if (!r.ok) throw new Error(r.message);
  return r.fingerprint!;
};

describe('sounds-identical check (shape mode)', () => {
  it.each([
    ['a no-op transform', `${HH}.fast(1)`],
    ['a callback that changes nothing', `${HH}.sometimesBy(0.5, x => x)`],
    ['rarely with an identity function', `${HH}.rarely(x => x)`],
    ['rev of a uniform pattern', `${HH}.rev()`],
    ['the same events, written out', 's("hh hh hh hh hh hh hh hh").gain(0.6)'],
    ['the same value as a string', 's("hh*8").gain("0.6")'],
  ])('drops %s as identical (sounds the same), with its own feedback', async (_name, code) => {
    const r = await validator.validate(STARTER_CODE, range, opt(code), [], { baseline });
    expect(r).toMatchObject({ ok: false, reason: 'identical', identicalBy: 'sound', message: 'The option sounds exactly like the original.' });
  });

  it.each([
    ['dropping events at random', `${HH}.degradeBy(0.5)`],
    ['a random callback that changes events', `${HH}.sometimes(x => x.speed(2))`],
    ['a change only in the 4th cycle', 's("hh*8").gain("<0.6 0.6 0.6 0.5>")'],
    ['a change only in the second half of a 4-cycle form', `${HH}.mask("<1 1 1 [1 0]>")`],
    ['a slow(4) of a varying pattern', 's("<hh oh>*8").gain(0.6).slow(4)'],
    ['different random amounts', `${HH}.degradeBy(0.3)`],
    ['a tempo change only', 'setcps(1), s("hh*8").gain(0.6)'],
  ])('keeps %s', async (_name, code) => {
    const r = await validator.validate(STARTER_CODE, range, opt(code), [], { baseline });
    expect(r.ok, r.message).toBe(true);
  });

  it('a 4th-cycle difference needs more than the 2 cycles the warnings use', () => {
    expect(FINGERPRINT_CYCLES).toBeGreaterThanOrEqual(4);
  });

  it('.degradeBy(0.5) and .degradeBy(0.3) differ from each other, not just from the original', async () => {
    expect(await print(withHat(`${HH}.degradeBy(0.5)`))).not.toBe(await print(withHat(`${HH}.degradeBy(0.3)`)));
  });

  it('is skipped when the buffer itself fails (no fingerprint to compare with)', async () => {
    const broken = STARTER_CODE.replace('s("bd*4")', 's("bd*4").wobble(2)');
    const b = await validator.baseline(broken);
    expect(b.ok).toBe(false);
    const r = await validator.validate(broken, { from: broken.indexOf(HH), to: broken.indexOf(HH) + HH.length }, opt(`${HH}.fast(1)`), [], { baseline: b });
    expect(r.reason).not.toBe('identical');
  });

  it('the text check still comes first', async () => {
    const r = await validator.validate(STARTER_CODE, range, opt('s( "hh*8" ).gain( 0.6 )'), [], { baseline });
    expect(r).toMatchObject({ reason: 'identical', identicalBy: 'text' });
  });
});

describe('Strudel randomness is deterministic across evaluations', () => {
  it.each([
    ['degradeBy', 's("hh*16").degradeBy(0.5)'],
    ['sometimes', 's("hh*16").sometimes(x => x.speed(2))'],
    ['rand as a signal', 's("hh*16").gain(rand.range(0.2, 0.8))'],
    ['irand notes', 'n(irand(8).segment(8)).scale("C:minor").s("sawtooth")'],
    ['shuffle', 'n("0 1 2 3 4 5 6 7").shuffle(8).s("sawtooth")'],
    ['choose', 's("hh*8").n(choose(0, 1, 2))'],
  ])('%s: two evaluations play the same events', async (_name, code) => {
    // Evaluate something else in between, so nothing is cached from the first run.
    const a = await print(code);
    await print('s("bd*3")');
    expect(await print(code)).toBe(a);
  });

  it('Math.random in user code differs every time, so such an option is never taken for the original', async () => {
    const code = 's("hh*8").gain(Math.random())';
    expect(await print(code)).not.toBe(await print(code));
  });
});
