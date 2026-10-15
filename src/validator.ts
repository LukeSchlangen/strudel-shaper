import type { Option } from './provider';
import type { CheckResult, Span, StubNames } from './sandbox';
import { splice, type Range } from './splice';

/** One option's eval + query must finish within this, or it's dropped. */
export const VALIDATION_TIMEOUT_MS = 250;

export type DropReason = 'syntax' | 'eval' | 'query' | 'identical' | 'duplicate' | 'timeout';
export type Warning = 'unknown-sample' | 'empty';

export interface ValidationResult {
  ok: boolean; // false = drop
  reason?: DropReason;
  message?: string; // the underlying error text, for retry feedback and the status line
  warnings: Warning[]; // shown on the card, still playable
  unknownSounds?: string[]; // the names behind 'unknown-sample'
  /** Onsets in 2 cycles: the option's own when they can be told apart (eventScope), else the whole buffer's. */
  eventCount: number;
  eventScope?: 'option' | 'buffer';
  ms: number;
}

/** Where the spliced buffer is actually evaluated: a worker in the browser, a Sandbox in tests. */
export interface ValidationBackend {
  check(code: string, cps: number, span?: Span): Promise<CheckResult>;
}

export interface ValidatorDeps {
  backend: ValidationBackend;
  /** Read-only lookup into the live soundMap. */
  hasSound: (key: string) => boolean;
  cps: () => number;
}

export class Validator {
  constructor(private readonly deps: ValidatorDeps) {}

  /** Checks `option` spliced into `buffer` at `range`. `others` are the options already accepted for this request. */
  async validate(buffer: string, range: Range, option: Option, others: Option[]): Promise<ValidationResult> {
    const drop = (reason: DropReason, message: string, ms = 0): ValidationResult => ({
      ok: false,
      reason,
      message,
      warnings: [],
      eventCount: 0,
      ms,
    });
    const code = normalizeCode(option.code);
    if (code === normalizeCode(buffer.slice(range.from, range.to))) {
      return drop('identical', 'The option is the same as the original selection.');
    }
    const twin = others.find((o) => normalizeCode(o.code) === code);
    if (twin) return drop('duplicate', `The option is the same as the earlier option "${twin.label}".`);

    const span = { from: range.from, to: range.from + option.code.length };
    const result = await this.deps.backend.check(splice(buffer, range, option.code), this.deps.cps(), span);
    if (!result.ok) return drop(result.stage, result.message, result.ms);
    // A backend that can't pre-empt (in-process) still reports how long it took.
    if (result.ms > VALIDATION_TIMEOUT_MS) {
      return drop('timeout', `Took ${Math.round(result.ms)} ms (limit ${VALIDATION_TIMEOUT_MS} ms).`, result.ms);
    }
    // Judge the option by its own events when its mini-notation lets us tell them apart: silencing
    // one line of a stack still leaves the others sounding, but that option is empty.
    const own = result.span ?? result;
    const warnings: Warning[] = [];
    const unknownSounds = own.sounds.filter((s) => !this.deps.hasSound(s));
    if (own.eventCount === 0) warnings.push('empty');
    if (unknownSounds.length) warnings.push('unknown-sample');
    return {
      ok: true,
      warnings,
      ...(unknownSounds.length ? { unknownSounds } : {}),
      eventCount: own.eventCount,
      eventScope: result.span ? 'option' : 'buffer',
      ms: result.ms,
    };
  }
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
  | { type: 'check'; id: number; code: string; cps: number; span?: Span };

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

  check(code: string, cps: number, span?: Span): Promise<CheckResult> {
    return new Promise((resolve) => {
      this.queue.push({ id: this.nextId++, code, cps, span, resolve });
      this.pump();
    });
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
    this.worker.postMessage({ type: 'check', id: job.id, code: job.code, cps: job.cps, span: job.span });
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
