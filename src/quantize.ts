import { Fraction, Pattern, TimeSpan } from '@strudel/core';

export type SwapMode = 'immediate' | 'beat' | 'cycle';
export const SWAP_MODES: SwapMode[] = ['immediate', 'beat', 'cycle'];

/**
 * The cycle position a swap lands on, given that everything before `lastEnd` is already scheduled.
 * Always ≥ lastEnd. null means immediately (at lastEnd, as in milestone 1).
 */
export function nextBoundary(lastEnd: number, mode: SwapMode, beatsPerCycle = 4): number | null {
  switch (mode) {
    case 'immediate':
      return null;
    case 'beat':
      return Math.ceil(lastEnd * beatsPerCycle) / beatsPerCycle;
    case 'cycle':
      return Math.ceil(lastEnd);
  }
}

/**
 * A pattern that is `before` up to cycle `at` and `after` from `at` on. Queries are split at `at`,
 * so each onset comes from exactly one side; fragments of haps that cross `at` have no onset and
 * never trigger. The query state (controls such as the Drawer's painters) is passed through untouched.
 */
export function stitch(before: any, after: any, at: number): any {
  const n = Fraction(at);
  return new Pattern((state: any) => {
    const { begin, end } = state.span;
    const haps: any[] = [];
    if (begin.lt(n)) haps.push(...before.query(state.setSpan(new TimeSpan(begin, end.lt(n) ? end : n))));
    if (end.gt(n) || begin.gte(n)) haps.push(...after.query(state.setSpan(new TimeSpan(begin.gt(n) ? begin : n, end))));
    return haps;
  });
}

/** The parts of the Cyclist (@strudel/core/cyclist.mjs) the quantizer touches. */
export interface SchedulerLike {
  lastEnd: number;
  started: boolean;
  cps: number;
  pattern: any;
  now(): number;
  setPattern(pattern: any, autostart?: boolean): unknown;
}

interface Pending {
  base: any; // what plays before `at`
  next: any; // what plays from `at` on
  at: number;
  stitched: any;
}

/**
 * Lands our own pattern swaps on the next beat or cycle by wrapping `scheduler.setPattern`.
 * repl.evaluate calls setPattern before afterEval, so the Drawer's invalidate already sees the
 * stitched pattern. Only calls made while `armed` are quantized; outside evaluations (Ctrl+Enter,
 * Play) go straight through, as in Strudel.
 */
export class Quantizer {
  mode: SwapMode = 'beat';
  beatsPerCycle = 4;
  armed = false;
  pending: Pending | null = null;

  constructor(private readonly scheduler: SchedulerLike) {
    const setPattern = scheduler.setPattern.bind(scheduler);
    scheduler.setPattern = (pattern, autostart) => setPattern(this.wrap(pattern), autostart);
  }

  private wrap(pattern: any): any {
    const s = this.scheduler;
    const at = nextBoundary(s.lastEnd, this.mode, this.beatsPerCycle);
    if (!this.armed || !s.started || at === null) {
      this.pending = null;
      return pattern;
    }
    // A second press before the boundary replaces the pending choice; it doesn't stitch onto it.
    const stillPending = this.pending && s.lastEnd < this.pending.at;
    const base = stillPending ? this.pending!.base : (this.pending?.next ?? s.pattern);
    const boundary = stillPending ? this.pending!.at : at;
    const stitched = stitch(base, pattern, boundary);
    this.pending = { base, next: pattern, at: boundary, stitched };
    return stitched;
  }

  /** Drop the wrapper once it's no longer needed: after landing, or when the clock stops (lastEnd resets to 0). */
  settle(force = false) {
    const p = this.pending;
    if (!p) return;
    if (force || this.scheduler.lastEnd >= p.at) {
      if (this.scheduler.pattern === p.stitched) this.scheduler.pattern = p.next;
      this.pending = null;
    }
  }

  /** Resolves once the pending swap is audible (scheduler.now() ≥ boundary), or right away if none. */
  landed(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        const p = this.pending;
        const s = this.scheduler;
        if (!p || !s.started) return resolve();
        const remaining = p.at - s.now();
        if (remaining <= 0) {
          this.settle();
          return resolve();
        }
        setTimeout(check, Math.max(10, (remaining / s.cps) * 1000));
      };
      check();
    });
  }

  /** What will be playing once any pending swap lands: the pattern to snapshot before auditioning. */
  playing(): any {
    return this.pending?.next ?? this.scheduler.pattern;
  }

  /**
   * Swaps to an existing pattern (a snapshot), quantized like our own evaluations. Used when the
   * original can't be evaluated: 0/Esc in fix modes go back to what played before the tray opened.
   */
  swapTo(pattern: any) {
    this.armed = true;
    try {
      void this.scheduler.setPattern(pattern);
    } finally {
      this.armed = false;
    }
  }

  cycleMode(): SwapMode {
    this.mode = SWAP_MODES[(SWAP_MODES.indexOf(this.mode) + 1) % SWAP_MODES.length];
    return this.mode;
  }
}
