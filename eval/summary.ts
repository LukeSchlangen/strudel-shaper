import type { RetryReason } from '../src/feedback';
import type { RequestStats } from '../src/pipeline';
import type { Mode } from '../src/provider';

export interface SlotResult {
  status: 'ready' | 'dropped' | 'validating' | 'empty';
  label?: string;
  code?: string;
  warnings?: string[];
  unknownSounds?: string[];
  checkedAlone?: boolean;
  /** Fix modes: characters changed against the selection. */
  changeSize?: number;
  retried?: boolean;
  drop?: { reason: RetryReason; message: string };
  /** Every option this slot received, in order (the first, then any replacement). */
  attempts: Array<{ label: string; code: string; arrivedMs: number; outcome?: string }>;
}

export interface RequestResult {
  id: string;
  bufferId: string;
  buffer: string;
  /** Absent in reports from before milestone 5 (shape). */
  mode?: Mode;
  selection: { from: number; to: number; text: string };
  instruction: string;
  /** Fix modes: what diagnoseFix found. */
  diagnosis?: { kind: string; stage?: string; message?: string; line?: number; otherError?: boolean };
  /** Fix modes: the original doesn't evaluate (card 0 is "original (broken)"). Always set for generate. */
  originalBroken?: boolean;
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
    `- **Cards shown**: ${slotsReady.length}/${r.reduce((n, x) => n + x.slots.length, 0)} slots (${offered} options offered first; ${r.filter((x) => x.slots.filter((s) => s.status === 'ready').length >= 3).length}/${r.length} requests ended with ≥ 3 cards)`,
    `- Retries by reason: ${count(r.flatMap((x) => x.retries.map((y) => y.reason)))}`,
    `- Drops by reason: ${count(r.flatMap((x) => x.drops.map((y) => y.reason)))}`,
    `- Warnings on shown cards: ${count(warnings)}`,
    `- Errors: ${errors.length ? errors.map((x) => `${x.id}: ${x.error}`).join('; ') : 'none'}`,
    `- Tokens per request: ${Math.round(tokensIn / n)} in (${Math.round(cached / n)} cache reads), ${Math.round(out / n)} out; ${(calls / n).toFixed(2)} calls`,
    `- **Cost per request**: $${(cost / n).toFixed(5)} (total $${cost.toFixed(4)})`,
  ];
  const sameSound = r.flatMap((x) => [...x.retries, ...x.drops]).filter((y) => y.reason === 'identical' && /sounds exactly/.test(y.message)).length;
  lines.push(`- Sounds the same as the original (fingerprint): ${sameSound} retried or dropped`);
  if (r.some((x) => x.mode === 'fix-minimal' || x.mode === 'fix-rewrite')) lines.push('', ...fixSummary(r));
  if (r.some((x) => x.mode === 'generate')) lines.push('', ...generateSummary(r));
  return lines.join('\n') + '\n';
}

/** Generate runs: the ideas each request got, so variety can be read at a glance (the listening page plays them). */
function generateSummary(r: RequestResult[]): string[] {
  const cell = (v: string) => v.replace(/\|/g, '\\|').replace(/\n/g, ' ⏎ ');
  const lines = (code?: string) => (code ? code.split('\n').length : 0);
  return [
    '| Request | Instruction | Cards | Labels | Lines per card | Retries |',
    '| --- | --- | --- | --- | --- | --- |',
    ...r.map((x) => {
      const ready = x.slots.filter((s) => s.status === 'ready');
      return `| ${x.id} | ${cell(x.instruction || '(none)')} | ${ready.length}/${x.slots.length} | ${ready.map((s) => cell(s.label ?? '')).join(', ')} | ${ready.map((s) => lines(s.code)).join(', ')} | ${x.retries.map((y) => y.reason).join(', ')} |`;
    }),
  ];
}

/** A card that fixes the request: it passed the fix test (whole buffer works, or alone when the buffer has another error) and sounds. */
const fixes = (s: SlotResult) => s.status === 'ready' && !(s.warnings ?? []).length;

/** Fix runs: fix rate, first-try fix rate, change size of minimal fixes, and a row per request. */
function fixSummary(r: RequestResult[]): string[] {
  const sent = r.filter((x) => !x.error?.startsWith('no request'));
  const fixed = sent.filter((x) => x.slots.some(fixes));
  const firstTry = sent.filter((x) => {
    const s = x.slots[0];
    return s && fixes(s) && s.attempts.length === 1;
  });
  const minimal = r.filter((x) => x.mode === 'fix-minimal');
  const sizes = minimal.flatMap((x) => x.slots.filter(fixes).map((s) => s.changeSize ?? 0));
  const cell = (v: string) => v.replace(/\|/g, '\\|').replace(/\n/g, ' ⏎ ');
  return [
    `- **Fix rate** (≥ 1 card that works in the whole buffer and sounds): ${fixed.length}/${sent.length}`,
    `- **First-try fix rate** (card 1, first attempt, no retry): ${firstTry.length}/${sent.length}`,
    `- **Change size of minimal fixes** (characters): p50 ${pct(sizes, 50) ?? '—'} · p90 ${pct(sizes, 90) ?? '—'} · max ${sizes.length ? Math.max(...sizes) : '—'} (${sizes.length} cards)`,
    `- Requests not sent: ${r.length - sent.length}${r.length > sent.length ? ` (${r.filter((x) => !sent.includes(x)).map((x) => `${x.id}: ${x.error}`).join('; ')})` : ''}`,
    '',
    '| Request | Mode | Diagnosis | Cards | First card | Change | Retries |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...r.map((x) => {
      const ready = x.slots.filter((s) => s.status === 'ready');
      const first = ready[0];
      const diag = x.diagnosis ? `${x.diagnosis.stage ?? x.diagnosis.kind}${x.diagnosis.otherError ? ' + other' : ''}` : '';
      return `| ${x.id} | ${x.mode} | ${diag} | ${ready.length}/${x.slots.length} | ${first ? `${cell(first.label ?? '')}: \`${cell(first.code ?? '')}\`` : '—'} | ${x.mode === 'fix-minimal' ? ready.map((s) => s.changeSize).join(', ') : ''} | ${x.retries.map((y) => y.reason).join(', ')} |`;
    }),
  ];
}
