import { beforeAll, describe, expect, it } from 'vitest';
import { LARGE_CHANGE_CHARS, changeSize } from '../src/diff';
import { feedbackFor, reasonLabel } from '../src/feedback';
import { STARTER_CODE } from '../src/options';
import { runRequest } from '../src/pipeline';
import type { Option, OptionRequest, Provider } from '../src/provider';
import { Sandbox } from '../src/sandbox';
import type { TrayEvent } from '../src/trayMachine';
import { Validator, type FixContext } from '../src/validator';

const HH = 's("hh*8").gain(0.6)';
const KICK = 's("bd*4")';
const broken = (hat: string, kick = KICK) => STARTER_CODE.replace(HH, hat).replace(KICK, kick);
const opt = (code: string, label = code): Option => ({ id: code, label, code });

let sandbox: Sandbox;
let validator: Validator;
beforeAll(async () => {
  sandbox = await Sandbox.create();
  validator = new Validator({ backend: sandbox, hasSound: (k) => ['bd', 'hh', 'sawtooth'].includes(k), cps: () => 0.5 });
});

/** Validates `fix` for the broken hi-hat `hat`, with the error the buffer really has. */
async function check(buffer: string, hat: string, fix: string, extra: Partial<FixContext> = {}) {
  const base = await sandbox.check(buffer, 0.5);
  if (base.ok) throw new Error('the buffer should be broken');
  const from = buffer.indexOf(hat);
  return validator.validate(buffer, { from, to: from + hat.length }, opt(fix), [], {
    fix: { originalError: { stage: base.stage, message: base.message }, ...extra },
  });
}

describe('fix-mode validation', () => {
  it('a fix passes when the whole spliced buffer works and the option sounds', async () => {
    const hat = 's("hh*8").gian(0.6)';
    const r = await check(broken(hat), hat, HH);
    expect(r).toMatchObject({ ok: true, warnings: [], eventScope: 'option', changeSize: 2 });
    expect(r.checkedAlone).toBeUndefined();
  });

  it('an option that still fails with the original error is `unfixed`', async () => {
    const hat = 's("hh*8").gian(0.6)';
    const r = await check(broken(hat), hat, 's("hh*8").gian(0.5)');
    expect(r).toMatchObject({ ok: false, reason: 'unfixed', message: 's(...).gian is not a function' });
  });

  it('still `unfixed` when the error moved (positions are ignored)', async () => {
    const hat = 's("hh*8).gain(0.6)';
    const r = await check(broken(hat), hat, 's("hh*16).gain(0.6)');
    expect(r).toMatchObject({ ok: false, reason: 'unfixed' });
  });

  it('a new error of its own is dropped under its own stage, not as unfixed', async () => {
    const hat = 's("hh*8").gian(0.6)';
    const r = await check(broken(hat), hat, 's("hh*8").gain(0.6).zork(1)');
    expect(r).toMatchObject({ ok: false, reason: 'eval', message: 's(...).gain(...).zork is not a function' });
  });

  it('the milestone 4 "same error as the buffer" path does not apply: no `buffer` drop, no silent pass', async () => {
    const hat = 's("hh*8").gian(0.6)';
    const r = await check(broken(hat), hat, `${hat}.fast(2)`);
    expect(r.reason).toBe('unfixed');
  });

  it('identical text is still dropped', async () => {
    const hat = 's("hh*8").gian(0.6)';
    expect(await check(broken(hat), hat, 's( "hh*8").gian(0.6)')).toMatchObject({ ok: false, reason: 'identical', identicalBy: 'text' });
  });

  it('with errors elsewhere (judgeAlone), the option is judged on its own and badged', async () => {
    const hat = 's("hh*8").fast("double").gain(0.6)';
    const buffer = broken(hat, 's("bd*4").gian(2)');
    const from = buffer.indexOf(hat);
    const r = await validator.validate(buffer, { from, to: from + hat.length }, opt(HH), [], {
      fix: { originalError: { stage: 'query', message: 'Invalid argument' }, judgeAlone: true },
    });
    expect(r).toMatchObject({ ok: true, checkedAlone: true });
  });

  it('a fix whose buffer then fails on another line it can be told apart from is judged alone', async () => {
    // Two mistakes: a missing quote on the hats, and an unknown method on the kick. Fixing the quote
    // uncovers the kick's error, which is located outside the option.
    const hat = 's("hh*8).gain(0.6)';
    const r = await check(broken(hat, 's("bd*4").wobble(2)'), hat, HH);
    expect(r).toMatchObject({ ok: true, checkedAlone: true });
  });

  it('when the original was silent, a still-silent option is `unfixed`, not a silent card', async () => {
    const hat = 's(0.6).gain("hh*8")';
    const buffer = broken(hat);
    const from = buffer.indexOf(hat);
    const fix = { originalError: { stage: 'silent', message: 'It runs but makes no sound.' } };
    const still = await validator.validate(buffer, { from, to: from + hat.length }, opt('s(0.6).gain("hh*16")'), [], { fix });
    expect(still).toMatchObject({ ok: false, reason: 'unfixed', message: 'It runs but makes no sound.' });
    expect(feedbackFor('unfixed', { message: still.message })).toBe('This still fails with: It runs but makes no sound. Return code that fixes this error.');
    expect(await validator.validate(buffer, { from, to: from + hat.length }, opt(HH), [], { fix })).toMatchObject({ ok: true, warnings: [] });
  });

  it('a silent fix passes with the `empty` warning (the pipeline retries it)', async () => {
    const hat = 's("hh*8").gian(0.6)';
    expect(await check(broken(hat), hat, 's("hh*8").gain(0.6).mask("0")')).toMatchObject({ ok: true, warnings: ['empty'] });
  });
});

describe('the pipeline in fix mode', () => {
  const hat = 's("hh*8").gian(0.6)';
  const buffer = broken(hat);
  const from = buffer.indexOf(hat);
  const range = { from, to: from + hat.length };

  /** Returns `first`, then `retry` for the replacement request; records the requests. */
  function scripted(first: Option[], retry: Option) {
    const requests: OptionRequest[] = [];
    const provider: Provider = {
      name: 'scripted',
      async *generateOptions(req) {
        requests.push(req);
        if (req.feedback) yield retry;
        else yield* first;
      },
    };
    return { provider, requests };
  }

  async function run(provider: Provider) {
    const events: TrayEvent[] = [];
    const req: OptionRequest = { mode: 'fix-minimal', buffer, selection: { ...range, text: hat }, instruction: '', error: 's(...).gian is not a function', cps: 0.5 };
    await runRequest(
      { provider, validator, getBuffer: () => buffer, getRange: () => range, emit: (e) => events.push(e) },
      1,
      req,
      2,
      new AbortController().signal,
      { originalError: { stage: 'eval', message: 's(...).gian is not a function' } },
    );
    return events;
  }

  it('retries an unfixed option once with "This still fails with: …", and the fix fills the slot', async () => {
    const { provider, requests } = scripted([opt('s("hh*8").gian(0.5)')], opt(HH, 'gain not gian'));
    const events = await run(provider);
    expect(events.map((e) => e.type)).not.toContain('bufferChecked'); // no baseline in fix modes
    expect(events.find((e) => e.type === 'optionRetrying')).toMatchObject({ reason: 'unfixed' });
    expect(requests[1].feedback?.error).toBe('This still fails with: s(...).gian is not a function. Return code that fixes this error.');
    expect(events.find((e) => e.type === 'optionValidated')).toMatchObject({ slot: 1, option: { label: 'gain not gian' }, changeSize: 2 });
  });

  it('a silent fix is retried like a silent shape option', async () => {
    const { provider } = scripted([opt('s("hh*8").gain(0.6).mask("0")')], opt(HH));
    const events = await run(provider);
    expect(events.find((e) => e.type === 'optionRetrying')).toMatchObject({ reason: 'empty' });
    expect(events.find((e) => e.type === 'optionValidated')).toMatchObject({ option: { code: HH } });
  });
});

describe('change size', () => {
  it.each([
    ['a missing quote', 's("hh*8).gain(0.6)', HH, 1],
    ['a swapped pair of letters', 's("hh*8").gian(0.6)', HH, 2],
    ['a missing paren', 's("hh*8".gain(0.6)', HH, 1],
    ['a renamed function', 's("hh*8").gain(sine())', 's("hh*8").gain(sine)', 2],
    ['nothing', HH, HH, 0],
  ])('%s', (_name, before, after, size) => {
    expect(changeSize(before, after)).toBe(size);
  });

  it('a rewrite is well above the large-change threshold', () => {
    expect(changeSize(HH, 's("[hh hh] ~ hh oh").gain(".6 .3").swingBy(1/3, 4)')).toBeGreaterThan(LARGE_CHANGE_CHARS);
  });
});

describe('unfixed feedback', () => {
  it('reads as an instruction and has a label', () => {
    expect(feedbackFor('unfixed', { message: 'Unexpected token (4:9)' })).toBe('This still fails with: Unexpected token (4:9). Return code that fixes this error.');
    expect(reasonLabel('unfixed')).toBe('still broken');
  });
});
