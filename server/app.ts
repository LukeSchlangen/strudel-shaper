import { Hono } from 'hono';
import type { RemoteLine, RemoteRequest } from '../src/remoteProtocol';
import { mapError } from './errors';
import { streamClaudeOptions, warmUp as warmUpClaude, type ClaudeDeps } from './providers/claude';
import { streamGeminiOptions, warmUp as warmUpGemini, type GeminiDeps } from './providers/gemini';
import { DEFAULT_MODEL, defaultModelFor } from './providers/models';
import { RateLimiter } from './rateLimit';

export interface AppDeps {
  /** Null when there's no API key: requests then get an `auth` error line. */
  claude: Omit<ClaudeDeps, 'beforeCall'> | null;
  gemini?: Omit<GeminiDeps, 'beforeCall'> | null;
  limiter: RateLimiter;
  log?: (entry: Record<string, unknown>) => void;
}

export const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB
export const MAX_BUFFER_CHARS = 20_000;
export const MAX_SELECTION_CHARS = 4_000;
export const MAX_INSTRUCTION_CHARS = 400;
export const MAX_SOUNDS_CHARS = 2_000;

export function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return c.req.header('x-real-ip') ?? '127.0.0.1';
}

export function isAllowedOrigin(c: { req: { header: (name: string) => string | undefined } }): boolean {
  const origin = c.req.header('origin');
  const host = c.req.header('host');
  if (!origin || !host) return true; // Direct non-browser calls / curl / tests
  try {
    const originHost = new URL(origin).host;
    return originHost === host || originHost.startsWith('localhost') || originHost.startsWith('127.0.0.1');
  } catch {
    return false;
  }
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
  const warmupLimiter = new RateLimiter(10, 2);

  app.get('/api/models', (c) => {
    return c.json({
      providers: {
        claude: !!deps.claude,
        gemini: !!deps.gemini,
      },
      models: [
        { id: 'mock', provider: 'mock', label: 'mock', enabled: true },
        { id: 'claude:claude-haiku-5-5', provider: 'claude', model: 'claude-haiku-5-5', label: 'claude · haiku 5.5', enabled: !!deps.claude },
        { id: 'claude:claude-sonnet-5-5', provider: 'claude', model: 'claude-sonnet-5-5', label: 'claude · sonnet 5.5', enabled: !!deps.claude },
        { id: 'gemini:gemini-3.5-flash-lite', provider: 'gemini', model: 'gemini-3.5-flash-lite', label: 'gemini · 3.5 flash-lite', enabled: !!deps.gemini },
        { id: 'gemini:gemini-3.8-flash', provider: 'gemini', model: 'gemini-3.8-flash', label: 'gemini · 3.8 flash', enabled: !!deps.gemini },
        { id: 'gemini:gemini-4-argon', provider: 'gemini', model: 'gemini-4-argon', label: 'gemini · 4 argon', enabled: !!deps.gemini },
      ],
    });
  });

  app.post('/api/options', async (c) => {
    if (!isAllowedOrigin(c)) {
      return c.json({ type: 'error', kind: 'bad-request', message: 'Cross-origin requests are not allowed.' }, 403);
    }

    const contentLength = Number(c.req.header('content-length') ?? 0);
    if (contentLength > MAX_PAYLOAD_BYTES) {
      return c.json({ type: 'error', kind: 'bad-request', message: 'Payload too large (max 64 KB).' }, 413);
    }

    let req: RemoteRequest;
    try {
      req = parseRequest(await c.req.json());
    } catch (err) {
      return c.json({ type: 'error', kind: 'bad-request', message: (err as Error).message }, 400);
    }
    const signal = c.req.raw.signal;
    const clientIp = getClientIp(c);
    const started = performance.now();
    const lines = linesFor(deps, req, signal, clientIp);
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
              ip: clientIp,
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
      () => finished || log({ ip: clientIp, model: req.model, aborted: true, retry: !!req.feedback, ms: Math.round(performance.now() - started) }),
      { once: true },
    );
    return new Response(body, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } });
  });

  app.post('/api/warmup', async (c) => {
    if (!isAllowedOrigin(c)) {
      return c.json({ ok: false, message: 'Cross-origin requests are not allowed.' }, 403);
    }

    const clientIp = getClientIp(c);
    if (!warmupLimiter.take(clientIp)) {
      return c.json({ ok: false, message: 'Warm-up rate limit reached. Please wait a moment.' }, 429);
    }

    const body = (await c.req.json().catch(() => ({}))) as Partial<RemoteRequest>;
    const provider = body.provider ?? (body.model?.startsWith('gemini') ? 'gemini' : 'claude');
    const started = performance.now();

    if (provider === 'gemini') {
      if (!deps.gemini) return c.json({ ok: false, message: 'No Gemini API key configured.' });
      const model = body.model ?? 'gemini-3.8-flash';
      const { done, error } = await warmUpGemini(
        { ...deps.gemini, beforeCall: () => deps.limiter.take(clientIp) },
        { model, sounds: body.sounds, effort: body.effort, thinking: body.thinking },
        c.req.raw.signal,
      );
      const ms = Math.round(performance.now() - started);
      log({ warmup: true, provider: 'gemini', model, ms, usage: done?.usage, error: error?.kind });
      return c.json({ ok: !error, ms, usage: done?.usage, message: error?.message });
    }

    if (!deps.claude) return c.json({ ok: false, message: 'No Claude API key configured.' });
    const model = body.model ?? DEFAULT_MODEL;
    const { done, error } = await warmUpClaude(
      { ...deps.claude, beforeCall: () => deps.limiter.take(clientIp) },
      { model, sounds: body.sounds, effort: body.effort, thinking: body.thinking },
      c.req.raw.signal,
    );
    const ms = Math.round(performance.now() - started);
    log({ warmup: true, provider: 'claude', model, ms, usage: done?.usage, error: error?.kind });
    return c.json({ ok: !error, ms, usage: done?.usage, message: error?.message });
  });

  return app;
}

async function* linesFor(deps: AppDeps, req: RemoteRequest, signal: AbortSignal, ip?: string): AsyncGenerator<RemoteLine> {
  if (req.provider === 'claude') {
    if (!deps.claude) {
      yield { type: 'error', kind: 'auth', message: 'No API key: set ANTHROPIC_API_KEY in .env and restart the server.' };
      return;
    }
    yield* streamClaudeOptions({ ...deps.claude, beforeCall: () => deps.limiter.take(ip) }, req, signal);
    return;
  }
  if (req.provider === 'gemini') {
    if (!deps.gemini) {
      yield { type: 'error', kind: 'auth', message: 'No API key: set GEMINI_API_KEY in .env and restart the server.' };
      return;
    }
    yield* streamGeminiOptions({ ...deps.gemini, beforeCall: () => deps.limiter.take(ip) }, req, signal);
    return;
  }
  yield { type: 'error', kind: 'bad-request', message: `Unknown provider "${req.provider}".` };
}

function parseRequest(body: unknown): RemoteRequest {
  const b = body as Partial<RemoteRequest> | null;
  if (!b || typeof b !== 'object') throw new Error('The request body must be a JSON object.');
  if (typeof b.buffer !== 'string' || !b.selection || typeof b.selection.from !== 'number' || typeof b.selection.to !== 'number') {
    throw new Error('The request needs buffer and selection {from, to, text}.');
  }
  if (b.buffer.length > MAX_BUFFER_CHARS) {
    throw new Error(`Buffer exceeds maximum allowed size (${MAX_BUFFER_CHARS} characters).`);
  }
  if (b.selection.from < 0 || b.selection.to > b.buffer.length || b.selection.from > b.selection.to) {
    throw new Error('The selection is outside the buffer.');
  }
  if (b.selection.text.length > MAX_SELECTION_CHARS) {
    throw new Error(`Selection exceeds maximum allowed size (${MAX_SELECTION_CHARS} characters).`);
  }
  if (b.instruction && typeof b.instruction === 'string' && b.instruction.length > MAX_INSTRUCTION_CHARS) {
    throw new Error(`Instruction exceeds maximum allowed length (${MAX_INSTRUCTION_CHARS} characters).`);
  }
  if (b.sounds && typeof b.sounds === 'string' && b.sounds.length > MAX_SOUNDS_CHARS) {
    throw new Error(`Sounds summary exceeds maximum allowed size (${MAX_SOUNDS_CHARS} characters).`);
  }

  const mode = b.mode ?? 'shape';
  const provider = b.provider ?? (b.model?.startsWith('gemini') ? 'gemini' : 'claude');
  return {
    ...(b as RemoteRequest),
    provider,
    model: b.model || defaultModelFor(provider, mode),
    instruction: b.instruction ?? '',
    cps: typeof b.cps === 'number' ? b.cps : 0.5,
    mode,
  };
}

const round = (v?: number) => (v === undefined ? undefined : Math.round(v));
