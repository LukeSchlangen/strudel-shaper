import { describe, expect, it } from 'vitest';
import * as core from '@strudel/core';
import { transpiler } from '@strudel/transpiler';
import { Sandbox } from '../src/sandbox';
import { STARTER_CODE } from '../src/options';
import { Validator } from '../src/validator';

/**
 * In the browser the sandbox lives in a worker, a separate realm. Here it shares the realm with a
 * stand-in "live" repl, which is the harder case: the live repl's tempo and sounds must still be
 * untouched, and its own setcps must still reach its own scheduler afterwards.
 */
describe('validation leaves the live session alone', () => {
  it('tempo, sound map and prototype are untouched; stubs absorb side effects', async () => {
    const live = core.repl({ transpiler, getTime: () => 0, defaultOutput: () => {}, setInterval: () => 0, clearInterval: () => {} });
    await live.evaluate(STARTER_CODE, false);
    expect(live.scheduler.cps).toBe(0.5);
    const livePattern = live.scheduler.pattern;

    const sounds = new Set(['bd', 'hh', 'sawtooth', 'triangle']);
    const soundsBefore = [...sounds];
    const sandbox = await Sandbox.create();
    sandbox.installStubs({ globals: ['samples', 'registerSound', 'aliasBank'], methods: ['pianoroll'] });
    const validator = new Validator({ backend: sandbox, hasSound: (k) => sounds.has(k), cps: () => live.scheduler.cps });

    const buffer = `setcps(1)
samples('github:someone/somewhere')
registerSound('zz', () => {})
register('wobble', (n, pat) => pat.fast(n))
hush()
stack(
  s("bd*4"),
  s("hh*8").gain(0.6).wobble(2).pianoroll(),
)`;
    const sel = 's("bd*4")';
    const from = buffer.indexOf(sel);
    const r = await validator.validate(buffer, { from, to: from + sel.length }, { id: '1', label: 'x', code: 's("bd*2")' }, []);
    expect(r).toMatchObject({ ok: true, warnings: [] });

    // The sandbox's own scheduler took setcps(1); the live one didn't.
    expect(live.scheduler.cps).toBe(0.5);
    expect(live.scheduler.pattern).toBe(livePattern);
    expect(live.scheduler.started).toBe(false);
    expect([...sounds]).toEqual(soundsBefore);
    expect(sandbox.stubCalls).toEqual(['samples', 'registerSound', '.pianoroll']);
    // register() inside the check doesn't leak into the next one.
    expect('wobble' in core.Pattern.prototype).toBe(false);
    expect((globalThis as any).wobble).toBeUndefined();

    // The live repl re-installs its own setcps on evaluate, so it still drives its own scheduler.
    await live.evaluate('setcps(0.7)\ns("bd")', false);
    expect(live.scheduler.cps).toBe(0.7);
  });

  it('slider stubs return their value, so a slider-driven option still sounds', async () => {
    const sandbox = await Sandbox.create();
    sandbox.installStubs({ globals: ['sliderWithID', 'slider'], methods: [] });
    // The transpiler rewrites slider(…) to sliderWithID(id, …).
    expect(await sandbox.check('s("hh*4").gain(slider(0.5, 0, 1))', 0.5)).toMatchObject({ ok: true, eventCount: 8 });
    expect(sandbox.stubCalls).toEqual(['sliderWithID']);
  });

  it('a later check does not see globals assigned by an earlier one', async () => {
    const sandbox = await Sandbox.create();
    expect(await sandbox.check('globalThis.leak = s("hh")\nleak', 0.5)).toMatchObject({ ok: true });
    expect(await sandbox.check('leak', 0.5)).toMatchObject({ ok: false, stage: 'eval' });
  });
});
