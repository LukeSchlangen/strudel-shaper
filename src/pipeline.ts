import type { Option, OptionRequest, Provider } from './provider';
import type { Range } from './splice';
import type { OptionSlot, TrayEvent } from './trayMachine';
import { normalizeCode, type DropReason, type ValidationResult, type Validator } from './validator';

export interface PipelineDeps {
  provider: Provider;
  validator: Pick<Validator, 'validate'>;
  /** The editor text and the (stale-guard-mapped) range, read when each validation runs. */
  getBuffer: () => string;
  getRange: () => Range;
  emit: (event: TrayEvent) => void;
}

/** Plain-words names for the status line, cards and feedback. `eval` errors that are unknown functions get their own. */
export function reasonLabel(reason: DropReason, message = ''): string {
  if (reason === 'eval' && /is not a function/.test(message)) return 'unknown function';
  return { syntax: 'syntax', eval: 'eval error', query: 'query error', timeout: 'timeout', identical: 'identical', duplicate: 'duplicate' }[reason];
}

/**
 * Streams options from the provider, validates each one in arrival order, and asks once for a
 * replacement (with feedback) for any that fail. Emits tray events tagged with `requestId`; emits
 * nothing once `signal` aborts. `requestDone` comes only after every validation and retry settled.
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

  // One validation at a time, in arrival order: "duplicate" means the same as one accepted before it.
  let queue: Promise<unknown> = Promise.resolve();
  const validate = (option: Option, slot: OptionSlot): Promise<ValidationResult | null> => {
    const job = queue.then(async () => {
      if (signal.aborted) return null;
      const result = await validator.validate(deps.getBuffer(), deps.getRange(), option, accepted.map((a) => a.option));
      if (result.ok) accepted.push({ slot, option });
      return result;
    });
    queue = job.catch(() => {});
    return job;
  };

  const selection = () => {
    const range = deps.getRange();
    return { ...range, text: deps.getBuffer().slice(range.from, range.to) };
  };

  const feedbackFor = (option: Option, result: ValidationResult): string => {
    if (result.reason === 'identical') {
      return 'This option is the same as the original selection. Suggest a different variation.';
    }
    if (result.reason === 'duplicate') {
      const code = normalizeCode(option.code);
      const twin = accepted.find((a) => normalizeCode(a.option.code) === code);
      return `This option is the same as option ${twin?.slot ?? 'another'}. Suggest a different variation.`;
    }
    return `${reasonLabel(result.reason!, result.message)}: ${result.message}`;
  };

  const replacementFor = async (option: Option, result: ValidationResult): Promise<Option | null> => {
    const retryReq: OptionRequest = {
      ...req,
      buffer: deps.getBuffer(),
      selection: selection(),
      feedback: { previousCode: option.code, error: feedbackFor(option, result) },
    };
    try {
      for await (const replacement of provider.generateOptions(retryReq, signal)) return replacement;
    } catch (err) {
      console.error('[shaper] replacement request failed', err);
    }
    return null;
  };

  const handle = async (slot: OptionSlot, option: Option, isRetry: boolean): Promise<void> => {
    let result: ValidationResult | null;
    try {
      result = await validate(option, slot);
    } catch (err) {
      result = { ok: false, reason: 'eval', message: `Validator failed: ${String(err)}`, warnings: [], eventCount: 0, ms: 0 };
    }
    if (!result || signal.aborted) return;
    const { ms } = result;
    if (result.ok) {
      emit({ type: 'optionValidated', requestId, slot, option, warnings: result.warnings, unknownSounds: result.unknownSounds, ms });
      return;
    }
    const failure = { requestId, slot, reason: result.reason!, message: result.message ?? '', ms };
    if (isRetry) {
      emit({ type: 'optionDropped', ...failure });
      return;
    }
    emit({ type: 'optionRetrying', ...failure });
    const replacement = await replacementFor(option, result);
    if (signal.aborted) return;
    if (!replacement) {
      emit({ type: 'optionDropped', ...failure, ms: 0, message: `${failure.message} (no replacement)` });
      return;
    }
    emit({ type: 'optionArrived', requestId, slot, option: replacement });
    await handle(slot, replacement, true);
  };

  let error: string | undefined;
  let next = 0;
  try {
    for await (const option of provider.generateOptions(req, signal)) {
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
  if (!signal.aborted) emit({ type: 'requestDone', requestId, error });
}
