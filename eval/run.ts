/**
 * The eval harness: every fixture request through the real provider and the real validator.
 *
 *   npm run eval -- --provider claude --model claude-haiku-5-5 [--mode shape|fix] [--effort low|medium|high]
 *                   [--thinking off|adaptive] [--strategy single|parallel] [--warmup]
 *                   [--only drums-kick,bass-darker] [--label name] [--schema-key k]
 *
 * The provider is the browser's RemoteProvider, wired straight to the proxy app (app.request, no
 * network or rate limit), so options take exactly the browser's path: NDJSON lines → runRequest →
 * Validator → a sandbox in a worker_threads worker (WorkerBackend, with its 250 ms pre-emption).
 * `--mode fix` runs the ⌘J / ⌘⇧J fixtures: each request is built by diagnoseFix (the browser's own
 * code) from the fixture's selection or cursor, and validated with the fix rules.
 * Writes eval/reports/<stamp>-<label>.json (for eval/listen.html) and a .md summary next to it.
 * Requests run one after another so their timings don't interfere.
 */
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { ensureSyntaxTree } from '@codemirror/language';
import { diagnoseFix, noRequestReason, trayFix, type TrayFix } from '../src/fixTarget';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { createApp } from '../server/app';
import { RateLimiter } from '../server/rateLimit';
import { runRequest, type RequestStats } from '../src/pipeline';
import type { OptionRequest } from '../src/provider';
import type { Effort, Strategy, ThinkingSetting } from '../src/remoteProtocol';
import { RemoteProvider } from '../src/remoteProvider';
import { summariseSounds, COMMON_DRUMS } from '../src/soundSummary';
import type { TrayEvent } from '../src/trayMachine';
import { Validator, WorkerBackend, type WorkerLike, type WorkerRequest, type WorkerResponse } from '../src/validator';
import { isFixMode, loadFixtures, type Fixture } from './fixtures';
import { summarise, type Report, type RequestResult, type SlotResult } from './summary';

const root = new URL('..', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

function parseArgs(args: string[]) {
  const get = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
  };
  const model = get('model') ?? 'claude-haiku-5-5';
  const provider = get('provider') ?? (model.startsWith('gemini') ? 'gemini' : 'claude');
  return {
    provider,
    model,
    mode: (get('mode') ?? 'shape') as 'shape' | 'fix',
    effort: get('effort') as Effort | undefined,
    thinking: get('thinking') as ThinkingSetting | undefined,
    strategy: get('strategy') as Strategy | undefined,
    warmup: args.includes('--warmup'),
    only: get('only')?.split(','),
    label: get('label'),
    schemaKey: get('schema-key'),
  };
}

/** A worker_threads worker behind the WorkerLike interface WorkerBackend expects. */
function nodeWorker(): WorkerLike {
  const w = new Worker(new URL('./sandboxWorker.mjs', import.meta.url));
  const like: WorkerLike = {
    onmessage: null,
    postMessage: (m: WorkerRequest) => w.postMessage(m),
    terminate: () => void w.terminate(),
  };
  w.on('message', (data: WorkerResponse) => like.onmessage?.({ data }));
  w.on('error', (err) => console.error('[eval] sandbox worker failed', err));
  return like;
}

export async function main(argv: string[]) {
  const opts = parseArgs(argv);
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const geminiApiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)?.trim();
  if (opts.provider === 'claude' && !anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is not set (put it in .env).');
  if (opts.provider === 'gemini' && !geminiApiKey) throw new Error('GEMINI_API_KEY is not set (put it in .env).');
  if (opts.provider !== 'claude' && opts.provider !== 'gemini') throw new Error(`Unknown provider "${opts.provider}".`);

  const scope = JSON.parse(read('src/generated/scope.json'));
  const soundList = JSON.parse(read('src/generated/sounds.json')) as string[];
  const soundSet = new Set(soundList);
  const sounds = summariseSounds(soundList);
  const reference = read('src/generated/strudel-reference.md');

  const backend = new WorkerBackend(nodeWorker);
  backend.init(scope);
  const validator = new Validator({ backend, hasSound: (k) => soundSet.has(k), cps: () => cps });
  let cps = 0.5;

  const app = createApp({
    claude: anthropicApiKey ? { client: new Anthropic({ apiKey: anthropicApiKey, maxRetries: 1 }), reference, maxTokens: 2048, schemaKey: opts.schemaKey } : null,
    gemini: geminiApiKey ? { client: new GoogleGenAI({ apiKey: geminiApiKey }), reference, maxTokens: 2048 } : null,
    limiter: new RateLimiter(10_000),
    log: () => {},
  });
  const appFetch = ((url: string, init: RequestInit) => app.request(url, init)) as unknown as typeof fetch;
  const settings = { effort: opts.effort, thinking: opts.thinking, strategy: opts.strategy };
  const provider = new RemoteProvider({ provider: opts.provider, model: opts.model, fetch: appFetch, sounds: () => sounds, settings: () => settings });

  const label = opts.label ?? [opts.mode === 'fix' ? 'fix' : '', opts.model.replace(/^(claude|gemini)-/, ''), opts.thinking ?? 'default', opts.effort ?? 'default', opts.strategy ?? 'single', opts.warmup ? 'warm' : ''].filter(Boolean).join('-');
  console.log(`[eval] ${label}`);

  let warmupMs: number | undefined;
  if (opts.warmup) {
    const t = performance.now();
    const res = await app.request('/api/warmup', { method: 'POST', body: JSON.stringify({ model: opts.model, sounds, ...settings }) });
    warmupMs = performance.now() - t;
    console.log(`[eval] warm-up ${Math.round(warmupMs)} ms`, await res.json());
  }

  const fixtures = loadFixtures().filter((f) => (opts.mode === 'fix') === isFixMode(f.mode) && (!opts.only || opts.only.includes(f.id)));
  const results: RequestResult[] = [];
  for (const [i, f] of fixtures.entries()) {
    cps = Number(/setcps\(([\d.]+)\)/.exec(f.buffer)?.[1] ?? 0.5);
    const result = await runOne(f, provider, validator, cps);
    results.push(result);
    const ok = result.slots.filter((s) => s.status === 'ready').length;
    console.log(
      `[eval] ${String(i + 1).padStart(2)}/${fixtures.length} ${f.id.padEnd(24)} first ${fmt(result.firstCardMs)} last ${fmt(result.lastSettledMs)} ` +
        `${ok}/${result.slots.length} ready · ${result.retries.length} retried · ${result.drops.length} dropped${result.error ? ` · ERROR ${result.error}` : ''}`,
    );
  }

  const report: Report = {
    label,
    createdAt: new Date().toISOString(),
    config: { ...opts, sounds: undefined, warmupMs },
    soundsTokens: Math.round(sounds.length / 4),
    referenceTokens: Math.round(reference.length / 4),
    results,
  };
  const dir = new URL('eval/reports/', root);
  mkdirSync(dir, { recursive: true });
  const stamp = report.createdAt.replace(/[:.]/g, '-').slice(0, 19);
  const base = `${stamp}-${label}`;
  writeFileSync(new URL(`${base}.json`, dir), JSON.stringify(report, null, 1));
  const md = summarise(report);
  writeFileSync(new URL(`${base}.md`, dir), md);
  console.log(`\n${md}\n[eval] wrote eval/reports/${base}.json and .md`);
  backend.dispose();
}

const fmt = (ms?: number) => (ms === undefined ? '   —  ' : `${(ms / 1000).toFixed(2)} s`);

async function runOne(f: Fixture, provider: RemoteProvider, validator: Validator, cps: number): Promise<RequestResult> {
  const events: Array<{ t: number; event: TrayEvent }> = [];
  const start = performance.now();
  const slotCount = f.mode === 'fix-minimal' ? 2 : 4;

  // Fix modes: find what to fix exactly as the browser does (from the selection, or the cursor).
  let range = f.selection && { from: f.selection.from, to: f.selection.to };
  let fix: TrayFix | undefined;
  let diagnosis: RequestResult['diagnosis'];
  if (isFixMode(f.mode)) {
    const state = EditorState.create({ doc: f.buffer, selection: { anchor: f.cursor }, extensions: javascript() });
    ensureSyntaxTree(state, f.buffer.length, 5000);
    const d = await diagnoseFix({ state, selection: range, validator });
    diagnosis = { kind: d.kind, ...('error' in d ? { stage: d.error.stage, message: d.error.message, line: d.error.line } : {}), otherError: d.kind === 'broken' && !!d.otherErrors };
    const reason = noRequestReason(d, f.mode);
    if (reason) return { ...emptyResult(f, start, slotCount), diagnosis, error: `no request: ${reason}` };
    range = d.range;
    fix = trayFix(d);
  }
  const selection = { ...range!, text: f.buffer.slice(range!.from, range!.to) };
  const req: OptionRequest = {
    mode: f.mode,
    buffer: f.buffer,
    selection,
    instruction: f.instruction,
    cps,
    ...(fix?.error ? { error: fix.error } : {}),
    ...(fix?.errorAt ? { errorAt: fix.errorAt } : {}),
  };
  await runRequest(
    {
      provider,
      validator,
      getBuffer: () => f.buffer,
      getRange: () => range!,
      emit: (event) => events.push({ t: performance.now() - start, event }),
      soundHint: () => COMMON_DRUMS.slice(0, 8).join(' '),
    },
    1,
    req,
    slotCount,
    new AbortController().signal,
    fix?.context,
  );

  const slots: SlotResult[] = Array.from({ length: slotCount }, () => ({ status: 'empty', attempts: [] }));
  const retries: RequestResult['retries'] = [];
  const drops: RequestResult['drops'] = [];
  let firstArrivalMs: number | undefined;
  let firstCardMs: number | undefined;
  let lastSettledMs: number | undefined;
  let stats: RequestStats | undefined;
  let error: string | undefined;
  let bufferError: string | undefined;
  for (const { t, event: e } of events) {
    if (e.type === 'bufferChecked') bufferError = e.error;
    if (e.type === 'requestDone') {
      stats = e.stats;
      error = e.error;
    }
    if (!('slot' in e)) continue;
    const slot = slots[e.slot - 1];
    if (e.type === 'optionArrived') {
      firstArrivalMs ??= t;
      slot.attempts.push({ label: e.option.label, code: e.option.code, arrivedMs: t });
      slot.status = 'validating';
    } else if (e.type === 'optionValidated') {
      firstCardMs ??= t;
      lastSettledMs = t;
      Object.assign(slot, {
        status: 'ready',
        label: e.option.label,
        code: e.option.code,
        warnings: e.warnings,
        unknownSounds: e.unknownSounds,
        checkedAlone: e.checkedAlone,
        changeSize: e.changeSize,
        retried: slot.attempts.length > 1,
      });
    } else if (e.type === 'optionRetrying') {
      retries.push({ slot: e.slot, reason: e.reason, message: e.message, code: slot.attempts.at(-1)?.code });
      slot.attempts.at(-1)!.outcome = `retried: ${e.reason}`;
    } else if (e.type === 'optionDropped') {
      lastSettledMs = t;
      drops.push({ slot: e.slot, reason: e.reason, message: e.message, code: slot.attempts.at(-1)?.code });
      Object.assign(slot, { status: 'dropped', drop: { reason: e.reason, message: e.message } });
    }
  }
  return {
    id: f.id,
    bufferId: f.bufferId,
    buffer: f.buffer,
    mode: f.mode,
    selection,
    instruction: f.instruction,
    ...(diagnosis ? { diagnosis, originalBroken: fix?.broken } : {}),
    firstArrivalMs,
    firstCardMs,
    lastSettledMs,
    totalMs: performance.now() - start,
    stats,
    error,
    bufferError,
    retries,
    drops,
    slots,
  };
}

/** A fix request that sent nothing (the diagnosis said there was nothing to fix, or couldn't place the error). */
function emptyResult(f: Fixture, start: number, slotCount: number): RequestResult {
  const at = f.selection ?? { from: f.cursor, to: f.cursor, text: '' };
  return {
    id: f.id,
    bufferId: f.bufferId,
    buffer: f.buffer,
    mode: f.mode,
    selection: at,
    instruction: f.instruction,
    totalMs: performance.now() - start,
    retries: [],
    drops: [],
    slots: Array.from({ length: slotCount }, () => ({ status: 'empty' as const, attempts: [] })),
  };
}
