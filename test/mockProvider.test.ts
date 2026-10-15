import { beforeAll, describe, expect, it } from 'vitest';
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import { transpiler } from '@strudel/transpiler';
import { MockProvider, TRANSFORMS, type Sleep } from '../src/mockProvider';
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

  it('fix modes return one unchanged option', async () => {
    for (const mode of ['fix-minimal', 'fix-rewrite'] as Mode[]) {
      const opts = await collect(noDelay().generateOptions(request('', mode), new AbortController().signal));
      expect(opts).toEqual([{ id: expect.any(String), label: 'mock fix', code: HH }]);
    }
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
