import type Anthropic from '@anthropic-ai/sdk';
import { addUsage, emptyUsage, type RemoteLine, type RemoteRequest, type Usage } from '../../src/remoteProtocol';
import { mapError } from '../errors';
import { OptionStreamParser } from '../jsonStream';
import { DIRECTIONS, optionSchema, soundsSystem, staticSystem, userMessage, type UserMessageOptions } from '../prompt';
import { MODELS, costUsd, type ModelInfo } from './models';
import { MAX_OPTIONS, cleanOption } from './postprocess';

/** The one SDK call we use, so tests can pass a fake that replays scripted stream events. */
export interface MessagesClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsStreaming,
      options?: { signal?: AbortSignal },
    ): PromiseLike<AsyncIterable<Anthropic.RawMessageStreamEvent>>;
  };
}

export interface ClaudeDeps {
  client: MessagesClient;
  reference: string;
  maxTokens: number;
  /** Called once per upstream call, before it is made. Return false to refuse it (rate limit). */
  beforeCall?: () => boolean;
  /** Only for measuring a cold grammar compile: a schema whose structure differs from the usual one. */
  schemaKey?: string;
  /** Abort a call when no stream event arrives for this long (default 20 s). The SDK's own timeout is 10 min. */
  idleTimeoutMs?: number;
  now?: () => number;
}

export class ProviderLineError extends Error {}

export function modelInfo(model: string): ModelInfo {
  const info = MODELS[model];
  if (!info) throw new ProviderLineError(`Unknown model "${model}". One of: ${Object.keys(MODELS).join(', ')}.`);
  return info;
}

/** The request body, exported for tests: cache breakpoints, thinking and effort settings, schema. */
export function buildParams(deps: ClaudeDeps, req: RemoteRequest, opts: UserMessageOptions & { maxTokens?: number } = {}): Anthropic.MessageCreateParamsStreaming {
  const info = modelInfo(req.model);
  const thinking = req.thinking ?? info.defaults.thinking;
  const effort = req.effort ?? info.defaults.effort;
  return {
    model: info.id,
    max_tokens: opts.maxTokens ?? deps.maxTokens,
    stream: true,
    system: [
      { type: 'text', text: staticSystem(deps.reference), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: soundsSystem(req.sounds), cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userMessage(req, opts) }],
    ...(thinking === 'off' ? { thinking: info.thinkingOff } : {}),
    output_config: { effort, format: { type: 'json_schema', schema: optionSchema(deps.schemaKey) } },
  };
}

/**
 * Streams options for one request as protocol lines: each option as soon as its JSON object closes,
 * then one `done` line with timing and usage, or an `error` line. Never throws. Stops quietly when
 * `signal` aborts (the SDK cancels the upstream HTTP request).
 */
export async function* streamClaudeOptions(deps: ClaudeDeps, req: RemoteRequest, signal: AbortSignal): AsyncGenerator<RemoteLine> {
  let info: ModelInfo;
  try {
    info = modelInfo(req.model);
  } catch (err) {
    yield { type: 'error', kind: 'bad-request', message: (err as Error).message };
    return;
  }
  const single = !!req.feedback;
  if (req.strategy === 'parallel' && !single) {
    yield* parallel(deps, req, info, signal);
    return;
  }
  yield* oneCall(deps, req, info, signal, { single }, single ? 1 : MAX_OPTIONS);
}

async function* oneCall(
  deps: ClaudeDeps,
  req: RemoteRequest,
  info: ModelInfo,
  signal: AbortSignal,
  opts: UserMessageOptions & { maxTokens?: number },
  limit: number,
): AsyncGenerator<RemoteLine> {
  const now = deps.now ?? (() => performance.now());
  const start = now();
  let usage: Usage = emptyUsage();
  let firstMs: number | undefined;
  let lastMs: number | undefined;
  let emitted = 0;
  let stopReason: string | null = null;
  const parser = new OptionStreamParser();
  const problems: string[] = [];

  if (deps.beforeCall && !deps.beforeCall()) {
    yield { type: 'error', kind: 'local-rate-limit', message: 'Local rate limit reached (RATE_LIMIT_PER_MIN). Wait a moment.' };
    return;
  }

  // The call has its own controller: the browser's abort and the idle timeout both cancel it.
  const call = new AbortController();
  const onAbort = () => call.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const idleMs = deps.idleTimeoutMs ?? 20_000;
  let idle = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      idle = true;
      call.abort();
    }, idleMs);
  };
  touch();
  try {
    const stream = await deps.client.messages.create(buildParams(deps, req, opts), { signal: call.signal });
    for await (const event of stream) {
      touch();
      if (signal.aborted) return;
      if (event.type === 'message_start') {
        const u = event.message.usage;
        usage = {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
        };
      } else if (event.type === 'message_delta') {
        stopReason = event.delta.stop_reason ?? stopReason;
        if (event.usage?.output_tokens != null) usage = { ...usage, output: event.usage.output_tokens };
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const step = parser.push(event.delta.text);
        problems.push(...step.errors);
        for (const raw of step.options) {
          const option = cleanOption(raw);
          if (!option || emitted >= limit) continue;
          emitted++;
          const t = now() - start;
          firstMs ??= t;
          lastMs = t;
          yield { type: 'option', ...option };
        }
      }
    }
  } catch (err) {
    if (signal.aborted) return;
    if (idle) {
      console.warn(`[proxy] upstream idle for ${idleMs} ms; aborted`);
      yield { type: 'error', kind: 'timeout', message: `The model stopped responding for ${Math.round(idleMs / 1000)} s.` };
      return;
    }
    const mapped = mapError(err);
    if (mapped.kind === 'internal') console.error('[proxy] upstream failed', err);
    yield { type: 'error', ...mapped };
    return;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
  if (signal.aborted) return;

  const totalMs = now() - start;
  yield { type: 'done', timing: { firstMs, lastMs, totalMs }, usage, costUsd: costUsd(info, usage) };
  if (stopReason === 'refusal') {
    yield { type: 'error', kind: 'refusal', message: 'The model declined this request.' };
  } else if (stopReason === 'max_tokens') {
    yield { type: 'error', kind: 'truncated', message: `The output hit max_tokens (${opts.maxTokens ?? deps.maxTokens}) before it finished.` };
  } else {
    problems.push(...parser.end());
    if (emitted === 0) {
      yield { type: 'error', kind: 'internal', message: problems[0] ?? 'The model returned no options.' };
    } else if (problems.length) {
      console.warn('[proxy] output problems', problems);
    }
  }
}

/** Four one-option calls at once, each with its own direction hint, merged in arrival order. */
async function* parallel(deps: ClaudeDeps, req: RemoteRequest, info: ModelInfo, signal: AbortSignal): AsyncGenerator<RemoteLine> {
  const now = deps.now ?? (() => performance.now());
  const start = now();
  const queue: Array<RemoteLine | null> = [];
  let wake: (() => void) | null = null;
  const push = (line: RemoteLine | null) => {
    queue.push(line);
    wake?.();
  };
  const runs = DIRECTIONS.map(async (direction) => {
    for await (const line of oneCall(deps, req, info, signal, { single: true, direction }, 1)) push(line);
    push(null);
  });

  let open = runs.length;
  let emitted = 0;
  let usage = emptyUsage();
  let firstMs: number | undefined;
  let lastMs: number | undefined;
  const errors: RemoteLine[] = [];
  while (open > 0) {
    if (queue.length === 0) await new Promise<void>((r) => (wake = r));
    wake = null;
    while (queue.length) {
      const line = queue.shift()!;
      if (line === null) {
        open--;
        continue;
      }
      if (signal.aborted) continue;
      if (line.type === 'option') {
        if (emitted >= MAX_OPTIONS) continue;
        emitted++;
        const t = now() - start;
        firstMs ??= t;
        lastMs = t;
        yield line;
      } else if (line.type === 'done') {
        usage = addUsage(usage, line.usage);
      } else {
        errors.push(line);
      }
    }
  }
  await Promise.all(runs);
  if (signal.aborted) return;
  yield { type: 'done', timing: { firstMs, lastMs, totalMs: now() - start }, usage, costUsd: costUsd(info, usage) };
  // Partial success still shows the cards; the first error explains the missing ones.
  if (errors.length) yield errors[0];
}

/**
 * A cheap request with the real system prompt and schema, so the grammar compile and the prompt
 * cache write don't land on the first real request. Returns its usage and how long it took.
 */
export async function warmUp(deps: ClaudeDeps, req: Pick<RemoteRequest, 'model' | 'sounds' | 'effort' | 'thinking'>, signal: AbortSignal) {
  const warm: RemoteRequest = {
    ...req,
    provider: 'claude',
    mode: 'shape',
    buffer: 's("bd*4")',
    selection: { from: 0, to: 9, text: 's("bd*4")' },
    instruction: 'warm-up',
    cps: 0.5,
  };
  let done: Extract<RemoteLine, { type: 'done' }> | null = null;
  let error: Extract<RemoteLine, { type: 'error' }> | null = null;
  for await (const line of oneCall(deps, warm, modelInfo(req.model), signal, { single: true, maxTokens: 200 }, 1)) {
    if (line.type === 'done') done = line;
    if (line.type === 'error' && line.kind !== 'truncated') error = line;
  }
  return { done, error };
}
