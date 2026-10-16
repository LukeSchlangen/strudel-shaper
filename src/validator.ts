import { changeSize } from './diff';
import { locateError } from './errorPosition';
import type { Option } from './provider';
import type { CheckOptions, CheckResult, CheckStage, Span, StubNames } from './sandbox';
import { splice, type Range } from './splice';

/** One option's eval + query must finish within this, or it's dropped. */
export const VALIDATION_TIMEOUT_MS = 250;

/**
 * `buffer`: the option fails only because the unmodified buffer fails the same way, and it fails alone too.
 * `unfixed` (fix modes): the option still fails with the error it was asked to fix.
 */
export type DropReason = 'syntax' | 'eval' | 'query' | 'identical' | 'duplicate' | 'timeout' | 'buffer' | 'unfixed';
export type Warning = 'unknown-sample' | 'empty';

/** The unmodified buffer's own check, once per request. */
export type Baseline = { ok: true; fingerprint?: string } | { ok: false; stage: CheckStage; message: string };

export interface ValidationResult {
  ok: boolean; // false = drop
  reason?: DropReason;
  message?: string; // the underlying error text, for retry feedback and the status line
  warnings: Warning[]; // shown on the card, still playable
  unknownSounds?: string[]; // the names behind 'unknown-sample'
  /** Onsets in 2 cycles: the option's own when they can be told apart (eventScope), else the whole buffer's. */
  eventCount: number;
  eventScope?: 'option' | 'buffer';
  /** The spliced buffer failed with the buffer's own error, so the option was checked on its own. */
  checkedAlone?: boolean;
  /** For `identical`: the same text, or different text that plays exactly the same events. */
  identicalBy?: 'text' | 'sound';
  /** Fix modes: characters inserted plus deleted, against the selection. */
  changeSize?: number;
  ms: number;
}

/** What a fix-mode request is fixing. */
export interface FixContext {
  /** The error being fixed (for a silent selection: stage `silent`, which no check result matches). */
  originalError: { stage: string; message: string };
  /** The buffer also fails outside the selection: judge each option on its own (tempo lines + option). */
  judgeAlone?: boolean;
}

export interface ValidateContext {
  /** The unmodified buffer's own check for this request (shape mode). */
  baseline?: Baseline;
  /** Fix modes. The original is broken by definition, so the baseline rules don't apply. */
  fix?: FixContext;
}

/** Where the spliced buffer is actually evaluated: a worker in the browser, a Sandbox in tests. */
export interface ValidationBackend {
  check(code: string, cps: number, span?: Span, opts?: CheckOptions): Promise<CheckResult>;
}

export interface ValidatorDeps {
  backend: ValidationBackend;
  /** Read-only lookup into the live soundMap. */
  hasSound: (key: string) => boolean;
  cps: () => number;
}

export class Validator {
  constructor(private readonly deps: ValidatorDeps) {}

  /** Checks the unmodified buffer, so options aren't blamed for an error that is already there. */
  async baseline(buffer: string): Promise<Baseline> {
    const r = await this.deps.backend.check(buffer, this.deps.cps(), undefined, { fingerprint: true });
    return r.ok ? { ok: true, ...(r.fingerprint ? { fingerprint: r.fingerprint } : {}) } : { ok: false, stage: r.stage, message: r.message };
  }

  /** The raw check of `code`, with the events of `span` told apart: what ⌘J uses to find what to fix. */
  inspect(code: string, span?: Span): Promise<CheckResult> {
    return this.deps.backend.check(code, this.deps.cps(), span);
  }

  /** Whether a sound key is loaded (read only). */
  hasSound(key: string): boolean {
    return this.deps.hasSound(key);
  }

  /**
   * Checks `option` spliced into `buffer` at `range`. `others` are the options already accepted for
   * this request. With a failing `baseline`, an option that fails the same way is checked on its own
   * (the buffer's tempo lines + the option): kept if that passes, dropped as `buffer` if it fails the
   * same way again. With a passing baseline, an option whose buffer plays exactly the same events
   * as the original buffer (over FINGERPRINT_CYCLES cycles) is dropped as `identical` too.
   */
  async validate(buffer: string, range: Range, option: Option, others: Option[], ctx: ValidateContext = {}): Promise<ValidationResult> {
    const { baseline, fix } = ctx;
    const drop = (reason: DropReason, message: string, ms = 0, extra: Partial<ValidationResult> = {}): ValidationResult => ({
      ok: false,
      reason,
      message,
      warnings: [],
      eventCount: 0,
      ms,
      ...extra,
    });
    const code = normalizeCode(option.code);
    if (code === normalizeCode(buffer.slice(range.from, range.to))) {
      return drop('identical', 'The option is the same as the original selection.', 0, { identicalBy: 'text' });
    }
    const twin = others.find((o) => normalizeCode(o.code) === code);
    if (twin) return drop('duplicate', `The option is the same as the earlier option "${twin.label}".`);

    const span = { from: range.from, to: range.from + option.code.length };
    const tempo = tempoLines(buffer);
    const checkAlone = () => {
      const alone = tempo + option.code;
      return this.deps.backend.check(alone, this.deps.cps(), { from: tempo.length, to: alone.length });
    };
    if (fix) return this.validateFix(buffer, range, option, fix, span, checkAlone);

    const original = baseline?.ok ? baseline.fingerprint : undefined;
    let result = await this.deps.backend.check(splice(buffer, range, option.code), this.deps.cps(), span, original ? { fingerprint: true } : {});
    let checkedAlone = false;
    if (!result.ok && baseline && !baseline.ok && sameError(result, baseline)) {
      const spliced = result;
      result = await checkAlone();
      if (!result.ok && sameError(result, baseline)) return drop('buffer', baseline.message, spliced.ms + result.ms);
      checkedAlone = true;
    }
    if (!result.ok) return drop(result.stage, result.message, result.ms);
    // A backend that can't pre-empt (in-process) still reports how long it took.
    if (result.ms > VALIDATION_TIMEOUT_MS) {
      return drop('timeout', `Took ${Math.round(result.ms)} ms (limit ${VALIDATION_TIMEOUT_MS} ms).`, result.ms);
    }
    if (original && !checkedAlone && result.fingerprint === original) {
      return drop('identical', 'The option sounds exactly like the original.', result.ms, { identicalBy: 'sound' });
    }
    return this.passed(result, checkedAlone);
  }

  /**
   * Fix modes. The fix test: the option spliced into the whole buffer transpiles, evaluates and
   * queries, and makes sound. With errors elsewhere in the buffer (`judgeAlone`, or a new failure
   * located outside the option), the option is judged on its own instead, with the `checked alone`
   * badge. Still failing with the original error is `unfixed`, which is retried once.
   */
  private async validateFix(
    buffer: string,
    range: Range,
    option: Option,
    fix: FixContext,
    span: Span,
    checkAlone: () => Promise<CheckResult>,
  ): Promise<ValidationResult> {
    const size = changeSize(buffer.slice(range.from, range.to), option.code);
    let result: CheckResult;
    let checkedAlone = false;
    let ms = 0;
    if (fix.judgeAlone) {
      result = await checkAlone();
      checkedAlone = true;
    } else {
      const spliced = splice(buffer, range, option.code);
      result = await this.deps.backend.check(spliced, this.deps.cps(), span);
      if (!result.ok && !sameError(result, fix.originalError)) {
        const at = locateError(spliced, result.message).pos;
        if (at !== undefined && (at < span.from || at > span.to)) {
          ms = result.ms;
          result = await checkAlone();
          checkedAlone = true;
        }
      }
    }
    ms += result.ms;
    const fail = (reason: DropReason, message: string): ValidationResult => ({ ok: false, reason, message, warnings: [], eventCount: 0, changeSize: size, ms });
    if (!result.ok) return fail(sameError(result, fix.originalError) ? 'unfixed' : result.stage, result.message);
    if (result.ms > VALIDATION_TIMEOUT_MS) return fail('timeout', `Took ${Math.round(result.ms)} ms (limit ${VALIDATION_TIMEOUT_MS} ms).`);
    const passed = this.passed(result, checkedAlone);
    // The original's problem was silence (or a sound that isn't loaded), and the option has it too.
    const stillSilent = fix.originalError.stage === 'silent' && passed.warnings.includes('empty');
    const stillUnknown = fix.originalError.stage === 'unknown-sample' && passed.warnings.includes('unknown-sample');
    if (stillSilent || stillUnknown) return fail('unfixed', fix.originalError.message);
    return { ...passed, changeSize: size, ms };
  }

  /**
   * A result that passed. Judge the option by its own events when its mini-notation lets us tell
   * them apart: silencing one line of a stack still leaves the others sounding, but that option is empty.
   */
  private passed(result: Extract<CheckResult, { ok: true }>, checkedAlone: boolean): ValidationResult {
    const own = result.span ?? result;
    const warnings: Warning[] = [];
    const unknownSounds = own.sounds.filter((s) => !this.deps.hasSound(s));
    // Onsets with no playable sound (a rest or non-string `s`, so no sound key) are silent too.
    if (own.eventCount === 0 || own.sounds.length === 0) warnings.push('empty');
    if (unknownSounds.length) warnings.push('unknown-sample');
    return {
      ok: true,
      warnings,
      ...(unknownSounds.length ? { unknownSounds } : {}),
      eventCount: own.eventCount,
      eventScope: result.span ? 'option' : 'buffer',
      ...(checkedAlone ? { checkedAlone } : {}),
      ms: result.ms,
    };
  }
}

/** Same stage and same message, ignoring positions (an option with more lines moves the error). */
export function sameError(a: { stage: string; message: string }, b: { stage: string; message: string }): boolean {
  const strip = (m: string) => m.replace(/\(\d+:\d+\)/g, '').replace(/\b(line|col(umn)?)\s*\d+/gi, '').trim();
  return a.stage === b.stage && strip(a.message) === strip(b.message);
}

/** The buffer's top-level tempo calls, each on its own line, so an option checked alone runs at the buffer's tempo. */
export function tempoLines(buffer: string): string {
  return buffer
    .split('\n')
    .filter((l) => /^\s*set(cps|cpm|Cps|Cpm)\s*\([^)]*\)\s*;?\s*(\/\/.*)?$/.test(l))
    .map((l) => l.trim() + '\n')
    .join('');
}

const WORD = /[A-Za-z0-9_$]/;

/**
 * Whitespace-insensitive form of a code snippet, for the identical/duplicate checks. Outside string
 * literals, whitespace runs disappear (or become one space between two word characters). Inside
 * strings, runs collapse to one space and are trimmed: `"hh  hh "` and `"hh hh"` are the same pattern.
 */
export function normalizeCode(code: string): string {
  let out = '';
  let quote: string | null = null;
  let atStringStart = false;
  let pendingSpace = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (/\s/.test(c)) {
      pendingSpace = true;
      continue;
    }
    if (quote) {
      // Inside a string: keep one space between words, none after the opening or before the closing quote.
      if (pendingSpace && !atStringStart && c !== quote) out += ' ';
      atStringStart = false;
      pendingSpace = false;
      if (c === '\\' && i + 1 < code.length) {
        out += c + code[++i];
      } else {
        if (c === quote) quote = null;
        out += c;
      }
      continue;
    }
    if (pendingSpace && WORD.test(c) && WORD.test(out[out.length - 1] ?? '')) out += ' ';
    pendingSpace = false;
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      atStringStart = true;
    }
    out += c;
  }
  return out;
}

// --- Worker backend -----------------------------------------------------------------------------

export type WorkerRequest =
  | { type: 'init'; stubs: StubNames }
  | { type: 'check'; id: number; code: string; cps: number; span?: Span; opts?: CheckOptions };

export type WorkerResponse = { type: 'ready'; stubbed?: StubNames } | { type: 'result'; id: number; result: CheckResult };

/** The part of Worker we use, so tests can pass a fake. */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  terminate(): void;
  onmessage: ((e: { data: WorkerResponse }) => void) | null;
}

interface Job {
  id: number;
  code: string;
  cps: number;
  span?: Span;
  opts?: CheckOptions;
  resolve: (r: CheckResult) => void;
}

/**
 * Runs checks in a worker, one at a time. A check that hasn't answered within the timeout is
 * resolved as `timeout`, and the worker is terminated and replaced: that's the only way to stop a
 * runaway evaluation or query.
 */
export class WorkerBackend implements ValidationBackend {
  private worker!: WorkerLike;
  private ready = false;
  private stubs: StubNames | null = null;
  private queue: Job[] = [];
  private current: Job | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  /** How many times the worker was replaced after a timeout. */
  respawns = 0;
  /** The names the worker had to stub (reported by the worker). */
  stubbed: StubNames | null = null;

  constructor(
    private readonly createWorker: () => WorkerLike,
    private readonly timeoutMs = VALIDATION_TIMEOUT_MS,
  ) {
    this.spawn();
  }

  /** Sends the stub names. Checks wait until this has been called and the worker is ready. */
  init(stubs: StubNames) {
    this.stubs = stubs;
    this.worker.postMessage({ type: 'init', stubs });
  }

  check(code: string, cps: number, span?: Span, opts?: CheckOptions): Promise<CheckResult> {
    return new Promise((resolve) => {
      this.queue.push({ id: this.nextId++, code, cps, span, opts, resolve });
      this.pump();
    });
  }

  /** Stops the worker (the eval harness, when it's done). */
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.worker.terminate();
  }

  private spawn() {
    this.ready = false;
    this.worker = this.createWorker();
    this.worker.onmessage = ({ data }) => this.onMessage(data);
    if (this.stubs) this.worker.postMessage({ type: 'init', stubs: this.stubs });
  }

  private onMessage(msg: WorkerResponse) {
    if (msg.type === 'ready') {
      this.ready = true;
      if (msg.stubbed) this.stubbed = msg.stubbed;
      this.pump();
      return;
    }
    if (!this.current || msg.id !== this.current.id) return;
    this.finish(msg.result);
  }

  private finish(result: CheckResult) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const job = this.current!;
    this.current = null;
    job.resolve(result);
    this.pump();
  }

  private pump() {
    if (this.current || !this.ready) return;
    const job = this.queue.shift();
    if (!job) return;
    this.current = job;
    this.worker.postMessage({ type: 'check', id: job.id, code: job.code, cps: job.cps, span: job.span, opts: job.opts });
    this.timer = setTimeout(() => {
      this.worker.terminate();
      this.respawns++;
      this.spawn();
      this.finish({
        ok: false,
        stage: 'timeout',
        message: `No answer within ${this.timeoutMs} ms.`,
        ms: this.timeoutMs,
      });
    }, this.timeoutMs);
  }
}
