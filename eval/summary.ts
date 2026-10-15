import type { RetryReason } from '../src/feedback';
import type { RequestStats } from '../src/pipeline';

export interface SlotResult {
  status: 'ready' | 'dropped' | 'validating' | 'empty';
  label?: string;
  code?: string;
  warnings?: string[];
  unknownSounds?: string[];
  checkedAlone?: boolean;
  retried?: boolean;
  drop?: { reason: RetryReason; message: string };
  /** Every option this slot received, in order (the first, then any replacement). */
  attempts: Array<{ label: string; code: string; arrivedMs: number; outcome?: string }>;
}

export interface RequestResult {
  id: string;
  bufferId: string;
  buffer: string;
  selection: { from: number; to: number; text: string };
  instruction: string;
  /** First option from the provider, before validation. */
  firstArrivalMs?: number;
  /** First card shown (validated): the number the 2 s target is about. */
  firstCardMs?: number;
  /** Last slot settled (validated or dropped), retries included. */
  lastSettledMs?: number;
  totalMs: number;
  stats?: RequestStats;
  error?: string;
  bufferError?: string;
  retries: Array<{ slot: number; reason: RetryReason; message: string; code?: string }>;
  drops: Array<{ slot: number; reason: RetryReason; message: string; code?: string }>;
  slots: SlotResult[];
}

export interface Report {
  label: string;
  createdAt: string;
  config: Record<string, unknown>;
  soundsTokens: number;
  referenceTokens: number;
  results: RequestResult[];
}

const TARGET_MS = 2000;

function pct(values: number[], p: number) {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const sec = (ms?: number) => (ms === undefined ? '—' : `${(ms / 1000).toFixed(2)} s`);
const count = <T extends string>(items: T[]) =>
  Object.entries(
    items.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {}),
  )
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(', ') || 'none';

/** The markdown summary: latency against the 2 s target, pass rate, retries/drops by reason, tokens and cost. */
export function summarise(report: Report): string {
  const r = report.results;
  const first = r.map((x) => x.firstCardMs).filter((v): v is number => v !== undefined);
  const arrival = r.map((x) => x.firstArrivalMs).filter((v): v is number => v !== undefined);
  const last = r.map((x) => x.lastSettledMs).filter((v): v is number => v !== undefined);
  const firstAttempts = r.flatMap((x) => x.slots.filter((s) => s.attempts.length > 0).map((s) => s.attempts[0]));
  const cleanFirst = firstAttempts.filter((a) => !a.outcome).length;
  const slotsReady = r.flatMap((x) => x.slots).filter((s) => s.status === 'ready');
  const offered = r.reduce((n, x) => n + x.slots.filter((s) => s.attempts.length > 0).length, 0);
  const warnings = slotsReady.flatMap((s) => s.warnings ?? []);
  const n = r.length || 1;
  const sum = (f: (s: RequestStats) => number) => r.reduce((t, x) => t + (x.stats ? f(x.stats) : 0), 0);
  const tokensIn = sum((s) => (s.tokens ? s.tokens.input + s.tokens.cacheRead + s.tokens.cacheWrite : 0));
  const cached = sum((s) => s.tokens?.cacheRead ?? 0);
  const out = sum((s) => s.tokens?.output ?? 0);
  const cost = sum((s) => s.costUsd ?? 0);
  const calls = sum((s) => s.calls);
  const errors = r.filter((x) => x.error);

  const lines = [
    `### ${report.label} (${report.createdAt.slice(0, 16).replace('T', ' ')})`,
    '',
    `Config: ${JSON.stringify(Object.fromEntries(Object.entries(report.config).filter(([, v]) => v !== undefined && v !== false)))}. Prompt: reference ~${report.referenceTokens} tok, sounds ~${report.soundsTokens} tok.`,
    '',
    '| Metric | p50 | p90 | max | ≤ 2 s |',
    '| --- | --- | --- | --- | --- |',
    `| First option from the provider | ${sec(pct(arrival, 50))} | ${sec(pct(arrival, 90))} | ${sec(Math.max(...arrival))} | ${arrival.filter((v) => v <= TARGET_MS).length}/${r.length} |`,
    `| **First card shown** (validated) | ${sec(pct(first, 50))} | ${sec(pct(first, 90))} | ${sec(Math.max(...first))} | ${first.filter((v) => v <= TARGET_MS).length}/${r.length} |`,
    `| Last slot settled (retries incl.) | ${sec(pct(last, 50))} | ${sec(pct(last, 90))} | ${sec(Math.max(...last))} | ${last.filter((v) => v <= TARGET_MS).length}/${r.length} |`,
    '',
    `- **Pass rate, first attempt** (validated with no warning and no retry): ${cleanFirst}/${firstAttempts.length} (${Math.round((100 * cleanFirst) / (firstAttempts.length || 1))}%)`,
    `- **Cards shown**: ${slotsReady.length}/${r.length * 4} slots (${offered} options offered first; ${r.filter((x) => x.slots.filter((s) => s.status === 'ready').length >= 3).length}/${r.length} requests ended with ≥ 3 cards)`,
    `- Retries by reason: ${count(r.flatMap((x) => x.retries.map((y) => y.reason)))}`,
    `- Drops by reason: ${count(r.flatMap((x) => x.drops.map((y) => y.reason)))}`,
    `- Warnings on shown cards: ${count(warnings)}`,
    `- Errors: ${errors.length ? errors.map((x) => `${x.id}: ${x.error}`).join('; ') : 'none'}`,
    `- Tokens per request: ${Math.round(tokensIn / n)} in (${Math.round(cached / n)} cache reads), ${Math.round(out / n)} out; ${(calls / n).toFixed(2)} calls`,
    `- **Cost per request**: $${(cost / n).toFixed(5)} (total $${cost.toFixed(4)})`,
  ];
  return lines.join('\n') + '\n';
}
