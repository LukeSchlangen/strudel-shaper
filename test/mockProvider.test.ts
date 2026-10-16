import { beforeAll, describe, expect, it } from 'vitest';
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import { transpiler } from '@strudel/transpiler';
import { FAULT_KINDS, MockProvider, TRANSFORMS, naiveBalance, type FaultKind, type Sleep } from '../src/mockProvider';
import { Sandbox } from '../src/sandbox';
import { Validator, type ValidationResult } from '../src/validator';
import type { Mode, Option, OptionRequest } from '../src/provider';
import { STARTER_CODE } from '../src/options';
import { splice } from '../src/splice';

const HH = 's("hh*8").gain(0.6)';

function request(instruction = '', mode: Mode = 'shape', text = HH): OptionRequest {
  const from = STARTER_CODE.indexOf(text);
  return { mode, buffer: STARTER_CODE, selection: { from, to: from + text.length, text }, instruction, cps: 0.5 };
}

const noDelay = (seed = 42) => new MockProvider({ seed, minDelayMs: 0, maxDelayMs: 0 });

async function collect(iter: AsyncIterable<Option>) {
  const out: Option[] = [];
  for await (const o of iter) out.push(o);
  return out;
}

const suffixOf = (o: Option) => o.code.slice(HH.length);
const tagOf = (o: Option) => TRANSFORMS.find((t) => t.suffix === suffixOf(o))?.tag;

describe('MockProvider', () => {
  it('is deterministic for a fixed seed', async () => {
    const a = await collect(noDelay().generateOptions(request('busier'), new AbortController().signal));
    const b = await collect(noDelay().generateOptions(request('busier'), new AbortController().signal));
    expect(a).toEqual(b);
  });

  it('gives a new set on the next call (regenerate)', async () => {
    const p = noDelay();
    const sets: string[] = [];
    for (let i = 0; i < 5; i++) {
      const opts = await collect(p.generateOptions(request(), new AbortController().signal));
      sets.push(opts.map((o) => o.code).join('|'));
    }
    expect(new Set(sets).size).toBeGreaterThan(1);
  });

  it('streams 4 distinct options that append to the selection', async () => {
    for (let seed = 0; seed < 20; seed++) {
      const opts = await collect(noDelay(seed).generateOptions(request(), new AbortController().signal));
      expect(opts).toHaveLength(4);
      expect(new Set(opts.map((o) => o.code)).size).toBe(4);
      expect(new Set(opts.map((o) => o.id)).size).toBe(4);
      for (const o of opts) expect(o.code.startsWith(HH)).toBe(true);
    }
  });

  it('"busier" puts fast/ply/off first, "sparser" puts slow/degradeBy first', async () => {
    for (let seed = 0; seed < 20; seed++) {
      const busy = await collect(noDelay(seed).generateOptions(request('make it busier'), new AbortController().signal));
      expect(busy.slice(0, 3).map(tagOf)).toEqual(['busier', 'busier', 'busier']);
      const calm = await collect(noDelay(seed).generateOptions(request('Calmer please'), new AbortController().signal));
      expect(calm.slice(0, 2).map(tagOf)).toEqual(['sparser', 'sparser']);
    }
  });

  it('appends before a trailing comma or newline in the selection', async () => {
    for (const tail of [',', ',\n', '  ', ';']) {
      const req = request();
      req.selection = { ...req.selection, text: HH + tail };
      const opts = await collect(noDelay().generateOptions(req, new AbortController().signal));
      for (const o of opts) {
        expect(o.code.endsWith(tail)).toBe(true);
        expect(TRANSFORMS.some((t) => o.code === HH + t.suffix + tail)).toBe(true);
      }
    }
  });

  it('a whole-line selection with its comma still evaluates in the starter buffer', async () => {
    await core.evalScope(core, mini, { setcps: () => core.silence });
    const line = HH + ',';
    const from = STARTER_CODE.indexOf(line);
    const req = request();
    req.selection = { from, to: from + line.length, text: line };
    for (const o of await collect(noDelay().generateOptions(req, new AbortController().signal))) {
      const code = splice(STARTER_CODE, { from, to: from + line.length }, o.code);
      const { pattern } = await core.evaluate(code, transpiler, {});
      expect(core.isPattern(pattern)).toBe(true);
    }
  });

  it('fix modes return one option: a musical no-op when there is nothing the mock can balance', async () => {
    for (const mode of ['fix-minimal', 'fix-rewrite'] as Mode[]) {
      const opts = await collect(noDelay().generateOptions(request('', mode), new AbortController().signal));
      expect(opts).toEqual([{ id: expect.any(String), label: 'mock fix (no-op)', code: HH + '.fast(1)' }]);
    }
  });

  it.each([
    ['a missing quote', 's("hh*8).gain(0.6)', 's("hh*8").gain(0.6)'],
    ['a stray mini-notation bracket', 's("hh*8[").gain(0.6)', 's("hh*8").gain(0.6)'],
    ['an unclosed mini-notation group', 's("hh [hh hh").gain(0.6)', 's("hh [hh hh]").gain(0.6)'],
    ['a missing closing paren', 's("hh*8").gain(0.6', 's("hh*8").gain(0.6)'],
    ['nothing it can see', 's("hh*8").gian(0.6)', 's("hh*8").gian(0.6)'],
  ])('naiveBalance: %s', (_name, broken, fixed) => {
    expect(naiveBalance(broken)).toBe(fixed);
  });

  it('fix-minimal on a missing quote returns the balanced code, labelled "mock fix"', async () => {
    const broken = 's("hh*8).gain(0.6)';
    const req = { ...request('', 'fix-minimal'), selection: { from: 0, to: broken.length, text: broken } };
    const opts = await collect(noDelay().generateOptions(req, new AbortController().signal));
    expect(opts).toEqual([{ id: expect.any(String), label: 'mock fix', code: HH }]);
  });

  it('stops yielding once aborted', async () => {
    const controller = new AbortController();
    // Abort during the wait before the third option.
    let waits = 0;
    const sleep: Sleep = async () => {
      if (++waits === 3) controller.abort();
    };
    const opts = await collect(new MockProvider({ seed: 1, sleep }).generateOptions(request(), controller.signal));
    expect(opts).toHaveLength(2);
  });

  it('waits a seeded 300–1200 ms before each option by default', async () => {
    const delays: number[] = [];
    const sleep: Sleep = async (ms) => void delays.push(ms);
    await collect(new MockProvider({ seed: 7, sleep }).generateOptions(request(), new AbortController().signal));
    expect(delays).toHaveLength(4);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(300);
      expect(d).toBeLessThanOrEqual(1200);
    }
  });
});

describe('every transform is real Strudel', () => {
  beforeAll(async () => {
    await core.evalScope(core, mini, { setcps: () => core.silence });
  });

  const expressions = ['s("bd*4")', HH, 'note("c2 [~ c2] eb2 g1").s("sawtooth").lpf(800)'];
  for (const expr of expressions) {
    for (const t of TRANSFORMS) {
      it(`${expr}${t.suffix} evaluates spliced into the starter buffer`, async () => {
        const from = STARTER_CODE.indexOf(expr);
        const code = splice(STARTER_CODE, { from, to: from + expr.length }, expr + t.suffix);
        const { pattern } = await core.evaluate(code, transpiler, {});
        expect(core.isPattern(pattern)).toBe(true);
        const onsets = pattern.queryArc(0, 4).filter((h: any) => h.hasOnset());
        expect(onsets.length).toBeGreaterThan(0);
      });
    }
  }
});

describe('faulty mode', () => {
  const faulty = (opts: Partial<ConstructorParameters<typeof MockProvider>[0]> = {}) =>
    new MockProvider({ seed: 42, minDelayMs: 0, maxDelayMs: 0, ...opts });

  it('faultRate 0 gives exactly the milestone 2 options and delays', async () => {
    // Recorded from the milestone 2 mock (commit c1a1fe6^) with seed 42.
    const delays: number[] = [];
    const p = new MockProvider({ seed: 42, faultSeed: 999, sleep: async (ms) => void delays.push(Math.round(ms)) });
    const sets: string[][] = [];
    for (let r = 0; r < 2; r++) sets.push((await collect(p.generateOptions(request(), new AbortController().signal))).map(suffixOf));
    expect(sets).toEqual([
      ['.slow(2)', '.ply(2)', '.fast(2)', '.rev()'],
      ['.degradeBy(0.3)', '.rev()', '.slow(2)', '.fast(2)'],
    ]);
    expect(delays).toEqual([546, 862, 1079, 725, 339, 356, 1092, 471]);
    expect(p.faultLog).toEqual([]);
  });

  it('is deterministic for a fixed fault seed, and faultRate 1 breaks every option', async () => {
    const run = async () => {
      const p = faulty({ faultRate: 1, faultSeed: 7 });
      const codes: string[] = [];
      for (let r = 0; r < 5; r++) codes.push(...(await collect(p.generateOptions(request(), new AbortController().signal))).map((o) => o.code));
      return { codes, kinds: p.faultLog.map((f) => f.kind) };
    };
    const a = await run();
    expect(a).toEqual(await run());
    expect(a.kinds).toHaveLength(20);
    expect(new Set(a.kinds).size).toBeGreaterThan(4);
  });

  it('faultRate 0.5 breaks roughly half', async () => {
    const p = faulty({ faultRate: 0.5 });
    for (let r = 0; r < 25; r++) await collect(p.generateOptions(request(), new AbortController().signal));
    expect(p.faultLog.length).toBeGreaterThan(30);
    expect(p.faultLog.length).toBeLessThan(70);
  });

  it('a forced duplicate with no clean option to copy falls back to the next kind', async () => {
    const p = faulty({ faultRate: 1, faultKind: 'duplicate' });
    const opts = await collect(p.generateOptions(request(), new AbortController().signal));
    // Nothing clean to copy, ever: every option falls back to the next kind.
    expect(p.faultLog.map((f) => f.kind)).toEqual(['syntax', 'syntax', 'syntax', 'syntax']);
    expect(opts).toHaveLength(4);
  });

  it('with feedback: one valid option not issued before', async () => {
    const p = faulty({ faultRate: 1 });
    const first = await collect(p.generateOptions(request(), new AbortController().signal));
    const req = { ...request(), feedback: { previousCode: first[0].code, error: 'syntax: Unexpected token' } };
    const issued = new Set(first.map((o) => o.code));
    for (let i = 0; i < 3; i++) {
      const [replacement, ...rest] = await collect(p.generateOptions(req, new AbortController().signal));
      expect(rest).toEqual([]);
      expect(TRANSFORMS.some((t) => replacement.code === HH + t.suffix)).toBe(true);
      expect(issued.has(replacement.code)).toBe(false);
      issued.add(replacement.code);
    }
    expect(p.faultLog).toHaveLength(4); // only the first request's options
  });

  it('replacements asked for at the same time differ from each other and from planned options', async () => {
    const p = new MockProvider({ seed: 5, minDelayMs: 10, maxDelayMs: 10 });
    const stream = p.generateOptions(request(), new AbortController().signal)[Symbol.asyncIterator]();
    const first = (await stream.next()).value as Option;
    // Two retries in flight while three planned options are still to come.
    const req = { ...request(), feedback: { previousCode: first.code, error: 'syntax: x' } };
    const [a, b] = await Promise.all([1, 2].map(async () => (await collect(p.generateOptions(req, new AbortController().signal)))[0]));
    const rest = [];
    for (let r = await stream.next(); !r.done; r = await stream.next()) rest.push(r.value.code);
    const all = [first.code, ...rest, a.code, b.code];
    expect(new Set(all).size).toBe(6);
  });

  it('with feedback and retryFails: broken again', async () => {
    const p = faulty({ retryFails: true });
    const req = { ...request(), feedback: { previousCode: 'x', error: 'eval: nope' } };
    await collect(p.generateOptions(req, new AbortController().signal));
    expect(p.faultLog.map((f) => f.kind)).toEqual(['syntax']);
    p.faultKind = 'runtime';
    await collect(p.generateOptions(req, new AbortController().signal));
    expect(p.faultLog.map((f) => f.kind)).toEqual(['syntax', 'runtime']);
  });

  describe('each kind is handled as specified by the validator', () => {
    let validator: Validator;
    beforeAll(async () => {
      const known = new Set(['bd', 'hh', 'sawtooth', 'triangle']);
      validator = new Validator({ backend: await Sandbox.create(), hasSound: (k) => known.has(k), cps: () => 0.5 });
    });

    const expected: Record<FaultKind, Partial<ValidationResult>> = {
      syntax: { ok: false, reason: 'syntax' },
      'unknown-function': { ok: false, reason: 'eval' },
      'unknown-sample': { ok: true, warnings: ['unknown-sample'], unknownSounds: ['zzzz'] },
      runtime: { ok: false, reason: 'query' },
      // A warning even though the other lines of the stack keep sounding.
      empty: { ok: true, warnings: ['empty'], eventCount: 0 },
      identical: { ok: false, reason: 'identical' },
      duplicate: { ok: false, reason: 'duplicate' },
    };
    const lines = ['s("bd*4")', HH, 'note("c2 [~ c2] eb2 g1").s("sawtooth").lpf(800)'];

    for (const kind of FAULT_KINDS) {
      for (const line of lines) {
        it(`${kind} on ${line}`, async () => {
          // With and without the trailing comma of a whole-line selection, where the buffer has one.
          for (const text of [line, line + ','].filter((t) => STARTER_CODE.includes(t))) {
            const from = STARTER_CODE.indexOf(text);
            const req: OptionRequest = { ...request(), selection: { from, to: from + text.length, text } };
            // Option 1 is clean (so duplicate has something to copy); option 2 is the fault.
            const p = faulty({ faultKind: kind });
            const iter = p.generateOptions(req, new AbortController().signal)[Symbol.asyncIterator]();
            const clean = (await iter.next()).value as Option;
            p.faultRate = 1;
            const broken = (await iter.next()).value as Option;
            expect(p.faultLog.map((f) => f.kind)).toEqual([kind]);
            const r = await validator.validate(STARTER_CODE, { from, to: from + text.length }, broken, [clean]);
            expect(r).toMatchObject(expected[kind]);
          }
        });
      }
    }
  });
});
