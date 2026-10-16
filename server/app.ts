import { Hono } from 'hono';
import type { RemoteLine, RemoteRequest } from '../src/remoteProtocol';
import { mapError } from './errors';
import { streamClaudeOptions, warmUp, type ClaudeDeps } from './providers/claude';
import { DEFAULT_MODEL, MODE_DEFAULT_MODELS } from './providers/models';
import type { RateLimiter } from './rateLimit';

export interface AppDeps {
  /** Null when there's no API key: requests then get an `auth` error line. */
  claude: Omit<ClaudeDeps, 'beforeCall'> | null;
  limiter: RateLimiter;
  log?: (entry: Record<string, unknown>) => void;
}

const encoder = new TextEncoder();
const ndjson = (line: RemoteLine) => encoder.encode(JSON.stringify(line) + '\n');

/**
 * POST /api/options: an OptionRequest plus provider/model, answered as NDJSON (one line per option,
 * then `done` or `error`). Closing the request aborts the upstream call: the request's signal is
 * passed to the SDK.
 */
export function createApp(deps: AppDeps) {
  const app = new Hono();
  const log = deps.log ?? ((entry) => console.log('[proxy]', JSON.stringify(entry)));

  app.post('/api/options', async (c) => {
    let req: RemoteRequest;
    try {
      req = parseRequest(await c.req.json());
    } catch (err) {
      return c.json({ type: 'error', kind: 'bad-request', message: (err as Error).message }, 400);
    }
    const signal = c.req.raw.signal;
    const started = performance.now();
    const lines = linesFor(deps, req, signal);
    let finished = false;

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await lines.next();
          // After a cancel (the browser left) the controller is closed: nothing more to send.
          if (signal.aborted) return;
          if (done) {
            finished = true;
            controller.close();
            return;
          }
          if (value.type === 'done' || value.type === 'error') {
            log({
              model: req.model,
              mode: req.mode,
              strategy: req.strategy ?? 'single',
              retry: !!req.feedback,
              ms: Math.round(performance.now() - started),
              ...(value.type === 'done'
                ? { firstMs: round(value.timing.firstMs), usage: value.usage, costUsd: +value.costUsd.toFixed(6) }
                : { error: value.kind, message: value.message }),
            });
          }
          controller.enqueue(ndjson(value));
        } catch (err) {
          if (signal.aborted) return;
          console.error('[proxy] stream failed', err);
          finished = true;
          controller.enqueue(ndjson({ type: 'error', ...mapError(err) }));
          controller.close();
        }
      },
      cancel() {
        void lines.return(undefined);
      },
    });
    // The browser went away (R, a new ⌘K, Esc): the SDK call shares this signal, so it's cancelled too.
    signal.addEventListener(
      'abort',
      () => finished || log({ model: req.model, aborted: true, retry: !!req.feedback, ms: Math.round(performance.now() - started) }),
      { once: true },
    );
    return new Response(body, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
  });

  app.post('/api/warmup', async (c) => {
    if (!deps.claude) return c.json({ ok: false, message: 'No API key configured.' });
    const body = (await c.req.json().catch(() => ({}))) as Partial<RemoteRequest>;
    const started = performance.now();
    const { done, error } = await warmUp(
      { ...deps.claude, beforeCall: () => deps.limiter.take() },
      { model: body.model ?? DEFAULT_MODEL, sounds: body.sounds, effort: body.effort, thinking: body.thinking },
      c.req.raw.signal,
    );
    const ms = Math.round(performance.now() - started);
    log({ warmup: true, model: body.model ?? DEFAULT_MODEL, ms, usage: done?.usage, error: error?.kind });
    return c.json({ ok: !error, ms, usage: done?.usage, message: error?.message });
  });

  return app;
}

async function* linesFor(deps: AppDeps, req: RemoteRequest, signal: AbortSignal): AsyncGenerator<RemoteLine> {
  if (req.provider !== 'claude') {
    yield { type: 'error', kind: 'bad-request', message: `Unknown provider "${req.provider}".` };
    return;
  }
  if (!deps.claude) {
    yield { type: 'error', kind: 'auth', message: 'No API key: set ANTHROPIC_API_KEY in .env and restart the server.' };
    return;
  }
  yield* streamClaudeOptions({ ...deps.claude, beforeCall: () => deps.limiter.take() }, req, signal);
}

function parseRequest(body: unknown): RemoteRequest {
  const b = body as Partial<RemoteRequest> | null;
  if (!b || typeof b !== 'object') throw new Error('The request body must be a JSON object.');
  if (typeof b.buffer !== 'string' || !b.selection || typeof b.selection.from !== 'number' || typeof b.selection.to !== 'number') {
    throw new Error('The request needs buffer and selection {from, to, text}.');
  }
  if (b.selection.from < 0 || b.selection.to > b.buffer.length || b.selection.from > b.selection.to) {
    throw new Error('The selection is outside the buffer.');
  }
  const mode = b.mode ?? 'shape';
  return {
    ...(b as RemoteRequest),
    provider: b.provider ?? 'claude',
    model: b.model || (MODE_DEFAULT_MODELS[mode] ?? DEFAULT_MODEL),
    instruction: b.instruction ?? '',
    cps: typeof b.cps === 'number' ? b.cps : 0.5,
    mode,
  };
}

const round = (v?: number) => (v === undefined ? undefined : Math.round(v));
