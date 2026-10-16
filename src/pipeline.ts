import { asksForSilence, feedbackFor, type RetryReason } from './feedback';
import type { Option, OptionRequest, Provider, ProviderStats } from './provider';
import type { Range } from './splice';
import type { OptionSlot, TrayEvent } from './trayMachine';
import { normalizeCode, type Baseline, type ValidationResult, type Validator } from './validator';

export { reasonLabel } from './feedback';

export interface PipelineDeps {
  provider: Provider;
  validator: Pick<Validator, 'validate'> & Partial<Pick<Validator, 'baseline'>>;
  /** The editor text and the (stale-guard-mapped) range, read when each validation runs. */
  getBuffer: () => string;
  getRange: () => Range;
  emit: (event: TrayEvent) => void;
  /** A few loaded sound names for unknown-sample feedback, e.g. "bd sd hh oh cp". */
  soundHint?: () => string;
}

/** Usage over every provider call of one request (the first call and its retries). */
export interface RequestStats extends ProviderStats {
  calls: number;
}

function addStats(a: RequestStats | undefined, s: ProviderStats, first: boolean): RequestStats {
  const base: RequestStats = a ?? { calls: 0 };
  const tokens = s.tokens && {
    input: (base.tokens?.input ?? 0) + s.tokens.input,
    output: (base.tokens?.output ?? 0) + s.tokens.output,
    cacheRead: (base.tokens?.cacheRead ?? 0) + s.tokens.cacheRead,
    cacheWrite: (base.tokens?.cacheWrite ?? 0) + s.tokens.cacheWrite,
  };
  return {
    ...base,
    ...(first ? { firstMs: s.firstMs, lastMs: s.lastMs, totalMs: s.totalMs } : {}),
    calls: base.calls + 1,
    ...(tokens ? { tokens } : {}),
    ...(s.costUsd !== undefined ? { costUsd: (base.costUsd ?? 0) + s.costUsd } : {}),
  };
}

/** The warning worth one retry, if any: `empty` (unless the instruction asks for silence) or `unknown-sample`. */
export function silentRetryReason(result: ValidationResult, instruction: string): RetryReason | null {
  if (!result.ok) return null;
  if (result.warnings.includes('unknown-sample')) return 'unknown-sample';
  if (result.warnings.includes('empty') && !asksForSilence(instruction)) return 'empty';
  return null;
}

/**
 * Streams options from the provider and validates each one in arrival order, after one check of
 * the unmodified buffer (the baseline). It asks once for a replacement (with feedback) for any
 * that fail, and for any that make no sound or use an unknown sound. Emits tray events tagged with
 * `requestId`, and nothing once `signal` aborts. `requestDone` comes only after every validation
 * and retry has settled.
 */
export async function runRequest(
  deps: PipelineDeps,
  requestId: number,
  req: OptionRequest,
  slotCount: number,
  signal: AbortSignal,
): Promise<void> {
  const { provider, validator, emit } = deps;
  const accepted: Array<{ slot: OptionSlot; option: Option }> = [];
  const settling: Array<Promise<void>> = [];
  let stats: RequestStats | undefined;
  const hooks = (first: boolean) => ({ onStats: (s: ProviderStats) => (stats = addStats(stats, s, first)) });

  // One validation at a time, in arrival order: "duplicate" means the same as one accepted before it.
  // The baseline goes first, so every option is judged against it.
  let baseline: Baseline | undefined;
  let queue: Promise<unknown> = validator.baseline
    ? validator
        .baseline(deps.getBuffer())
        .then((b) => {
          baseline = b;
          if (!signal.aborted) emit({ type: 'bufferChecked', requestId, error: b.ok ? undefined : b.message });
        })
        .catch((err) => console.error('[shaper] baseline check failed', err))
    : Promise.resolve();
  const validate = (option: Option, slot: OptionSlot): Promise<ValidationResult | null> => {
    const job = queue.then(async () => {
      if (signal.aborted) return null;
      const result = await validator.validate(deps.getBuffer(), deps.getRange(), option, accepted.map((a) => a.option), { baseline });
      if (result.ok) accepted.push({ slot, option });
      return result;
    });
    queue = job.catch(() => {});
    return job;
  };
  const unaccept = (option: Option) => {
    const i = accepted.findIndex((a) => a.option === option);
    if (i >= 0) accepted.splice(i, 1);
  };

  const selection = () => {
    const range = deps.getRange();
    return { ...range, text: deps.getBuffer().slice(range.from, range.to) };
  };

  const feedback = (option: Option, reason: RetryReason, result: ValidationResult): string => {
    const code = normalizeCode(option.code);
    return feedbackFor(reason, {
      message: result.message,
      twinSlot: reason === 'duplicate' ? accepted.find((a) => normalizeCode(a.option.code) === code)?.slot : undefined,
      unknownSounds: result.unknownSounds,
      soundHint: deps.soundHint?.(),
      sameSound: result.identicalBy === 'sound',
    });
  };

  /** One replacement for a slot, or why there isn't one. */
  const replacementFor = async (option: Option, reason: RetryReason, result: ValidationResult): Promise<Option | string> => {
    const retryReq: OptionRequest = {
      ...req,
      buffer: deps.getBuffer(),
      selection: selection(),
      feedback: { previousCode: option.code, error: feedback(option, reason, result) },
    };
    try {
      for await (const replacement of provider.generateOptions(retryReq, signal, hooks(false))) return replacement;
    } catch (err) {
      console.error('[shaper] replacement request failed', err);
      return (err as Error)?.message ?? String(err);
    }
    return 'no replacement';
  };

  const validated = (slot: OptionSlot, option: Option, result: ValidationResult) =>
    emit({
      type: 'optionValidated',
      requestId,
      slot,
      option,
      warnings: result.warnings,
      unknownSounds: result.unknownSounds,
      checkedAlone: result.checkedAlone,
      ms: result.ms,
    });

  /**
   * `kept` is a playable option that was retried only for a warning: if its replacement fails,
   * the slot falls back to it (with its badge) rather than ending up empty.
   */
  const handle = async (slot: OptionSlot, option: Option, isRetry: boolean, kept?: { option: Option; result: ValidationResult }): Promise<void> => {
    let result: ValidationResult | null;
    try {
      result = await validate(option, slot);
    } catch (err) {
      result = { ok: false, reason: 'eval', message: `Validator failed: ${String(err)}`, warnings: [], eventCount: 0, ms: 0 };
    }
    if (!result || signal.aborted) return;

    const fallBack = () => {
      if (!kept) return false;
      accepted.push({ slot, option: kept.option });
      validated(slot, kept.option, kept.result);
      return true;
    };

    if (result.ok) {
      const silent = isRetry ? null : silentRetryReason(result, req.instruction);
      if (!silent) return validated(slot, option, result);
      // Playable but silent (or an unknown sound): one retry. The option stays in reserve.
      unaccept(option);
      emit({ type: 'optionRetrying', requestId, slot, reason: silent, message: feedback(option, silent, result), ms: result.ms });
      return retry(slot, option, silent, result, { option, result });
    }

    const failure = { requestId, slot, reason: result.reason!, message: result.message ?? '', ms: result.ms };
    if (isRetry) {
      if (!fallBack()) emit({ type: 'optionDropped', ...failure });
      return;
    }
    // The buffer's own error, and the option fails the same way alone: a retry can't help.
    if (result.reason === 'buffer') {
      emit({ type: 'optionDropped', ...failure });
      return;
    }
    emit({ type: 'optionRetrying', ...failure });
    return retry(slot, option, result.reason!, result);
  };

  const retry = async (slot: OptionSlot, option: Option, reason: RetryReason, result: ValidationResult, kept?: { option: Option; result: ValidationResult }) => {
    const replacement = await replacementFor(option, reason, result);
    if (signal.aborted) return;
    if (typeof replacement === 'string') {
      if (kept) {
        accepted.push({ slot, option: kept.option });
        validated(slot, kept.option, kept.result);
        return;
      }
      emit({ type: 'optionDropped', requestId, slot, reason: result.reason ?? 'eval', message: `${result.message ?? ''} (${replacement})`.trim(), ms: 0 });
      return;
    }
    emit({ type: 'optionArrived', requestId, slot, option: replacement });
    await handle(slot, replacement, true, kept);
  };

  let error: string | undefined;
  let next = 0;
  try {
    for await (const option of provider.generateOptions(req, signal, hooks(true))) {
      if (signal.aborted) return;
      if (next >= slotCount) continue;
      const slot = ++next as OptionSlot;
      emit({ type: 'optionArrived', requestId, slot, option });
      // Not awaited: retries run alongside the rest of the stream.
      settling.push(handle(slot, option, false));
    }
  } catch (err) {
    console.error('[shaper] provider failed', err);
    error = String((err as Error)?.message ?? err);
  }
  await Promise.all(settling);
  await queue;
  if (!signal.aborted) emit({ type: 'requestDone', requestId, error, stats });
}
