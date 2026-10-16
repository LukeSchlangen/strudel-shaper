import { describe, expect, it } from 'vitest';
import { MockProvider } from '../src/mockProvider';
import { STARTER_CODE } from '../src/options';
import { runRequest, type PipelineDeps } from '../src/pipeline';
import type { Option, OptionRequest, Provider } from '../src/provider';
import { Sandbox, type CheckResult } from '../src/sandbox';
import { splice, type Range } from '../src/splice';
import type { TrayEvent } from '../src/trayMachine';
import { Validator, type ValidationBackend } from '../src/validator';

const SEL = 'abc';
const BUFFER = `xx${SEL}xx`;
const RANGE: Range = { from: 2, to: 5 };
const req: OptionRequest = { mode: 'shape', buffer: BUFFER, selection: { ...RANGE, text: SEL }, instruction: '', cps: 0.5 };

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Codes containing BAD fail at syntax; everything else passes. Records the buffers it saw. */
class FakeBackend implements ValidationBackend {
  seen: string[] = [];
  gate: Promise<void> | null = null;
  async check(code: string): Promise<CheckResult> {
    this.seen.push(code);
    if (this.gate) await this.gate;
    return code.includes('BAD')
      ? { ok: false, stage: 'syntax', message: 'Unexpected token', ms: 2 }
      : { ok: true, eventCount: 8, sounds: [], ms: 3 };
  }
}

/** Yields `stream` in order (waiting on optional gates); answers feedback requests from `replacements`. */
class ScriptedProvider implements Provider {
  name = 'scripted';
  log: string[] = [];
  requests: OptionRequest[] = [];
  constructor(
    private stream: Array<string | Promise<void>>,
    private replacements: Array<string | Promise<string>> = [],
  ) {}
  async *generateOptions(r: OptionRequest, signal: AbortSignal): AsyncGenerator<Option> {
    this.requests.push(r);
    if (r.feedback) {
      this.log.push(`retry for ${r.feedback.previousCode}`);
      const code = await this.replacements.shift()!;
      if (signal.aborted) return;
      yield { id: code, label: code, code };
      return;
    }
    for (const item of this.stream) {
      if (typeof item !== 'string') {
        await item;
        continue;
      }
      if (signal.aborted) return;
      this.log.push(`yield ${item}`);
      yield { id: item, label: item, code: item };
    }
  }
}

function setup(provider: Provider, backend = new FakeBackend(), deps: Partial<PipelineDeps> = {}) {
  const events: TrayEvent[] = [];
  const validator = new Validator({ backend, hasSound: () => true, cps: () => 0.5 });
  const controller = new AbortController();
  const full: PipelineDeps = { provider, validator, getBuffer: () => BUFFER, getRange: () => RANGE, emit: (e) => events.push(e), ...deps };
  const run = () => runRequest(full, 7, req, 4, controller.signal);
  // bufferChecked (the baseline) comes first in every request; it has its own tests below.
  const summary = () => events.filter((e) => e.type !== 'bufferChecked').map((e) => ('slot' in e ? `${e.type} ${e.slot}${'option' in e ? ` ${e.option.code}` : ''}${'reason' in e ? ` ${e.reason}` : ''}` : e.type));
  return { events, run, controller, backend, summary };
}

describe('runRequest', () => {
  it('validates each option and finishes with requestDone', async () => {
    const t = setup(new ScriptedProvider(['abc.a()', 'abc.b()']));
    await t.run();
    expect(t.summary()).toEqual([
      'optionArrived 1 abc.a()',
      'optionArrived 2 abc.b()',
      'optionValidated 1 abc.a()',
      'optionValidated 2 abc.b()',
      'requestDone',
    ]);
    expect(t.events.every((e) => !('requestId' in e) || e.requestId === 7)).toBe(true);
    // The unmodified buffer is checked once, first.
    expect(t.backend.seen).toEqual([BUFFER, splice(BUFFER, RANGE, 'abc.a()'), splice(BUFFER, RANGE, 'abc.b()')]);
  });

  it('retries a failed option once with feedback; the replacement fills the same slot', async () => {
    const provider = new ScriptedProvider(['abc.a()', 'abc.BAD(', 'abc.c()'], ['abc.fixed()']);
    const t = setup(provider);
    await t.run();
    expect(t.summary()).toEqual([
      'optionArrived 1 abc.a()',
      'optionArrived 2 abc.BAD(',
      'optionArrived 3 abc.c()',
      'optionValidated 1 abc.a()',
      'optionRetrying 2 syntax',
      'optionValidated 3 abc.c()',
      'optionArrived 2 abc.fixed()',
      'optionValidated 2 abc.fixed()',
      'requestDone',
    ]);
    const retry = provider.requests[1];
    expect(retry.feedback).toEqual({
      previousCode: 'abc.BAD(',
      error: 'This code has a syntax error (Unexpected token). Return valid Strudel code: check brackets, quotes and mini-notation.',
    });
    expect(retry.selection).toEqual({ ...RANGE, text: SEL });
  });

  it('drops the slot for good when the replacement fails too', async () => {
    const t = setup(new ScriptedProvider(['abc.BAD('], ['abc.BAD2(']));
    await t.run();
    expect(t.summary()).toEqual([
      'optionArrived 1 abc.BAD(',
      'optionRetrying 1 syntax',
      'optionArrived 1 abc.BAD2(',
      'optionDropped 1 syntax',
      'requestDone',
    ]);
  });

  it('identical and duplicate are retried with plain-words feedback', async () => {
    const provider = new ScriptedProvider([' abc', 'abc.x()', 'abc.x( )'], ['abc.y()', 'abc.z()']);
    const t = setup(provider);
    await t.run();
    const feedback = provider.requests.slice(1).map((r) => r.feedback!.error);
    expect(feedback).toEqual([
      'This option is the same as the original selection. Suggest a different variation.',
      'This option is the same as option 2. Suggest a different variation.',
    ]);
    expect(t.summary().filter((s) => s.startsWith('optionValidated'))).toEqual([
      'optionValidated 2 abc.x()',
      'optionValidated 1 abc.y()',
      'optionValidated 3 abc.z()',
    ]);
  });

  it('retries run alongside the rest of the stream', async () => {
    const gate = deferred();
    const provider = new ScriptedProvider(['abc.BAD(', gate.promise, 'abc.b()'], ['abc.fixed()']);
    const t = setup(provider);
    const done = t.run();
    await tick();
    // The stream is held at the gate, and the retry has already been asked for.
    expect(provider.log).toEqual(['yield abc.BAD(', 'retry for abc.BAD(']);
    gate.resolve();
    await done;
    expect(provider.log).toEqual(['yield abc.BAD(', 'retry for abc.BAD(', 'yield abc.b()']);
  });

  it('requestDone waits for a pending retry', async () => {
    const replacement = deferred<string>();
    const t = setup(new ScriptedProvider(['abc.BAD('], [replacement.promise]));
    const done = t.run();
    await tick();
    expect(t.summary()).toEqual(['optionArrived 1 abc.BAD(', 'optionRetrying 1 syntax']);
    replacement.resolve('abc.ok()');
    await done;
    expect(t.summary().slice(-2)).toEqual(['optionValidated 1 abc.ok()', 'requestDone']);
  });

  it('an abort during a retry stops all further events, including requestDone', async () => {
    const replacement = deferred<string>();
    const t = setup(new ScriptedProvider(['abc.BAD(', 'abc.b()'], [replacement.promise]));
    const done = t.run();
    await tick();
    const before = t.summary();
    expect(before).toContain('optionRetrying 1 syntax');
    t.controller.abort();
    replacement.resolve('abc.ok()');
    await done;
    expect(t.summary()).toEqual(before);
  });

  it('an abort while validations are queued skips them', async () => {
    const backend = new FakeBackend();
    const gate = deferred();
    backend.gate = gate.promise;
    const t = setup(new ScriptedProvider(['abc.a()', 'abc.b()']), backend);
    const done = t.run();
    await tick();
    t.controller.abort();
    gate.resolve();
    await done;
    expect(backend.seen).toHaveLength(1); // the baseline; neither option was checked
    expect(t.summary()).toEqual(['optionArrived 1 abc.a()', 'optionArrived 2 abc.b()']);
  });

  it('reads the buffer and range when each validation runs, not when the option arrived', async () => {
    const backend = new FakeBackend();
    const gate = deferred();
    backend.gate = gate.promise;
    let buffer = BUFFER;
    let range = RANGE;
    const t = setup(new ScriptedProvider(['abc.a()', 'abc.b()']), backend, { getBuffer: () => buffer, getRange: () => range });
    const done = t.run();
    await tick();
    // An edit before the range while the first validation is in flight shifts it.
    buffer = `>>${BUFFER}`;
    range = { from: RANGE.from + 2, to: RANGE.to + 2 };
    gate.resolve();
    await done;
    expect(backend.seen[2]).toBe(splice(buffer, range, 'abc.b()'));
  });

  it('ignores options beyond the slot count', async () => {
    const t = setup(new ScriptedProvider(['abc.1()', 'abc.2()', 'abc.3()', 'abc.4()', 'abc.5()']));
    await t.run();
    expect(t.summary().filter((s) => s.startsWith('optionValidated'))).toHaveLength(4);
  });
});

describe('runRequest with the faulty mock and the real sandbox', () => {
  const lines = ['s("bd*4"),', 's("hh*8").gain(0.6),', 'note("c2 [~ c2] eb2 g1").s("sawtooth").lpf(800)'];

  async function soak(retryFails: boolean) {
    const sandbox = await Sandbox.create();
    const known = new Set(['bd', 'hh', 'sawtooth', 'triangle']);
    const validator = new Validator({ backend: sandbox, hasSound: (k) => known.has(k), cps: () => 0.5 });
    const provider = new MockProvider({ seed: 3, minDelayMs: 0, maxDelayMs: 0, faultRate: 0.5, retryFails });
    const ready: Array<{ code: string; range: Range }> = [];
    const outcomes: string[] = [];
    const sameSound: string[] = [];
    for (let i = 0; i < 30; i++) {
      const text = lines[i % 3];
      const from = STARTER_CODE.indexOf(text);
      const range = { from, to: from + text.length };
      const r: OptionRequest = { ...req, buffer: STARTER_CODE, selection: { ...range, text } };
      const lastArrived = new Map<number, string>();
      const deps: PipelineDeps = {
        provider,
        validator,
        getBuffer: () => STARTER_CODE,
        getRange: () => range,
        emit: (e) => {
          if (e.type === 'optionArrived') lastArrived.set(e.slot, e.option.code);
          if (e.type === 'optionValidated') ready.push({ code: e.option.code, range });
          if (e.type === 'optionValidated') outcomes.push(e.type);
          if (e.type === 'optionDropped') outcomes.push(e.message.includes('sounds exactly') ? 'optionDropped (sounds the same)' : `optionDropped (${e.reason}: ${e.message})`);
          if (e.type === 'optionRetrying' && e.message.includes('sounds exactly')) sameSound.push(lastArrived.get(e.slot) ?? '');
          if (e.type === 'optionRetrying') outcomes.push(['empty', 'unknown-sample'].includes(e.reason) ? 'optionRetrying (silent)' : e.type);
        },
      };
      await runRequest(deps, i, r, 4, new AbortController().signal);
    }
    return { sandbox, provider, ready, outcomes, sameSound };
  }

  it('no option that fails to evaluate is ever validated; every fault kind shows up', async () => {
    const { sandbox, provider, ready, outcomes, sameSound } = await soak(false);
    for (const { code, range } of ready) {
      expect(await sandbox.check(splice(STARTER_CODE, range, code), 0.5)).toMatchObject({ ok: true });
    }
    const hard = new Set(provider.faultLog.filter((f) => ['syntax', 'unknown-function', 'runtime'].includes(f.kind)).map((f) => f.code));
    expect(ready.some((r) => hard.has(r.code))).toBe(false);
    expect(new Set(provider.faultLog.map((f) => f.kind)).size).toBe(7);
    expect(outcomes).toContain('optionRetrying');
    // Replacements are valid by default. What is dropped for good: the mock's `.rev()` on a uniform
    // line (`bd*4`, `hh*8`) plays exactly the original, so the sounds-identical check retries it, and
    // its replacement can run out of the mock's 7 transforms (a duplicate; see NOTES.md, milestone 3).
    expect(sameSound.length).toBeGreaterThan(0);
    expect(sameSound.every((code) => /\.rev\(\),?$/.test(code))).toBe(true);
    for (const o of outcomes.filter((o) => o.startsWith('optionDropped'))) expect(o).toMatch(/sounds the same|duplicate/);
  });

  it('with retryFails, failed slots are dropped for good; silent ones keep their original', async () => {
    const { outcomes } = await soak(true);
    expect(outcomes.filter((o) => o.startsWith('optionDropped')).length).toBe(outcomes.filter((o) => o === 'optionRetrying').length);
    expect(outcomes).toContain('optionRetrying (silent)');
  });
});
