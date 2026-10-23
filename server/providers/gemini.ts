import { ThinkingLevel, Type, type GenerateContentConfig, type GenerateContentParameters, type GenerateContentResponse, type Schema } from '@google/genai';
import { addUsage, emptyUsage, type Effort, type RemoteLine, type RemoteRequest, type ThinkingSetting, type Usage } from '../../src/remoteProtocol';
import { mapError } from '../errors';
import { OptionStreamParser } from '../jsonStream';
import { DIRECTIONS, soundsSystem, staticSystem, userMessage, type UserMessageOptions } from '../prompt';
import { MODELS, costUsd, type ModelInfo } from './models';
import { MAX_OPTIONS, cleanOption, maxOptionsFor } from './postprocess';

export interface GeminiClient {
  models: {
    generateContentStream(
      params: GenerateContentParameters,
      options?: { signal?: AbortSignal },
    ): PromiseLike<AsyncIterable<GenerateContentResponse>>;
  };
}

export interface GeminiDeps {
  client: GeminiClient;
  reference: string;
  maxTokens: number;
  /** Called once per upstream call, before it is made. Return false to refuse it (rate limit). */
  beforeCall?: () => boolean;
  /** Abort a call when no stream event arrives for this long (default 20 s). */
  idleTimeoutMs?: number;
  now?: () => number;
}

export class GeminiProviderLineError extends Error {}

export function geminiModelInfo(model: string): ModelInfo {
  const info = MODELS[model];
  if (!info || info.provider !== 'gemini') {
    const geminiModels = Object.keys(MODELS).filter((k) => MODELS[k].provider === 'gemini');
    throw new GeminiProviderLineError(`Unknown Gemini model "${model}". One of: ${geminiModels.join(', ')}.`);
  }
  return info;
}

/**
 * Strict OpenAPI 3.0 subset schema for Gemini JSON output.
 * Does not include minItems or additionalProperties, which are rejected by Gemini's schema validator.
 */
export function geminiOptionSchema(key = 'options'): Schema {
  return {
    type: Type.OBJECT,
    properties: {
      [key]: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            label: { type: Type.STRING, description: '1–4 lowercase words naming the musical idea or the fix' },
            code: { type: Type.STRING, description: 'Strudel code that replaces only the marked selection' },
          },
          required: ['label', 'code'],
        },
      },
    },
    required: [key],
  };
}

/**
 * Resolves the appropriate ThinkingConfig for the Gemini model.
 * Newer models (Gemini 3.x and 4.x) reject thinkingBudget with INVALID_ARGUMENT (400)
 * and require thinkingLevel instead. Legacy models (Gemini 2.5) use thinkingBudget.
 */
export function resolveGeminiThinkingConfig(
  modelId: string,
  thinking: ThinkingSetting,
  effort?: Effort,
): GenerateContentConfig['thinkingConfig'] {
  // Gemini 3.x and 4.x models use thinkingLevel
  if (modelId.startsWith('gemini-3') || modelId.startsWith('gemini-4')) {
    if (modelId === 'gemini-3.5-flash-lite') {
      if (thinking === 'off') {
        return { thinkingLevel: ThinkingLevel.MINIMAL };
      }
      if (effort === 'high') return { thinkingLevel: ThinkingLevel.HIGH };
      if (effort === 'medium') return { thinkingLevel: ThinkingLevel.MEDIUM };
      return { thinkingLevel: ThinkingLevel.LOW };
    }

    // gemini-3.8-flash, gemini-4-argon (support LOW, MEDIUM, HIGH)
    if (thinking === 'off') {
      return { thinkingLevel: ThinkingLevel.LOW };
    }
    if (effort === 'high') return { thinkingLevel: ThinkingLevel.HIGH };
    if (effort === 'medium') return { thinkingLevel: ThinkingLevel.MEDIUM };
    return { thinkingLevel: ThinkingLevel.LOW };
  }

  // Legacy models (Gemini 2.5 series) use thinkingBudget
  if (thinking === 'off') {
    return { thinkingBudget: 0 };
  } else if (thinking === 'adaptive') {
    return { thinkingBudget: -1 };
  }
  return undefined;
}

export function buildGeminiParams(
  deps: GeminiDeps,
  req: RemoteRequest,
  opts: UserMessageOptions & { maxTokens?: number } = {},
  signal?: AbortSignal,
): GenerateContentParameters {
  const info = geminiModelInfo(req.model);
  const thinking = req.thinking ?? info.defaults.thinking;
  const effort = req.effort ?? info.defaults.effort;
  const systemInstruction = `${staticSystem(deps.reference)}\n\n${soundsSystem(req.sounds)}`;

  // For Gemini, thinking tokens share maxOutputTokens with candidate tokens.
  // We cap single-option calls at 800 tokens (or deps.maxTokens if smaller) so thinking
  // plus response can complete without truncation or INVALID_ARGUMENT rejection.
  const singleCap = Math.min(800, deps.maxTokens);
  const maxOutputTokens = opts.maxTokens ?? (opts.single ? singleCap : deps.maxTokens);

  const config: GenerateContentConfig = {
    systemInstruction,
    responseMimeType: 'application/json',
    responseSchema: geminiOptionSchema(),
    maxOutputTokens,
    ...(signal ? { abortSignal: signal } : {}),
  };

  const thinkingConfig = resolveGeminiThinkingConfig(info.id, thinking, effort);
  if (thinkingConfig) {
    config.thinkingConfig = thinkingConfig;
  }

  return {
    model: info.id,
    contents: userMessage(req, opts),
    config,
  };
}

/**
 * Streams options for one request as protocol lines: each option as soon as its JSON object closes,
 * then one `done` line with timing and usage, or an `error` line. Never throws. Stops quietly when
 * `signal` aborts.
 */
export async function* streamGeminiOptions(
  deps: GeminiDeps,
  req: RemoteRequest,
  signal: AbortSignal,
): AsyncGenerator<RemoteLine> {
  let info: ModelInfo;
  try {
    info = geminiModelInfo(req.model);
  } catch (err) {
    yield { type: 'error', kind: 'bad-request', message: (err as Error).message };
    return;
  }
  const single = !!req.feedback;
  if (req.strategy === 'parallel' && !single && req.mode === 'shape') {
    yield* parallel(deps, req, info, signal);
    return;
  }
  yield* oneCall(deps, req, info, signal, { single }, single ? 1 : maxOptionsFor(req.mode));
}

async function* oneCall(
  deps: GeminiDeps,
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
  let finishReason: string | null = null;
  const parser = new OptionStreamParser();
  const problems: string[] = [];

  if (deps.beforeCall && !deps.beforeCall()) {
    yield { type: 'error', kind: 'local-rate-limit', message: 'Local rate limit reached (RATE_LIMIT_PER_MIN). Wait a moment.' };
    return;
  }

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
    const params = buildGeminiParams(deps, req, opts, call.signal);
    const stream = await deps.client.models.generateContentStream(params, { signal: call.signal });
    for await (const chunk of stream) {
      touch();
      if (signal.aborted) return;
      if (chunk.usageMetadata) {
        const u = chunk.usageMetadata;
        const promptTokens = u.promptTokenCount ?? 0;
        const cachedTokens = u.cachedContentTokenCount ?? 0;
        usage = {
          input: Math.max(0, promptTokens - cachedTokens),
          output: u.candidatesTokenCount ?? usage.output,
          cacheRead: cachedTokens,
          cacheWrite: 0,
        };
      }
      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason) {
        finishReason = candidate.finishReason;
      }
      const parts = candidate?.content?.parts;
      let text = '';
      if (parts && parts.length > 0) {
        for (const p of parts) {
          if (!p.thought && p.text) text += p.text;
        }
      } else if (chunk.text) {
        text = chunk.text;
      }
      if (text) {
        const step = parser.push(text);
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
  yield { type: 'done', timing: { firstMs, lastMs, totalMs }, usage, costUsd: costUsd(info, usage), model: info.id };
  if (finishReason === 'SAFETY' || finishReason === 'BLOCKLIST' || finishReason === 'PROHIBITED_CONTENT') {
    yield { type: 'error', kind: 'refusal', message: 'The model declined this request due to safety policies.' };
  } else if (finishReason === 'MAX_TOKENS') {
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
async function* parallel(deps: GeminiDeps, req: RemoteRequest, info: ModelInfo, signal: AbortSignal): AsyncGenerator<RemoteLine> {
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
  yield { type: 'done', timing: { firstMs, lastMs, totalMs: now() - start }, usage, costUsd: costUsd(info, usage), model: info.id };
  if (errors.length) yield errors[0];
}

/**
 * A cheap request with the real system prompt and schema, so cold starts don't land on the first real request.
 */
export async function warmUp(deps: GeminiDeps, req: Pick<RemoteRequest, 'model' | 'sounds' | 'effort' | 'thinking'>, signal: AbortSignal) {
  const warm: RemoteRequest = {
    ...req,
    provider: 'gemini',
    mode: 'shape',
    buffer: 's("bd*4")',
    selection: { from: 0, to: 9, text: 's("bd*4")' },
    instruction: 'warm-up',
    cps: 0.5,
  };
  let done: Extract<RemoteLine, { type: 'done' }> | null = null;
  let error: Extract<RemoteLine, { type: 'error' }> | null = null;
  for await (const line of oneCall(deps, warm, geminiModelInfo(req.model), signal, { single: true, maxTokens: Math.min(800, deps.maxTokens) }, 1)) {
    if (line.type === 'done') done = line;
    if (line.type === 'error' && line.kind !== 'truncated') error = line;
  }
  return { done, error };
}
