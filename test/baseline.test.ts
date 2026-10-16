import { beforeAll, describe, expect, it } from 'vitest';
import { SILENCE_WORDS, asksForSilence, feedbackFor, reasonLabel } from '../src/feedback';
import { runRequest, silentRetryReason, type PipelineDeps } from '../src/pipeline';
import type { Option, OptionRequest, Provider, ProviderHooks } from '../src/provider';
import { Sandbox } from '../src/sandbox';
import type { TrayEvent } from '../src/trayMachine';
import { Validator, sameError, tempoLines, type ValidationResult } from '../src/validator';

const GOOD = `setcps(0.5)
stack(
  s("bd*4"),
  s("hh*8").gain(0.6)
)`;
// Line 4 refers to a function that doesn't exist: the whole buffer fails to evaluate.
const BROKEN_EVAL = GOOD.replace('s("bd*4")', 's("bd*4").wobble(2)');
// An unclosed string on the kick line: the whole buffer fails to transpile.
const BROKEN_SYNTAX = GOOD.replace('s("bd*4")', 's("bd*4)');
const HAT = 's("hh*8").gain(0.6)';

const range = (buffer: string) => {
  const from = buffer.indexOf(HAT);
  return { from, to: from + HAT.length };
};
const opt = (code: string, id = code): Option => ({ id, label: id, code });

let sandbox: Sandbox;
let validator: Validator;
beforeAll(async () => {
  sandbox = await Sandbox.create();
  validator = new Validator({ backend: sandbox, hasSound: (k) => ['bd', 'hh', 'sd'].includes(k), cps: () => 0.5 });
});

describe('Validator.baseline and checking alone', () => {
  it('a healthy buffer passes its baseline', async () => {
    expect(await validator.baseline(GOOD)).toMatchObject({ ok: true, fingerprint: expect.any(String) });
  });

  it.each([
    ['eval', BROKEN_EVAL],
    ['syntax', BROKEN_SYNTAX],
  ])('with a broken line elsewhere (%s), a healthy option is checked alone and kept', async (stage, buffer) => {
    const baseline = await validator.baseline(buffer);
    expect(baseline).toMatchObject({ ok: false, stage });
    const r = await validator.validate(buffer, range(buffer), opt('s("hh*16").gain(0.5)'), [], { baseline });
    expect(r).toMatchObject({ ok: true, checkedAlone: true, eventScope: 'option', eventCount: 32 });
  });

  it('without the baseline, the same option is blamed for the buffer’s error (milestone 3 behaviour)', async () => {
    const r = await validator.validate(BROKEN_EVAL, range(BROKEN_EVAL), opt('s("hh*16")'), []);
    expect(r).toMatchObject({ ok: false, reason: 'eval' });
  });

  it('an option that is broken in its own way is still dropped for its own error', async () => {
    const baseline = await validator.baseline(BROKEN_SYNTAX);
    const r = await validator.validate(BROKEN_SYNTAX, range(BROKEN_SYNTAX), opt('s("hh*16").zork(1)'), [], { baseline });
    expect(r).toMatchObject({ ok: false, reason: 'eval' });
    expect(r.message).toMatch(/zork/);
  });

  it('an option that fails alone with the buffer’s own error is dropped as `buffer`', async () => {
    const baseline = await validator.baseline(BROKEN_EVAL);
    const r = await validator.validate(BROKEN_EVAL, range(BROKEN_EVAL), opt('s("hh*16").wobble(2)'), [], { baseline });
    expect(r).toMatchObject({ ok: false, reason: 'buffer' });
  });

  it('a selection that is itself broken: options that fix it pass normally', async () => {
    const buffer = GOOD.replace(HAT, 's("hh*8").gain(0.6).wobble(1)');
    const sel = 's("hh*8").gain(0.6).wobble(1)';
    const from = buffer.indexOf(sel);
    const baseline = await validator.baseline(buffer);
    const r = await validator.validate(buffer, { from, to: from + sel.length }, opt('s("hh*8").gain(0.4)'), [], { baseline });
    expect(r).toMatchObject({ ok: true });
    expect(r.checkedAlone).toBeUndefined();
  });

  it('tempoLines keeps only top-level tempo calls; sameError ignores positions', () => {
    expect(tempoLines('setcps(0.5)\n  setcpm(120);\nstack(s("bd").setcps(2))\n// setcps(9)')).toBe('setcps(0.5)\nsetcpm(120);\n');
    expect(sameError({ stage: 'syntax', message: 'Unexpected token (3:4)' }, { stage: 'syntax', message: 'Unexpected token (5:4)' })).toBe(true);
    expect(sameError({ stage: 'syntax', message: 'x' }, { stage: 'eval', message: 'x' })).toBe(false);
  });
});

describe('SILENCE_WORDS / asksForSilence', () => {
  it.each([
    'drop the hats',
    'mute the kick',
    'silence',
    'make it silent',
    'remove the bass',
    'stop the hats',
    'cut the hats in the second half',
    'take the snare out',
    'dropped hats',
    'muting',
    'Stopping',
    'cutting',
  ])('"%s" asks for silence', (i) => expect(asksForSilence(i)).toBe(true));

  it.each(['', 'busier', 'lower the cutoff', 'more output', 'darker', 'less busy', 'half-time feel', 'without the fills', 'shout', 'droplets'])(
    '"%s" does not',
    (i) => expect(asksForSilence(i)).toBe(false),
  );

  it('the list is the documented one', () => {
    expect([...SILENCE_WORDS]).toEqual(['drop', 'mute', 'silence', 'silent', 'remove', 'stop', 'cut', 'out']);
  });
});

describe('feedbackFor', () => {
  it('reads as instructions, not log lines', () => {
    const all = [
      feedbackFor('syntax', { message: 'Unexpected token (3:4)' }),
      feedbackFor('eval', { message: 's(...).wobble is not a function' }),
      feedbackFor('eval', { message: 'Cannot read properties of undefined' }),
      feedbackFor('query', { message: "Cannot read properties of undefined (reading 'toFixed')" }),
      feedbackFor('timeout'),
      feedbackFor('empty'),
      feedbackFor('unknown-sample', { unknownSounds: ['zzzz'], soundHint: 'bd sd hh oh cp' }),
      feedbackFor('identical'),
      feedbackFor('duplicate', { twinSlot: 2 }),
    ];
    for (const f of all) {
      expect(f).toMatch(/\b(Return|Use|Suggest)\b/);
      expect(f).not.toMatch(/^\w+:/); // not "syntax: …"
    }
    expect(all[1]).toBe('`wobble` is not a Strudel function here. Use only functions from the reference.');
    expect(all[5]).toBe('This option produces no sound. Return a variation that still plays.');
    expect(all[6]).toBe('`zzzz` is not a loaded sound. Use only loaded sounds, for example: bd sd hh oh cp.');
  });

  it('labels every reason', () => {
    expect(reasonLabel('buffer')).toBe('buffer error');
    expect(reasonLabel('empty')).toBe('no sound');
    expect(reasonLabel('eval', 'foo is not defined')).toBe('unknown function');
  });
});

describe('silent-option retries', () => {
  const warned = (warnings: ValidationResult['warnings']): ValidationResult => ({ ok: true, warnings, eventCount: 0, ms: 1 });

  it('retries empty and unknown-sample, except empty when silence was asked for', () => {
    expect(silentRetryReason(warned(['empty']), '')).toBe('empty');
    expect(silentRetryReason(warned(['empty']), 'drop the hats')).toBeNull();
    expect(silentRetryReason(warned(['unknown-sample']), 'drop the hats')).toBe('unknown-sample');
    expect(silentRetryReason(warned([]), '')).toBeNull();
  });

  /** First stream from `stream`; each feedback request gets the next of `replacements`. */
  class Scripted implements Provider {
    name = 'scripted';
    requests: OptionRequest[] = [];
    constructor(
      private stream: string[],
      private replacements: string[] = [],
    ) {}
    async *generateOptions(r: OptionRequest, _signal: AbortSignal, hooks?: ProviderHooks) {
      this.requests.push(r);
      hooks?.onStats?.({ firstMs: r.feedback ? 900 : 300, tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 }, costUsd: 0.001 });
      const codes = r.feedback ? [this.replacements.shift()!] : this.stream;
      for (const c of codes) yield opt(c);
    }
  }

  async function run(provider: Scripted, instruction = '', buffer = GOOD) {
    const events: TrayEvent[] = [];
    const deps: PipelineDeps = {
      provider,
      validator,
      getBuffer: () => buffer,
      getRange: () => range(buffer),
      emit: (e) => events.push(e),
      soundHint: () => 'bd sd hh',
    };
    const req: OptionRequest = { mode: 'shape', buffer, selection: { ...range(buffer), text: HAT }, instruction, cps: 0.5 };
    await runRequest(deps, 1, req, 4, new AbortController().signal);
    return events;
  }
  const brief = (events: TrayEvent[]) =>
    events.filter((e) => e.type !== 'optionArrived').map((e) => `${e.type}${'slot' in e ? ` ${e.slot}` : ''}${'reason' in e ? ` ${e.reason}` : ''}${e.type === 'optionValidated' ? ` ${e.option.code}${e.warnings.length ? ` [${e.warnings}]` : ''}` : ''}`);

  it('an empty option is retried with app-written feedback, and the replacement fills the slot', async () => {
    const p = new Scripted(['s("hh*8").degradeBy(1)'], ['s("hh*4")']);
    const events = await run(p);
    expect(brief(events)).toEqual(['bufferChecked', 'optionRetrying 1 empty', 'optionValidated 1 s("hh*4")', 'requestDone']);
    expect(p.requests[1].feedback).toEqual({ previousCode: 's("hh*8").degradeBy(1)', error: 'This option produces no sound. Return a variation that still plays.' });
  });

  it('an unknown sound is retried with the loaded names', async () => {
    const p = new Scripted(['s("zzzz*8")'], ['s("sd*8")']);
    await run(p);
    expect(p.requests[1].feedback!.error).toBe('`zzzz` is not a loaded sound. Use only loaded sounds, for example: bd sd hh.');
  });

  it('when the instruction asks for silence, an empty option is kept without a retry', async () => {
    const p = new Scripted(['s("hh*8").degradeBy(1)']);
    const events = await run(p, 'drop the hats');
    expect(brief(events)).toEqual(['bufferChecked', 'optionValidated 1 s("hh*8").degradeBy(1) [empty]', 'requestDone']);
    expect(p.requests).toHaveLength(1);
  });

  it('a retry that is still silent keeps its badge', async () => {
    const events = await run(new Scripted(['s("hh*8").degradeBy(1)'], ['s("hh*4").mask(0)']));
    expect(brief(events)).toContain('optionValidated 1 s("hh*4").mask(0) [empty]');
  });

  it('a retry that fails hard falls back to the original warned option', async () => {
    const events = await run(new Scripted(['s("hh*8").degradeBy(1)'], ['s("hh*4"']));
    expect(brief(events)).toEqual(['bufferChecked', 'optionRetrying 1 empty', 'optionValidated 1 s("hh*8").degradeBy(1) [empty]', 'requestDone']);
  });

  it('with a broken buffer: the status gets the error, healthy options are kept alone, no retries spent', async () => {
    const p = new Scripted(['s("hh*16")', 's("hh*4").wobble(2)']);
    const events = await run(p, '', BROKEN_EVAL);
    expect(events.find((e) => e.type === 'bufferChecked')).toMatchObject({ type: 'bufferChecked', error: expect.stringMatching(/wobble/) });
    const ok = events.find((e) => e.type === 'optionValidated');
    expect(ok).toMatchObject({ slot: 1, checkedAlone: true });
    expect(events.find((e) => e.type === 'optionDropped')).toMatchObject({ slot: 2, reason: 'buffer' });
    expect(p.requests).toHaveLength(1);
  });

  it('requestDone carries usage summed over the first call and its retries', async () => {
    const events = await run(new Scripted(['s("hh*8").degradeBy(1)'], ['s("hh*4")']));
    const done = events.at(-1) as Extract<TrayEvent, { type: 'requestDone' }>;
    expect(done.stats).toMatchObject({ calls: 2, firstMs: 300, costUsd: 0.002, tokens: { input: 20, output: 10, cacheRead: 200, cacheWrite: 0 } });
  });
});
