import { describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { buildGeminiParams, streamGeminiOptions, warmUp, type GeminiDeps } from '../server/providers/gemini';
import { GEMINI_MODE_DEFAULT_MODELS } from '../server/providers/models';
import { RateLimiter } from '../server/rateLimit';
import { LineSplitter, type RemoteLine, type RemoteRequest } from '../src/remoteProtocol';
import { FakeGemini, geminiTextChunks } from './fakeGemini';

const BUFFER = 'setcps(0.5)\nstack(\n  s("bd*4"),\n  s("hh*8").gain(0.6)\n)';
const SEL = 's("hh*8").gain(0.6)';
const FROM = BUFFER.indexOf(SEL);
const req: RemoteRequest = {
  provider: 'gemini',
  model: 'gemini-3.8-flash',
  mode: 'shape',
  buffer: BUFFER,
  selection: { from: FROM, to: FROM + SEL.length, text: SEL },
  instruction: 'busier',
  cps: 0.5,
  sounds: 'Drums: bd hh',
};

const payload = (n: number) =>
  JSON.stringify({ options: Array.from({ length: n }, (_, i) => ({ label: `option ${i + 1}`, code: `s("hh*${8 + i}")` })) });

const deps = (client: FakeGemini, extra: Partial<GeminiDeps> = {}): GeminiDeps => ({
  client,
  reference: 'REFERENCE',
  maxTokens: 2048,
  ...extra,
});

async function collect(gen: AsyncIterable<RemoteLine>) {
  const lines: RemoteLine[] = [];
  for await (const l of gen) lines.push(l);
  return lines;
}

describe('buildGeminiParams', () => {
  it('configures system instruction, response schema, and user contents with marked selection', () => {
    const p = buildGeminiParams(deps(new FakeGemini([])), req);
    expect(p.model).toBe('gemini-3.8-flash');
    const system = String(p.config?.systemInstruction);
    expect(system).toContain('REFERENCE');
    expect(system).toContain('Drums: bd hh');
    expect(p.config?.responseMimeType).toBe('application/json');
    expect(p.config?.responseSchema).toBeDefined();

    const user = String(p.contents);
    expect(user).toContain('stack(\n  s("bd*4"),\n  /*<sel>*/s("hh*8").gain(0.6)/*</sel>*/\n)');
    expect(user).toContain('Instruction: busier');
  });

  it('configures thinkingLevel for Gemini 3/4 models and thinkingBudget for legacy models', () => {
    const c = new FakeGemini([]);
    // gemini-3.5-flash-lite uses MINIMAL for off and low effort, suppressing thoughts
    expect(buildGeminiParams(deps(c), { ...req, model: 'gemini-3.5-flash-lite', thinking: 'off' }).config?.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL', includeThoughts: false });
    expect(buildGeminiParams(deps(c), { ...req, model: 'gemini-3.5-flash-lite', thinking: 'adaptive', effort: 'low' }).config?.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL', includeThoughts: false });
    // gemini-3.8-flash uses LOW for off, and respects effort on adaptive
    expect(buildGeminiParams(deps(c), { ...req, model: 'gemini-3.8-flash', thinking: 'off' }).config?.thinkingConfig).toEqual({ thinkingLevel: 'LOW', includeThoughts: false });
    expect(buildGeminiParams(deps(c), { ...req, model: 'gemini-3.8-flash', thinking: 'adaptive', effort: 'high' }).config?.thinkingConfig).toEqual({ thinkingLevel: 'HIGH', includeThoughts: false });
    // gemini-4-argon uses LOW for off
    expect(buildGeminiParams(deps(c), { ...req, model: 'gemini-4-argon', thinking: 'off' }).config?.thinkingConfig).toEqual({ thinkingLevel: 'LOW', includeThoughts: false });
    // legacy models use thinkingBudget
    expect(buildGeminiParams(deps(c), { ...req, model: 'gemini-2.5-flash-lite', thinking: 'off' }).config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(buildGeminiParams(deps(c), { ...req, model: 'gemini-2.5-flash', thinking: 'off' }).config?.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(buildGeminiParams(deps(c), { ...req, model: 'gemini-2.5-flash', thinking: 'adaptive' }).config?.thinkingConfig).toEqual({ thinkingBudget: -1 });
  });

  it('phrases retries as feedback and asks for one option', () => {
    const p = buildGeminiParams(deps(new FakeGemini([])), {
      ...req,
      feedback: { previousCode: 's("zzzz")', error: 'zzzz is not a loaded sound.' },
    });
    const user = String(p.contents);
    expect(user).toContain('A previous option for this selection was rejected:');
    expect(user).toContain('zzzz is not a loaded sound.');
    expect(user).toContain('Return exactly one option.');
  });
});

describe('streamGeminiOptions', () => {
  it('yields options incrementally and ends with a done line', async () => {
    const client = new FakeGemini([geminiTextChunks(payload(3), { chunkSize: 12 })]);
    const lines = await collect(streamGeminiOptions(deps(client), req, new AbortController().signal));
    const options = lines.filter((l) => l.type === 'option');
    expect(options).toHaveLength(3);
    expect(options[0]).toEqual({ type: 'option', label: 'option 1', code: 's("hh*8")' });

    const done = lines.find((l) => l.type === 'done');
    expect(done).toMatchObject({
      type: 'done',
      model: 'gemini-3.8-flash',
      usage: { input: 120, output: 80, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it('clamps shape mode to at most 4 options', async () => {
    const client = new FakeGemini([geminiTextChunks(payload(6))]);
    const lines = await collect(streamGeminiOptions(deps(client), req, new AbortController().signal));
    expect(lines.filter((l) => l.type === 'option')).toHaveLength(4);
  });

  it('clamps fix-minimal mode to at most 2 options', async () => {
    const client = new FakeGemini([geminiTextChunks(payload(4))]);
    const lines = await collect(streamGeminiOptions(deps(client), { ...req, mode: 'fix-minimal' }, new AbortController().signal));
    expect(lines.filter((l) => l.type === 'option')).toHaveLength(2);
  });

  it('reports safety refusals as a refusal error line', async () => {
    const client = new FakeGemini([geminiTextChunks('{}', { finishReason: 'SAFETY' })]);
    const lines = await collect(streamGeminiOptions(deps(client), req, new AbortController().signal));
    expect(lines.find((l) => l.type === 'error')).toMatchObject({ type: 'error', kind: 'refusal' });
  });

  it('reports truncated responses as a truncated error line', async () => {
    const client = new FakeGemini([geminiTextChunks('{"options":[{"label":"a","code":"b"}]', { finishReason: 'MAX_TOKENS' })]);
    const lines = await collect(streamGeminiOptions(deps(client), req, new AbortController().signal));
    expect(lines.find((l) => l.type === 'error')).toMatchObject({ type: 'error', kind: 'truncated' });
  });

  it('reports local rate limiter exhaustion', async () => {
    const client = new FakeGemini([geminiTextChunks(payload(1))]);
    const lines = await collect(streamGeminiOptions(deps(client, { beforeCall: () => false }), req, new AbortController().signal));
    expect(lines).toEqual([{ type: 'error', kind: 'local-rate-limit', message: expect.any(String) }]);
    expect(client.calls).toHaveLength(0);
  });

  it('aborts the upstream request when signal aborts', async () => {
    let unblock!: () => void;
    const gate = { after: 1, until: new Promise<void>((r) => (unblock = r)) };
    const client = new FakeGemini([geminiTextChunks(payload(2), { chunkSize: 8 })], gate);
    const controller = new AbortController();

    const read = (async () => {
      const out: RemoteLine[] = [];
      for await (const l of streamGeminiOptions(deps(client), req, controller.signal)) {
        out.push(l);
        if (out.length === 1) controller.abort();
      }
      return out;
    })();

    unblock();
    const lines = await read;
    expect(lines.some((l) => l.type === 'done')).toBe(false);
    expect(client.aborted).toBeGreaterThan(0);
  });
});

describe('parallel strategy', () => {
  it('makes 4 calls concurrently and merges options in arrival order', async () => {
    const client = new FakeGemini([
      (params) => geminiTextChunks(JSON.stringify({ options: [{ label: 'dir', code: `s("${params.model}")` }] })),
    ]);
    const lines = await collect(streamGeminiOptions(deps(client), { ...req, strategy: 'parallel' }, new AbortController().signal));
    expect(lines.filter((l) => l.type === 'option')).toHaveLength(4);
    expect(client.calls).toHaveLength(4);
    expect(lines.find((l) => l.type === 'done')).toBeDefined();
  });
});

describe('warmUp', () => {
  it('issues a warm-up call with minimal tokens', async () => {
    const client = new FakeGemini([geminiTextChunks(payload(1))]);
    const result = await warmUp(deps(client), { model: 'gemini-3.8-flash' }, new AbortController().signal);
    expect(result.done).toBeDefined();
    expect(client.calls[0].params.config?.maxOutputTokens).toBe(800);
  });
});

describe('proxy app integration for Gemini', () => {
  it('exposes /api/models with enabled status based on present keys', async () => {
    const appBoth = createApp({
      claude: { client: {} as any, reference: 'REF', maxTokens: 2048 },
      gemini: { client: new FakeGemini([]), reference: 'REF', maxTokens: 2048 },
      limiter: new RateLimiter(20),
    });
    const resBoth = await appBoth.fetch(new Request('http://localhost/api/models'));
    const bodyBoth = await resBoth.json();
    expect(bodyBoth.providers).toEqual({ claude: true, gemini: true });
    expect(bodyBoth.models.find((m: any) => m.id === 'gemini:gemini-3.8-flash').enabled).toBe(true);

    const appGeminiOnly = createApp({
      claude: null,
      gemini: { client: new FakeGemini([]), reference: 'REF', maxTokens: 2048 },
      limiter: new RateLimiter(20),
    });
    const resGeminiOnly = await appGeminiOnly.fetch(new Request('http://localhost/api/models'));
    const bodyGeminiOnly = await resGeminiOnly.json();
    expect(bodyGeminiOnly.providers).toEqual({ claude: false, gemini: true });
    expect(bodyGeminiOnly.models.find((m: any) => m.id === 'claude:claude-haiku-5-5').enabled).toBe(false);
    expect(bodyGeminiOnly.models.find((m: any) => m.id === 'gemini:gemini-3.8-flash').enabled).toBe(true);
  });

  it('streams options via POST /api/options with provider: gemini', async () => {
    const client = new FakeGemini([geminiTextChunks(payload(2))]);
    const app = createApp({
      claude: null,
      gemini: { client, reference: 'REF', maxTokens: 2048 },
      limiter: new RateLimiter(20),
    });

    const res = await app.fetch(
      new Request('http://localhost/api/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const splitter = new LineSplitter();
    const lines = splitter.push(text).map((l) => JSON.parse(l));
    expect(lines.filter((l: any) => l.type === 'option')).toHaveLength(2);
    expect(lines.find((l: any) => l.type === 'done')).toBeDefined();
  });

  it('returns auth error when gemini API key is not configured', async () => {
    const app = createApp({
      claude: null,
      gemini: null,
      limiter: new RateLimiter(20),
    });
    const res = await app.fetch(
      new Request('http://localhost/api/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      }),
    );
    const text = await res.text();
    expect(text).toContain('"type":"error"');
    expect(text).toContain('"kind":"auth"');
  });

  it('uses per-mode default models for gemini when not specified', async () => {
    for (const [mode, expectedModel] of Object.entries(GEMINI_MODE_DEFAULT_MODELS)) {
      const client = new FakeGemini([geminiTextChunks(payload(1))]);
      const app = createApp({
        claude: null,
        gemini: { client, reference: 'REF', maxTokens: 2048 },
        limiter: new RateLimiter(20),
      });

      const body = { ...req, mode, model: undefined };
      const res = await app.fetch(
        new Request('http://localhost/api/options', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      const text = await res.text();
      const splitter = new LineSplitter();
      const lines = splitter.push(text).map((l) => JSON.parse(l));
      const done = lines.find((l: any) => l.type === 'done');
      expect(done).toMatchObject({ model: expectedModel });
    }
  });
});
