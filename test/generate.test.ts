import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { ROLE, userMessage } from '../server/prompt';
import { buildParams, streamClaudeOptions, type ClaudeDeps } from '../server/providers/claude';
import { GEMINI_MODE_DEFAULT_MODELS, MODE_DEFAULT_MODELS, defaultModelFor } from '../server/providers/models';
import { RateLimiter } from '../server/rateLimit';
import { generateCapture, noRunnableCode } from '../src/generate';
import { IDEAS, MockProvider, pickIdeas, prng } from '../src/mockProvider';
import { runRequest } from '../src/pipeline';
import type { Option, OptionRequest, Provider } from '../src/provider';
import { LineSplitter, type RemoteLine, type RemoteRequest } from '../src/remoteProtocol';
import { modelForMode } from '../src/remoteProvider';
import { Sandbox, type CheckResult } from '../src/sandbox';
import { initialState, slotCount, transition, type Effect, type TrayEvent, type TrayState } from '../src/trayMachine';
import { Validator, type ValidationBackend } from '../src/validator';
import { FakeMessages, textEvents } from './fakeAnthropic';

const sounds = new Set(JSON.parse(readFileSync(fileURLToPath(new URL('../src/generated/sounds.json', import.meta.url)), 'utf8')) as string[]);
const COMMENTS = '// my first track\n// something slow\n';

/** A generate request on `buffer`, as main.ts builds it. */
function generateRequest(buffer = '', instruction = ''): OptionRequest {
  const { range, text } = generateCapture(buffer);
  return { mode: 'generate', buffer, selection: { ...range, text }, instruction, cps: 0.5 };
}

const collect = async <T>(iter: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
};

describe('noRunnableCode', () => {
  it.each([
    ['empty', ''],
    ['whitespace', '  \n\t\n  '],
    ['line comments', '// my first track\n  // something slow\n'],
    ['a block comment', '/* ideas:\n   a bassline */\n'],
    ['both kinds', '/* a */ // b\n\n// c'],
  ])('is true for %s', (_name, text) => expect(noRunnableCode(text)).toBe(true));

  it.each([
    ['code', 's("bd*4")'],
    ['code with comments', '// drums\ns("bd*4") // kick\n/* more */'],
    ['code after a block comment', '/* intro */ setcps(0.5)'],
    ['a string holding //', 's("//")'],
    ['an unclosed block comment', '/* not closed'],
  ])('is false for %s', (_name, text) => expect(noRunnableCode(text)).toBe(false));

  it('generate captures the whole buffer, comments included', () => {
    expect(generateCapture(COMMENTS)).toEqual({ range: { from: 0, to: COMMENTS.length }, text: COMMENTS, buffer: COMMENTS });
    expect(generateCapture('').range).toEqual({ from: 0, to: 0 });
  });
});

describe('generate in the tray', () => {
  const capture = generateCapture('');
  const request: TrayEvent = { type: 'request', requestId: 1, capture, mode: 'generate', instruction: '' };
  const option: Option = { id: 'g1', label: 'acid bassline', code: 's("bd*4")' };
  const ready: TrayEvent[] = [
    request,
    { type: 'optionValidated', requestId: 1, slot: 1, option, warnings: [], ms: 1 },
    { type: 'requestDone', requestId: 1 },
    { type: 'audition', slot: 1 },
  ];
  function run(events: TrayEvent[], start: TrayState = initialState) {
    let state = start;
    let effects: Effect[] = [];
    for (const e of events) ({ state, effects } = transition(state, e));
    return { state, effects };
  }

  it('asks for 4 options', () => {
    expect(slotCount('generate')).toBe(4);
    expect(run([request]).state).toMatchObject({ kind: 'tray', slots: Array(4).fill({ status: 'pending' }) });
  });

  it('snapshots what plays when it opens, and 0/Esc go back to it (silence), never to the empty editor', () => {
    expect(transition(initialState, request).effects.map((e) => e.type)).toEqual(['snapshotPlaying', 'startRequest']);
    expect(run([...ready, { type: 'audition', slot: 1 }]).effects).toEqual([]); // already heard
    for (const back of [{ type: 'audition', slot: 0 }, { type: 'escape' }] as TrayEvent[]) {
      expect(run([...ready, back]).effects).toEqual([{ type: 'restoreSnapshot' }, { type: 'resumeHighlight' }]);
    }
    expect(run([...ready, { type: 'evalFailed', slot: 1 }]).effects).toEqual([{ type: 'restoreSnapshot' }, { type: 'resumeHighlight' }]);
  });

  it('Enter commits the whole buffer in generate mode, then evaluates it', () => {
    const { effects } = run([...ready, { type: 'enter' }]);
    expect(effects[0]).toEqual({ type: 'commit', capture, code: option.code, mode: 'generate' });
    expect(effects.slice(1).map((e) => e.type)).toEqual(['evaluateEditor', 'resumeHighlight']);
  });
});

describe('generate in the prompt', () => {
  const req = (instruction = '', buffer = ''): RemoteRequest => ({ ...generateRequest(buffer, instruction), provider: 'claude', model: 'claude-sonnet-5-5' });
  const deps = (client = new FakeMessages([])): ClaudeDeps => ({ client, reference: 'REFERENCE', maxTokens: 2048 });

  it('the rules live in the cached role, which every mode shares', () => {
    expect(ROLE).toContain('## Mode: generate');
    expect(ROLE).toContain('fix-rewrite or generate');
    expect(ROLE).toMatch(/tempo.*or the mode is generate/);
    const system = (r: RemoteRequest) => (buildParams(deps(), r).system as Anthropic.TextBlockParam[]).map((b) => b.text);
    expect(system(req())).toEqual(system({ ...req(), mode: 'shape', buffer: 'x', selection: { from: 0, to: 1, text: 'x' } }));
  });

  it('the user message names the mode and marks the whole buffer', () => {
    const u = userMessage(req());
    expect(u.startsWith('Mode: generate\n')).toBe(true);
    expect(u).toContain('```js\n/*<sel>*//*</sel>*/\n```');
    expect(userMessage(req('', COMMENTS))).toContain(`/*<sel>*/${COMMENTS}/*</sel>*/`);
    expect(u).not.toContain('## Mode');
  });

  it('with no instruction asks for four different ideas; with one, passes it on', () => {
    expect(userMessage(req())).toContain('Instruction: none. Offer four different starting ideas.');
    const u = userMessage(req('chill lofi beat'));
    expect(u).toContain('Instruction: chill lofi beat');
    expect(u).not.toContain('Instruction: none');
    expect(u).not.toContain('Problem in the marked code');
  });

  it('keeps 4 options and never uses the parallel strategy', async () => {
    const payload = JSON.stringify({ options: Array.from({ length: 5 }, (_, i) => ({ label: `idea ${i}`, code: `s("bd*${i + 1}")` })) });
    const lines = await collect(streamClaudeOptions(deps(new FakeMessages([textEvents(payload)])), req(), new AbortController().signal));
    expect(lines.filter((l) => l.type === 'option')).toHaveLength(4);
    const calls = new FakeMessages([textEvents(payload)]);
    await collect(streamClaudeOptions(deps(calls), { ...req(), strategy: 'parallel' }, new AbortController().signal));
    expect(calls.calls).toHaveLength(1);
  });
});

describe('the generate model', () => {
  it('defaults to the stronger model of each provider', () => {
    expect(MODE_DEFAULT_MODELS.generate).toBe('claude-sonnet-5-5');
    expect(GEMINI_MODE_DEFAULT_MODELS.generate).toBe('gemini-4-argon');
    expect(defaultModelFor('claude', 'generate')).toBe('claude-sonnet-5-5');
    expect(defaultModelFor('gemini', 'generate')).toBe('gemini-4-argon');
  });

  it('?generateModel= overrides it; without it the proxy decides', () => {
    expect(modelForMode(new URLSearchParams(), 'claude-haiku-5-5')('generate')).toBeNull();
    expect(modelForMode(new URLSearchParams('generateModel=claude-haiku-5-5'), 'claude-sonnet-5-5')('generate')).toBe('claude-haiku-5-5');
  });

  it('the proxy fills in the generate default and the request defaults for a bare body', async () => {
    const calls = new FakeMessages([textEvents(JSON.stringify({ options: [{ label: 'idea', code: 's("bd*4")' }] }))]);
    const app = createApp({ claude: { client: calls, reference: 'REFERENCE', maxTokens: 2048 }, limiter: new RateLimiter(20), log: () => {} });
    const body = { mode: 'generate', buffer: '', selection: { from: 0, to: 0, text: '' } };
    const res = await app.request('/api/options', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const split = new LineSplitter();
    const lines = [...split.push(await res.text()), ...split.flush()].map((l) => JSON.parse(l) as RemoteLine);
    expect(lines.find((l) => l.type === 'done')).toMatchObject({ model: 'claude-sonnet-5-5' });
    const params = calls.calls[0].params;
    expect(params.model).toBe('claude-sonnet-5-5');
    const user = params.messages[0].content as string;
    expect(user).toContain('Mode: generate');
    expect(user).toContain('Tempo: 0.5 cycles per second.'); // cps defaults to 0.5
    expect(user).toContain('Instruction: none. Offer four different starting ideas.'); // instruction defaults to ''
  });
});

/** Checks pass unless the code contains BAD; records every buffer checked and whether a fingerprint was asked for. */
class FakeBackend implements ValidationBackend {
  seen: Array<{ code: string; fingerprint: boolean }> = [];
  async check(code: string, _cps: number, _span?: unknown, opts?: { fingerprint?: boolean }): Promise<CheckResult> {
    this.seen.push({ code, fingerprint: !!opts?.fingerprint });
    return code.includes('BAD') ? { ok: false, stage: 'syntax', message: 'Unexpected token', ms: 1 } : { ok: true, eventCount: 8, sounds: ['bd'], ms: 1 };
  }
}

class ListProvider implements Provider {
  name = 'list';
  constructor(private codes: string[]) {}
  async *generateOptions(): AsyncGenerator<Option> {
    for (const code of this.codes) yield { id: code, label: code, code };
  }
}

describe('generate validation', () => {
  let sandbox: Sandbox;
  beforeAll(async () => {
    sandbox = await Sandbox.create();
  });

  it('the pipeline skips the baseline: no check of the empty buffer, no fingerprint', async () => {
    const backend = new FakeBackend();
    const validator = new Validator({ backend, hasSound: () => true, cps: () => 0.5 });
    const events: TrayEvent[] = [];
    const req = generateRequest(COMMENTS);
    const deps = { provider: new ListProvider(['s("bd*4")', 's("hh*8")']), validator, getBuffer: () => COMMENTS, getRange: () => req.selection, emit: (e: TrayEvent) => events.push(e) };
    await runRequest(deps, 1, req, slotCount('generate'), new AbortController().signal);
    expect(events.some((e) => e.type === 'bufferChecked')).toBe(false);
    expect(backend.seen).toEqual([
      { code: 's("bd*4")', fingerprint: false },
      { code: 's("hh*8")', fingerprint: false },
    ]);
    expect(events.filter((e) => e.type === 'optionValidated')).toHaveLength(2);
    // Shape on the same buffer still checks the baseline first.
    const shape = new FakeBackend();
    const shapeValidator = new Validator({ backend: shape, hasSound: () => true, cps: () => 0.5 });
    await runRequest({ ...deps, validator: shapeValidator, emit: () => {} }, 2, { ...req, mode: 'shape' }, 4, new AbortController().signal);
    expect(shape.seen[0]).toEqual({ code: COMMENTS, fingerprint: true });
  });

  it('a silent or unknown-sound option is retried once, as in the other modes', async () => {
    const validator = new Validator({ backend: sandbox, hasSound: (k) => sounds.has(k), cps: () => 0.5 });
    const events: TrayEvent[] = [];
    const req = generateRequest();
    const provider: Provider = {
      name: 'scripted',
      async *generateOptions(r) {
        if (r.feedback) yield { id: 'fixed', label: 'fixed', code: 's("bd*4")' };
        else for (const code of ['s("zzzz*4")', 's("bd*4").degradeBy(1)']) yield { id: code, label: code, code };
      },
    };
    await runRequest({ provider, validator, getBuffer: () => '', getRange: () => req.selection, emit: (e) => events.push(e) }, 1, req, 4, new AbortController().signal);
    expect(events.filter((e) => e.type === 'optionRetrying').map((e) => 'reason' in e && e.reason)).toEqual(['unknown-sample', 'empty']);
  });

  it('the validator accepts a whole program over an empty or comments-only buffer, judged by its own events', async () => {
    const validator = new Validator({ backend: sandbox, hasSound: (k) => sounds.has(k), cps: () => 0.5 });
    const option = { id: 'x', label: 'x', code: IDEAS[0].code };
    for (const buffer of ['', COMMENTS]) {
      const r = await validator.validate(buffer, { from: 0, to: buffer.length }, option, []);
      expect(r).toMatchObject({ ok: true, warnings: [] });
      expect(r.eventCount).toBeGreaterThan(0);
    }
    // Returning the comments unchanged is still caught as identical.
    expect(await validator.validate(COMMENTS, { from: 0, to: COMMENTS.length }, { ...option, code: COMMENTS }, [])).toMatchObject({ ok: false, reason: 'identical' });
  });
});

describe('the mock provider in generate mode', () => {
  let validator: Validator;
  beforeAll(async () => {
    validator = new Validator({ backend: await Sandbox.create(), hasSound: (k) => sounds.has(k), cps: () => 0.5 });
  });

  it.each(IDEAS.map((i) => [i.label, i] as const))('"%s" plays, uses loaded sounds only, and stays short', async (_label, idea) => {
    const r = await validator.validate('', { from: 0, to: 0 }, { id: 'x', label: idea.label, code: idea.code }, []);
    expect(r, r.message).toMatchObject({ ok: true, warnings: [] });
    expect(idea.code.split('\n').length).toBeLessThanOrEqual(10);
  });

  it('offers four distinct whole programs, matching ideas first', async () => {
    const mock = new MockProvider({ seed: 3, minDelayMs: 0, maxDelayMs: 0 });
    const options = await collect(mock.generateOptions(generateRequest('', 'chill lofi beat'), new AbortController().signal));
    expect(options).toHaveLength(4);
    expect(new Set(options.map((o) => o.code)).size).toBe(4);
    expect(options.every((o) => IDEAS.some((i) => i.code === o.code))).toBe(true);
    expect(['dusty lofi beat', 'ambient pad']).toContain(options[0].label);
    expect(pickIdeas('', prng(1))).toHaveLength(4);
  });

  it('a replacement is an idea not offered yet', async () => {
    const mock = new MockProvider({ seed: 3, minDelayMs: 0, maxDelayMs: 0 });
    const signal = new AbortController().signal;
    const first = await collect(mock.generateOptions(generateRequest(), signal));
    const [replacement] = await collect(mock.generateOptions({ ...generateRequest(), feedback: { previousCode: first[0].code, error: 'x' } }, signal));
    expect(first.map((o) => o.code)).not.toContain(replacement.code);
  });

  it('faults break the planned program, so the validator drops them', async () => {
    const mock = new MockProvider({ seed: 5, minDelayMs: 0, maxDelayMs: 0, faultRate: 1, faultKind: 'syntax' });
    const [broken] = await collect(mock.generateOptions(generateRequest(), new AbortController().signal));
    expect(broken.code.length).toBeGreaterThan(10);
    expect(await validator.validate('', { from: 0, to: 0 }, broken, [])).toMatchObject({ ok: false, reason: 'syntax' });
  });
});
