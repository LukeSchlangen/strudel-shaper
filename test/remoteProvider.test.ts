import { describe, expect, it } from 'vitest';
import { ProviderError, type OptionRequest, type ProviderStats } from '../src/provider';
import { LineSplitter } from '../src/remoteProtocol';
import { RemoteProvider } from '../src/remoteProvider';

const req: OptionRequest = { mode: 'shape', buffer: 's("hh*8")', selection: { from: 0, to: 9, text: 's("hh*8")' }, instruction: '', cps: 0.5 };
const lines = [
  { type: 'option', label: 'a', code: 's("hh*4")' },
  { type: 'option', label: 'b', code: 's("hh*16")' },
  { type: 'done', timing: { firstMs: 400, lastMs: 900, totalMs: 950 }, usage: { input: 10, output: 50, cacheRead: 4000, cacheWrite: 0 }, costUsd: 0.0001 },
];
const ndjson = lines.map((l) => JSON.stringify(l) + '\n').join('');

/** A fetch that answers with `body` split into `chunk`-sized pieces, and records what it was sent. */
function fakeFetch(body: string, { chunk = 5, status = 200, type = 'application/x-ndjson' } = {}) {
  const sent: Array<{ url: string; body: any; signal?: AbortSignal }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)), signal: init.signal ?? undefined });
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < body.length; i += chunk) c.enqueue(enc.encode(body.slice(i, i + chunk)));
        c.close();
      },
    });
    return new Response(stream, { status, headers: { 'content-type': type } });
  }) as unknown as typeof fetch;
  return { fn, sent };
}

async function collect(p: RemoteProvider, signal = new AbortController().signal) {
  const stats: ProviderStats[] = [];
  const out = [];
  for await (const o of p.generateOptions(req, signal, { onStats: (s) => stats.push(s) })) out.push(o);
  return { out, stats };
}

describe('LineSplitter', () => {
  it('reassembles lines across any chunking', () => {
    for (let size = 1; size < 20; size++) {
      const s = new LineSplitter();
      const got: string[] = [];
      for (let i = 0; i < ndjson.length; i += size) got.push(...s.push(ndjson.slice(i, i + size)));
      got.push(...s.flush());
      expect(got.map((l) => JSON.parse(l))).toEqual(lines);
    }
  });
});

describe('RemoteProvider', () => {
  it('yields options as their lines arrive and reports stats', async () => {
    const f = fakeFetch(ndjson, { chunk: 3 });
    const p = new RemoteProvider({ provider: 'claude', model: 'claude-haiku-5-5', fetch: f.fn, sounds: () => 'Drums: bd', settings: () => ({ effort: 'low' }) });
    const { out, stats } = await collect(p);
    expect(out.map((o) => o.code)).toEqual(['s("hh*4")', 's("hh*16")']);
    expect(new Set(out.map((o) => o.id)).size).toBe(2);
    expect(stats).toEqual([{ firstMs: 400, lastMs: 900, totalMs: 950, tokens: lines[2].usage, costUsd: 0.0001 }]);
    expect(f.sent[0]).toMatchObject({ url: '/api/options', body: { provider: 'claude', model: 'claude-haiku-5-5', sounds: 'Drums: bd', effort: 'low', buffer: req.buffer } });
    expect(p.name).toBe('claude · haiku-5-5');
  });

  it('turns an error line into a ProviderError after the options before it', async () => {
    const body = JSON.stringify(lines[0]) + '\n' + JSON.stringify({ type: 'error', kind: 'overloaded', message: 'The API is overloaded.' }) + '\n';
    const p = new RemoteProvider({ provider: 'claude', model: 'm', fetch: fakeFetch(body).fn });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const o of p.generateOptions(req, new AbortController().signal)) seen.push(o.code);
      })(),
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'overloaded', message: 'The API is overloaded.' });
    expect(seen).toEqual(['s("hh*4")']);
  });

  it('reports a bad-request JSON body', async () => {
    const f = fakeFetch(JSON.stringify({ type: 'error', kind: 'bad-request', message: 'The selection is outside the buffer.' }), { status: 400, type: 'application/json' });
    const p = new RemoteProvider({ provider: 'claude', model: 'm', fetch: f.fn });
    await expect(collect(p)).rejects.toBeInstanceOf(ProviderError);
  });

  it('a network failure names the proxy; an abort ends quietly', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(collect(new RemoteProvider({ provider: 'claude', model: 'm', fetch: down }))).rejects.toMatchObject({ kind: 'network' });

    const c = new AbortController();
    c.abort();
    const aborted = (async (_u: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      throw new Error('unreachable');
    }) as unknown as typeof fetch;
    expect((await collect(new RemoteProvider({ provider: 'claude', model: 'm', fetch: aborted }), c.signal)).out).toEqual([]);
  });

  it('passes the abort signal to fetch', async () => {
    const f = fakeFetch(ndjson);
    const c = new AbortController();
    await collect(new RemoteProvider({ provider: 'claude', model: 'm', fetch: f.fn }), c.signal);
    expect(f.sent[0].signal).toBe(c.signal);
  });
});
