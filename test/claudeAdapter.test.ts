import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { mapError } from '../server/errors';
import { buildParams, streamClaudeOptions, type ClaudeDeps } from '../server/providers/claude';
import { RateLimiter } from '../server/rateLimit';
import { LineSplitter, type RemoteLine, type RemoteRequest } from '../src/remoteProtocol';
import { FakeMessages, textEvents } from './fakeAnthropic';

const BUFFER = 'setcps(0.5)\nstack(\n  s("bd*4"),\n  s("hh*8").gain(0.6)\n)';
const SEL = 's("hh*8").gain(0.6)';
const FROM = BUFFER.indexOf(SEL);
const req: RemoteRequest = {
  provider: 'claude',
  model: 'claude-haiku-5-5',
  mode: 'shape',
  buffer: BUFFER,
  selection: { from: FROM, to: FROM + SEL.length, text: SEL },
  instruction: 'busier',
  cps: 0.5,
  sounds: 'Drums: bd hh',
};
const payload = (n: number) =>
  JSON.stringify({ options: Array.from({ length: n }, (_, i) => ({ label: `option ${i + 1}`, code: `s("hh*${8 + i}")` })) });

const deps = (client: FakeMessages, extra: Partial<ClaudeDeps> = {}): ClaudeDeps => ({ client, reference: 'REFERENCE', maxTokens: 2048, ...extra });

async function collect(gen: AsyncIterable<RemoteLine>) {
  const lines: RemoteLine[] = [];
  for await (const l of gen) lines.push(l);
  return lines;
}

describe('buildParams', () => {
  it('puts the static prompt and the sounds first, each with a cache breakpoint, and marks the selection', () => {
    const p = buildParams(deps(new FakeMessages([])), req);
    const system = p.system as Anthropic.TextBlockParam[];
    expect(system).toHaveLength(2);
    expect(system[0].text).toContain('REFERENCE');
    expect(system[0].text).not.toContain('hh*8'); // nothing per-request in the cached prefix
    expect(system[1].text).toContain('Drums: bd hh');
    expect(system.every((b) => b.cache_control?.type === 'ephemeral')).toBe(true);
    const user = p.messages[0].content as string;
    expect(user).toContain('stack(\n  s("bd*4"),\n  /*<sel>*/s("hh*8").gain(0.6)/*</sel>*/\n)');
    expect(user).toContain('Instruction: busier');
    expect(p.output_config?.format?.type).toBe('json_schema');
  });

  it('uses each model’s own "thinking off" form, and leaves thinking alone for adaptive', () => {
    const c = new FakeMessages([]);
    expect(buildParams(deps(c), { ...req, thinking: 'off' }).thinking).toEqual({ type: 'disabled' });
    expect(buildParams(deps(c), { ...req, model: 'claude-sonnet-5-5', thinking: 'off' }).thinking).toEqual({ type: 'between_tools' });
    expect(buildParams(deps(c), { ...req, thinking: 'adaptive' }).thinking).toBeUndefined();
    expect(buildParams(deps(c), { ...req, effort: 'medium' }).output_config?.effort).toBe('medium');
  });

  it('phrases retries as instructions and asks for one option', () => {
    const p = buildParams(deps(new FakeMessages([])), { ...req, feedback: { previousCode: 's("zzzz")', error: 'zzzz is not a loaded sound.' } });
    const user = p.messages[0].content as string;
    expect(user).toContain('s("zzzz")');
    expect(user).toContain('zzzz is not a loaded sound.');
    expect(user).toContain('Return exactly one option.');
  });
});

describe('fix modes in the prompt', () => {
  const user = (r: RemoteRequest) => buildParams(deps(new FakeMessages([])), r).messages[0].content as string;
  const system = (r: RemoteRequest) => (buildParams(deps(new FakeMessages([])), r).system as Anthropic.TextBlockParam[]).map((b) => b.text);
  const fix: RemoteRequest = { ...req, mode: 'fix-minimal', instruction: '', error: 's(...).gian is not a function', errorAt: { line: 4, inSelection: true } };

  it('every mode shares one cached system prompt, which holds all three modes’ rules', () => {
    const shape = system(req);
    expect(system(fix)).toEqual(shape);
    expect(system({ ...fix, mode: 'fix-rewrite' })).toEqual(shape);
    for (const heading of ['## Mode: shape', '## Mode: fix-minimal', '## Mode: fix-rewrite']) expect(shape[0]).toContain(heading);
    expect(user(fix)).not.toContain('## Mode');
  });

  it('fix-minimal: the mode, the error and its line, and no instruction', () => {
    const u = user(fix);
    expect(u.startsWith('Mode: fix-minimal\n')).toBe(true);
    expect(u).toContain('Problem in the marked code: s(...).gian is not a function (buffer line 4)');
    expect(u).not.toContain('Instruction');
  });

  it('a multi-line selection gets its line within the selection', () => {
    const sel = '  s("bd*4"),\n  s("hh*8").gain(0.6)';
    const from = BUFFER.indexOf(sel);
    const u = user({ ...fix, selection: { from, to: from + sel.length, text: sel } });
    expect(u).toContain('(buffer line 4, line 2 of the marked code)');
  });

  it('fix-rewrite: the instruction, or an ask to infer the intent', () => {
    expect(user({ ...fix, mode: 'fix-rewrite', instruction: 'follow the chords' })).toContain('Instruction: follow the chords');
    expect(user({ ...fix, mode: 'fix-rewrite' })).toContain('Instruction: none. Infer what the sketch is reaching for.');
    expect(user({ ...fix, mode: 'fix-rewrite', error: undefined, errorAt: undefined })).toContain('The marked code runs.');
  });

  it('an error outside the selection, and another error elsewhere, are named as not to be fixed', () => {
    expect(user({ ...fix, mode: 'fix-rewrite', errorAt: { line: 3, inSelection: false } })).toContain('The buffer fails outside the marked code, with: s(...).gian is not a function (buffer line 3).');
    const u = user({ ...fix, error: 'Invalid argument', errorAt: { inSelection: true, otherError: { message: 's(...).gian is not a function', line: 3 } } });
    expect(u).toContain('Problem in the marked code: Invalid argument\n');
    expect(u).toContain('The buffer also fails elsewhere, outside the marked code: s(...).gian is not a function (buffer line 3). Leave that alone');
  });

  it('fix-minimal keeps at most 2 options; fix-rewrite 4; parallel is shape-only', async () => {
    const minimal = await collect(streamClaudeOptions(deps(new FakeMessages([textEvents(payload(4))])), fix, new AbortController().signal));
    expect(minimal.filter((l) => l.type === 'option')).toHaveLength(2);
    const rewrite = await collect(streamClaudeOptions(deps(new FakeMessages([textEvents(payload(4))])), { ...fix, mode: 'fix-rewrite' }, new AbortController().signal));
    expect(rewrite.filter((l) => l.type === 'option')).toHaveLength(4);
    const calls = new FakeMessages([textEvents(payload(4))]);
    await collect(streamClaudeOptions(deps(calls), { ...fix, mode: 'fix-rewrite', strategy: 'parallel' }, new AbortController().signal));
    expect(calls.calls).toHaveLength(1);
  });
});

describe('streamClaudeOptions', () => {
  it('emits each option as it closes, then done with usage and cost', async () => {
    const lines = await collect(streamClaudeOptions(deps(new FakeMessages([textEvents(payload(4))])), req, new AbortController().signal));
    expect(lines.filter((l) => l.type === 'option')).toHaveLength(4);
    const done = lines.at(-1) as Extract<RemoteLine, { type: 'done' }>;
    expect(done.type).toBe('done');
    expect(done.usage).toEqual({ input: 120, output: 80, cacheRead: 3000, cacheWrite: 0 });
    expect(done.costUsd).toBeCloseTo((120 * 0.1 + 3000 * 0.01 + 80 * 0.5) / 1e6, 12);
  });

  it('keeps at most four options, and one for a retry', async () => {
    const many = await collect(streamClaudeOptions(deps(new FakeMessages([textEvents(payload(6))])), req, new AbortController().signal));
    expect(many.filter((l) => l.type === 'option')).toHaveLength(4);
    const retry = { ...req, feedback: { previousCode: 'x', error: 'y' } };
    const one = await collect(streamClaudeOptions(deps(new FakeMessages([textEvents(payload(3))])), retry, new AbortController().signal));
    expect(one.filter((l) => l.type === 'option')).toHaveLength(1);
  });

  it('reports a refusal and a max_tokens cut-off after the options that did complete', async () => {
    const cut = payload(3).slice(0, 80);
    const truncated = await collect(streamClaudeOptions(deps(new FakeMessages([textEvents(cut, { stop: 'max_tokens' })])), req, new AbortController().signal));
    expect(truncated.map((l) => l.type)).toEqual(['option', 'done', 'error']);
    expect(truncated.at(-1)).toMatchObject({ kind: 'truncated' });

    const refused = await collect(streamClaudeOptions(deps(new FakeMessages([textEvents('', { stop: 'refusal' })])), req, new AbortController().signal));
    expect(refused.at(-1)).toMatchObject({ type: 'error', kind: 'refusal' });
  });

  it('reports unreadable output as an error line', async () => {
    const lines = await collect(streamClaudeOptions(deps(new FakeMessages([textEvents('Sorry, no.')])), req, new AbortController().signal));
    expect(lines.at(-1)).toMatchObject({ type: 'error', kind: 'internal', message: 'Unexpected text before the JSON.' });
  });

  it('maps SDK errors to error lines without stack traces', async () => {
    const err = Anthropic.APIError.generate(401, { error: { message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers());
    const lines = await collect(streamClaudeOptions(deps(new FakeMessages([err])), req, new AbortController().signal));
    expect(lines).toEqual([{ type: 'error', kind: 'auth', message: 'The API key was rejected. Check ANTHROPIC_API_KEY in .env.' }]);
  });

  it('runs four one-option calls in parallel, each with a different direction, and sums usage', async () => {
    const client = new FakeMessages([textEvents(payload(1))]);
    const lines = await collect(streamClaudeOptions(deps(client), { ...req, strategy: 'parallel' }, new AbortController().signal));
    expect(client.calls).toHaveLength(4);
    const directions = client.calls.map((c) => /Direction for this option: (.*)\./.exec(c.params.messages[0].content as string)?.[1]);
    expect(new Set(directions).size).toBe(4);
    expect(lines.filter((l) => l.type === 'option')).toHaveLength(4);
    expect((lines.at(-1) as any).usage.cacheRead).toBe(4 * 3000);
  });

  it('aborts a stalled upstream stream after the idle timeout, keeping options already sent', async () => {
    const stalled = new Promise<void>(() => {});
    const client = new FakeMessages([textEvents(payload(4), { chunk: 4 })], { after: 30, until: stalled });
    const lines = await collect(streamClaudeOptions(deps(client, { idleTimeoutMs: 30 }), req, new AbortController().signal));
    expect(lines.at(-1)).toMatchObject({ type: 'error', kind: 'timeout' });
    expect(client.calls[0].signal?.aborted).toBe(true);
    expect(client.aborted).toBe(1);
  });

  it('refuses calls past the local rate limit', async () => {
    const limiter = new RateLimiter(1);
    const d = deps(new FakeMessages([textEvents(payload(1))]), { beforeCall: () => limiter.take() });
    await collect(streamClaudeOptions(d, req, new AbortController().signal));
    const second = await collect(streamClaudeOptions(d, req, new AbortController().signal));
    expect(second).toEqual([expect.objectContaining({ type: 'error', kind: 'local-rate-limit' })]);
  });
});

describe('mapError', () => {
  const gen = (status: number, message = 'boom') => Anthropic.APIError.generate(status, { error: { message } }, message, new Headers({ 'retry-after': '12' }));
  it.each([
    [gen(429), 'rate-limit', /retry in 12 s/],
    [gen(529, 'Overloaded'), 'overloaded', /overloaded/],
    [gen(400, 'max_tokens: too large'), 'bad-request', /max_tokens: too large/],
    [gen(500), 'internal', /API error 500/],
    [new Anthropic.APIConnectionError({ message: 'ECONNRESET' }), 'network', /reach/],
    [new TypeError('x is undefined'), 'internal', /proxy failed/],
  ])('%s → %s', (err, kind, message) => {
    const m = mapError(err);
    expect(m.kind).toBe(kind);
    expect(m.message).toMatch(message);
    expect(m.message).not.toMatch(/\n\s+at /);
  });
});

describe('POST /api/options', () => {
  const post = (app: ReturnType<typeof createApp>, body: unknown, signal?: AbortSignal) =>
    app.request('/api/options', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, signal });

  async function readLines(res: Response) {
    const split = new LineSplitter();
    const text = await res.text();
    return [...split.push(text), ...split.flush()].map((l) => JSON.parse(l) as RemoteLine);
  }

  it('streams NDJSON lines', async () => {
    const app = createApp({ claude: deps(new FakeMessages([textEvents(payload(3))])), limiter: new RateLimiter(20), log: () => {} });
    const res = await post(app, req);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    expect((await readLines(res)).map((l) => l.type)).toEqual(['option', 'option', 'option', 'done']);
  });

  it('answers with an auth error line when there is no key', async () => {
    const app = createApp({ claude: null, limiter: new RateLimiter(20), log: () => {} });
    expect(await readLines(await post(app, req))).toEqual([expect.objectContaining({ type: 'error', kind: 'auth' })]);
  });

  it('rejects a malformed body with a structured error', async () => {
    const app = createApp({ claude: null, limiter: new RateLimiter(20), log: () => {} });
    const res = await post(app, { buffer: 'x', selection: { from: 0, to: 9 } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ type: 'error', kind: 'bad-request' });
  });

  it('aborts the upstream call when the browser closes the request', async () => {
    let release!: () => void;
    const until = new Promise<void>((r) => (release = r));
    const client = new FakeMessages([textEvents(payload(4), { chunk: 4 })], { after: 20, until });
    const log: Array<Record<string, unknown>> = [];
    const app = createApp({ claude: deps(client), limiter: new RateLimiter(20), log: (e) => log.push(e) });
    const browser = new AbortController();
    const res = await post(app, req, browser.signal);
    const reader = res.body!.getReader();
    await reader.read(); // stream is flowing; the fake is now held mid-response
    browser.abort();
    await new Promise((r) => setTimeout(r, 10));
    release();
    await reader.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    expect(client.calls[0].signal?.aborted).toBe(true);
    expect(client.aborted).toBe(1);
    expect(log).toContainEqual(expect.objectContaining({ aborted: true }));
  });
});
