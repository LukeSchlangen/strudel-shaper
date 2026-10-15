import '@strudel/repl/repl-component.mjs';
import { getAudioContext, soundMap } from '@strudel/webaudio';
import { Pattern, strudelScope } from '@strudel/core';
import { EditorView } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import { captureRange } from './capture';
import { commitSpec } from './commit';
import { diffSegments } from './diff';
import { InstructionBox } from './instructionBox';
import { InstructionHistory } from './instructionHistory';
import { FAULT_KINDS, MockProvider, type FaultKind } from './mockProvider';
import { STARTER_CODE } from './options';
import { reasonLabel, runRequest } from './pipeline';
import type { Mode, OptionRequest, Provider } from './provider';
import { Quantizer } from './quantize';
import { isRangeIntact, mapRange, splice, type Capture, type Edit, type Range } from './splice';
import { initialState, slotCount, transition, type Effect, type Slot, type SlotCard, type TrayEvent, type TrayState } from './trayMachine';
import { Validator, WorkerBackend, type WorkerLike } from './validator';

// --- Strudel wiring -------------------------------------------------------------------------

const host = document.createElement('strudel-editor') as HTMLElement & { editor: any; settings: any };
host.setAttribute('code', STARTER_CODE);
document.getElementById('editor-wrap')!.append(host);

// connectedCallback creates the StrudelMirror synchronously.
const mirror = host.editor; // StrudelMirror (@strudel/codemirror/codemirror.mjs)
const view: EditorView = mirror.editor; // CodeMirror EditorView
const scheduler = mirror.repl.scheduler; // Cyclist (@strudel/core/cyclist.mjs)
const quantizer = new Quantizer(scheduler);

const statusEl = document.getElementById('status')!;
const trayEl = document.getElementById('tray')!;

document.getElementById('play')!.addEventListener('click', () => mirror.evaluate());
document.getElementById('stop')!.addEventListener('click', () => mirror.stop());

let provider: Provider = new MockProvider({ seed: Date.now() >>> 0, ...devMockOptions() });

/**
 * Dev only: `?faultRate=0.5&fault=syntax&retryFails=1&seed=123` turns on the mock's faulty mode.
 * `__shaper.mock` changes faultRate / faultKind / retryFails on the fly.
 */
function devMockOptions() {
  if (!import.meta.env.DEV) return {};
  const q = new URLSearchParams(location.search);
  const fault = q.get('fault') as FaultKind | null;
  if (fault && !FAULT_KINDS.includes(fault)) console.warn(`[shaper] unknown fault kind "${fault}"; one of ${FAULT_KINDS.join(', ')}`);
  return {
    ...(q.has('seed') ? { seed: Number(q.get('seed')) } : {}),
    faultRate: Math.min(1, Math.max(0, Number(q.get('faultRate') ?? 0) || 0)),
    faultKind: fault && FAULT_KINDS.includes(fault) ? fault : undefined,
    retryFails: q.get('retryFails') === '1',
  };
}

// --- Validation -------------------------------------------------------------------------------

// Options are checked in a worker (its own realm: see src/sandbox.ts) before they reach a card.
const backend = new WorkerBackend(
  () => new Worker(new URL('./validator.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
);
const validator = new Validator({
  backend,
  hasSound: (key) => key in soundMap.get(), // read only
  cps: () => scheduler.cps,
});
// The live scope is complete (and soundMap filled) once prebake has run. Names the worker can't load
// (webaudio, draw, codemirror, hydra, soundfonts, midi) become stubs there. Checks wait for this.
Promise.resolve(mirror.prebaked)
  .catch((err: unknown) => console.error('[shaper] prebake failed', err))
  .then(() => {
    const methods = Object.getOwnPropertyNames(Pattern.prototype).filter(
      (name) => typeof Object.getOwnPropertyDescriptor(Pattern.prototype, name)?.value === 'function',
    );
    // Only names live code can actually call: user code resolves against globalThis, and some scope
    // entries never reach it (density, plywith, plyforeach are exported twice inside core, so
    // `export *` drops them). Stubbing those would let the worker accept code the live repl rejects.
    const globals = Object.keys(strudelScope).filter((name) => (globalThis as any)[name] !== undefined);
    backend.init({ globals, methods });
  });

// --- Audio on the first keypress ---------------------------------------------------------------

// superdough's initAudioOnFirstClick only listens for mousedown, so starting with Ctrl+Enter or
// Cmd+K was silent. Resume inside the key gesture, then hand superdough the mousedown it waits for
// so its one-shot initAudio (worklets) still runs exactly once.
function unlockAudio(e: Event) {
  window.removeEventListener('keydown', unlockAudio, true);
  document.removeEventListener('mousedown', unlockAudio, true);
  if (e.type !== 'keydown') return;
  getAudioContext().resume();
  document.dispatchEvent(new MouseEvent('mousedown'));
}
window.addEventListener('keydown', unlockAudio, true);
document.addEventListener('mousedown', unlockAudio, true);

// --- Evaluation -------------------------------------------------------------------------------

/** True during the synchronous start of our own repl.evaluate, when it emits `pending: true`. */
let ownEval = false;

/**
 * Serialises evaluations and drops any that were superseded while waiting, so rapid key presses
 * can't land out of order. Resolves true if the code evaluated (or was superseded), false on error.
 * Our evaluations are quantized (see quantize.ts); outside ones are not.
 */
let evalChain: Promise<unknown> = Promise.resolve();
let evalGeneration = 0;
function evaluateCode(code: string, label: string): Promise<boolean> {
  const generation = ++evalGeneration;
  const result = evalChain.then(async () => {
    if (generation !== evalGeneration) return true;
    const before = clockSnapshot();
    // Note: repl.evaluate also sets repl.state.code (and so isDirty) to this code, which during an
    // audition is the spliced option, not the editor text. Nothing reads them yet; a "dirty"
    // indicator built on them would be wrong while auditioning.
    quantizer.armed = true;
    ownEval = true;
    let evaluation: Promise<unknown>;
    try {
      evaluation = mirror.repl.evaluate(code);
    } finally {
      ownEval = false;
    }
    // repl.evaluate swallows errors: returns the pattern on success, undefined on failure.
    const pattern = await evaluation.finally(() => (quantizer.armed = false));
    logSwap(label, before, clockSnapshot());
    return pattern !== undefined;
  });
  evalChain = result;
  return result;
}

// Outside evaluations (Ctrl/Alt+Enter, the Play button) reset the tray. Signal: the element's
// `update` event. Its detail is the whole repl state, so watch for the `pending` false→true edge,
// which repl.evaluate emits synchronously on entry (repl.mjs:227).
let wasPending = false;
let outsidePending = false;
let wasStarted = false;
host.addEventListener('update', (e) => {
  const st = (e as CustomEvent).detail;
  if (st.pending && !wasPending) outsidePending = !ownEval;
  if (!st.pending && wasPending) {
    // A failed outside eval leaves the old pattern playing, so the tray is still right.
    if (outsidePending && !st.evalError) send({ type: 'externalEval' });
    outsidePending = false;
  }
  if (wasStarted && !st.started) quantizer.settle(true); // stop() resets lastEnd to 0
  wasPending = !!st.pending;
  wasStarted = !!st.started;
});

// --- Timing instrumentation -------------------------------------------------------------------

interface ClockSnapshot {
  audioTime: number;
  cycle: number; // scheduler.now()
  queuedUntil: number; // scheduler.lastEnd: events up to this cycle are already scheduled
  anchorCycle: number;
  anchorSeconds: number;
  cps: number;
  started: boolean;
}

function clockSnapshot(): ClockSnapshot {
  return {
    audioTime: scheduler.getTime(),
    cycle: scheduler.now(),
    queuedUntil: scheduler.lastEnd,
    anchorCycle: scheduler.num_cycles_at_cps_change,
    anchorSeconds: scheduler.seconds_at_cps_change,
    cps: scheduler.cps,
    started: scheduler.started,
  };
}

export const swapLog: Array<Record<string, unknown>> = [];

function logSwap(label: string, a: ClockSnapshot, b: ClockSnapshot) {
  // The scheduler places event onsets at (cycle - anchorCycle) / cps + anchorSeconds.
  // If the anchor and cps are untouched and the clock kept running, the grid didn't move.
  const anchorKept = a.anchorCycle === b.anchorCycle && a.anchorSeconds === b.anchorSeconds && a.cps === b.cps;
  // The new pattern is first heard at the quantized boundary, or from lastEnd when immediate.
  const landsAt = quantizer.pending?.at ?? b.queuedUntil;
  const entry = {
    label,
    swap: quantizer.mode,
    started: `${a.started}→${b.started}`,
    cycleBefore: +a.cycle.toFixed(4),
    cycleAfter: +b.cycle.toFixed(4),
    evalMs: +((b.audioTime - a.audioTime) * 1000).toFixed(1),
    takesEffectAtCycle: +landsAt.toFixed(4),
    takesEffectInMs: +(((landsAt - b.cycle) / b.cps) * 1000).toFixed(1),
    anchorKept,
  };
  swapLog.push(entry);
  console.log('[shaper] swap', entry);
}

// --- Highlighting -----------------------------------------------------------------------------

// Uses StrudelMirror.reconfigureExtension rather than updateSettings so nothing is persisted.
const highlightWasEnabled = () => host.settings?.isPatternHighlightingEnabled !== false;
const setHighlight = (on: boolean) => mirror.reconfigureExtension('isPatternHighlightingEnabled', on);
let pauseGeneration = 0;

async function resumeHighlight() {
  // Wait until the original is actually sounding: before the boundary the option is still playing,
  // and its haps carry locations from the spliced code, not the editor text.
  const generation = pauseGeneration;
  await quantizer.landed();
  if (generation === pauseGeneration && highlightWasEnabled()) setHighlight(true);
}

// --- Tray state -------------------------------------------------------------------------------

let state: TrayState = initialState;
let liveRange: Range | null = null; // the captured range, carried through edits made outside it
let requestSeq = 0;
let controller: AbortController | null = null;
interface Timing {
  requestId: number;
  firstMs?: number; // first card shown (validated)
  lastMs?: number; // last slot settled
  rawFirstMs?: number; // first option from the provider
  rawLastMs?: number;
}
let timing: Timing | null = null;

async function send(event: TrayEvent) {
  const t = transition(state, event);
  state = t.state;
  render();
  for (const effect of t.effects) await run(effect);
  if (state.kind === 'committed') {
    await send({ type: 'commitDone' });
  }
}

async function run(effect: Effect) {
  switch (effect.type) {
    case 'startRequest':
      controller?.abort();
      controller = new AbortController();
      void streamOptions(effect, controller.signal);
      return;
    case 'abortRequest':
      if (controller) console.log('[shaper] request aborted');
      controller?.abort();
      controller = null;
      return;
    case 'pauseHighlight':
      pauseGeneration++;
      setHighlight(false);
      return;
    case 'resumeHighlight':
      // After the original has been re-evaluated, so StrudelMirror.miniLocations match the editor again.
      void resumeHighlight();
      return;
    case 'auditionOption': {
      const code = splice(view.state.doc.toString(), liveRange!, effect.code);
      const ok = await evaluateCode(code, `option ${effect.slot}`);
      if (!ok) await send({ type: 'evalFailed', slot: effect.slot });
      return;
    }
    case 'evaluateEditor':
      await evaluateCode(mirror.code, 'original');
      return;
    case 'commit':
      view.dispatch(commitSpec(liveRange!, effect.code));
      mirror.flash();
      liveRange = null;
      return;
  }
}

async function streamOptions(effect: Extract<Effect, { type: 'startRequest' }>, signal: AbortSignal) {
  const { requestId, mode, instruction, capture } = effect;
  const range = liveRange ?? capture.range;
  const req: OptionRequest = {
    mode,
    buffer: view.state.doc.toString(),
    selection: { ...range, text: capture.text },
    instruction,
    error: mirror.repl.state.evalError?.message,
    cps: scheduler.cps,
  };
  const startedAt = performance.now();
  const times: Timing = (timing = { requestId });
  render();
  await runRequest(
    {
      provider,
      validator,
      getBuffer: () => view.state.doc.toString(),
      getRange: () => liveRange ?? capture.range,
      emit: (event) => {
        const ms = performance.now() - startedAt;
        if (event.type === 'optionArrived') {
          times.rawFirstMs ??= ms;
          times.rawLastMs = ms;
        }
        if (event.type === 'optionValidated') times.firstMs ??= ms;
        if (event.type === 'optionValidated' || event.type === 'optionDropped') times.lastMs = ms;
        if (event.type === 'requestDone') {
          console.log('[shaper] request timing', { ...times, provider: provider.name });
        }
        soakLog?.push(event);
        send(event);
      },
    },
    requestId,
    req,
    slotCount(mode),
    signal,
  );
}

// --- Capture ----------------------------------------------------------------------------------

const history = new InstructionHistory();
const box = new InstructionBox(view, history);

function startCapture(mode: Mode) {
  if (state.kind === 'committed') return;
  const range = captureRange(view.state);
  if (range.from === range.to) {
    statusEl.textContent = 'Nothing to capture here. Select some code or move to a line with code.';
    return;
  }
  const buffer = view.state.doc.toString();
  const cap: Capture = { range, text: buffer.slice(range.from, range.to), buffer };
  // Minimal fix goes straight to the tray; shape and intent rewrite ask for an instruction (empty is fine).
  if (mode === 'fix-minimal') submit(cap, mode, '');
  else box.open(range, (instruction) => submit(cap, mode, instruction));
}

function submit(cap: Capture, mode: Mode, instruction: string) {
  if (!isRangeIntact(view.state.doc.toString(), cap.range, cap.text)) {
    statusEl.textContent = 'The selection changed while the box was open. Press ⌘/Ctrl+K again.';
    return;
  }
  history.add(instruction);
  liveRange = cap.range;
  send({ type: 'request', requestId: ++requestSeq, capture: cap, mode, instruction });
  trayEl.focus();
}

// Stale guard: carry the range through edits elsewhere; any edit inside it makes the options stale.
view.dispatch({
  effects: StateEffect.appendConfig.of(
    EditorView.updateListener.of((update) => {
      if (!update.docChanged || state.kind !== 'tray' || state.stale || !liveRange) return;
      const edits: Edit[] = [];
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) =>
        edits.push({ fromA, toA, insertedLength: inserted.length }),
      );
      const mapped = mapRange(liveRange, edits);
      if (mapped && isRangeIntact(update.state.doc.toString(), mapped, state.capture.text)) {
        liveRange = mapped;
      } else {
        // Defer: dispatching from inside an update listener is not allowed.
        queueMicrotask(() => send({ type: 'stale' }));
      }
    }),
  ),
});

// --- Keys -------------------------------------------------------------------------------------

function toggleSwapTiming() {
  quantizer.cycleMode();
  render();
}

window.addEventListener(
  'keydown',
  (e) => {
    const mod = e.metaKey || e.ctrlKey;
    // Capture phase, so CodeMirror's own Ctrl-K (emacs deleteToLineEnd on macOS) never sees it.
    if (mod && !e.altKey && e.code === 'KeyK') {
      e.preventDefault();
      e.stopPropagation();
      startCapture('shape');
      return;
    }
    if (mod && !e.altKey && e.code === 'KeyJ') {
      e.preventDefault();
      e.stopPropagation();
      startCapture(e.shiftKey ? 'fix-rewrite' : 'fix-minimal');
      return;
    }
    if (box.contains(e.target)) return;
    // Alt+digits work from the editor. e.code, because on macOS Alt+1 types "¡".
    if (e.altKey && !mod && !e.shiftKey) {
      const digit = /^Digit([0-4])$/.exec(e.code);
      if (digit && state.kind === 'tray') {
        e.preventDefault();
        e.stopPropagation();
        send({ type: 'audition', slot: Number(digit[1]) as Slot });
      } else if (e.code === 'KeyT') {
        e.preventDefault();
        e.stopPropagation();
        toggleSwapTiming();
      }
      return;
    }
    // Esc goes back to the original (and then closes) from anywhere, unless CodeMirror has a popup open.
    if (e.key === 'Escape' && !mod && state.kind === 'tray' && !document.querySelector('.cm-tooltip-autocomplete')) {
      e.preventDefault();
      e.stopPropagation();
      send({ type: 'escape' });
    }
  },
  true,
);

trayEl.addEventListener('keydown', (e) => {
  if (state.kind !== 'tray' || e.metaKey || e.ctrlKey || e.altKey) return; // leave Cmd+R etc. to the browser
  if (/^[0-4]$/.test(e.key)) {
    send({ type: 'audition', slot: Number(e.key) as Slot });
  } else if (e.key === 'Enter') {
    send({ type: 'enter' });
  } else if (e.key === 'r' || e.key === 'R') {
    send({ type: 'regenerate', requestId: ++requestSeq });
  } else if (e.key === 't' || e.key === 'T') {
    toggleSwapTiming();
  } else {
    return;
  }
  e.preventDefault();
});

trayEl.addEventListener('click', (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>('[data-slot]');
  if (card) send({ type: 'audition', slot: Number(card.dataset.slot) as Slot });
  trayEl.focus();
});

// --- Render -----------------------------------------------------------------------------------

const KEYS_HINT = '⌘/Ctrl+K shape · ⌘/Ctrl+J fix · ⌘/Ctrl+⇧J rewrite';

function render() {
  const swap = `swap: ${quantizer.mode} (T)`;
  if (state.kind !== 'tray') {
    statusEl.textContent = `${KEYS_HINT} · ${swap.replace('(T)', '(Alt+T)')}`;
    // Check focus before hiding: hiding a focused element moves focus to <body>.
    const hadFocus = trayEl.contains(document.activeElement);
    trayEl.hidden = true;
    if (hadFocus) view.focus();
    return;
  }
  const tray = state;
  trayEl.hidden = false;
  trayEl.classList.toggle('is-stale', tray.stale);

  const original = card(0, ['original', tray.heard === 0 ? 'heard' : ''], 'original', codeHtml(tray.capture.text));
  const options = tray.slots.map((s, i) => slotCard(i + 1, s, tray.heard, tray.capture.text));

  const times = timing?.requestId === tray.requestId ? timing : null; // never show the previous request's times
  const ms = (v?: number) => (v === undefined ? '…' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`);
  const count = (pred: (s: SlotCard) => boolean) => tray.slots.filter(pred).length;
  const checked = tray.validationMs.filter((v) => v > 0); // identical/duplicate never reach the evaluator
  const status = [
    `provider: ${providerLabel()}`,
    `first ${ms(times?.firstMs)}`,
    `last ${tray.done ? ms(times?.lastMs) : '…'}`,
    `${count((s) => s.status === 'ready')} ok · ${count((s) => !!s.retried)} retried · ${count((s) => s.status === 'dropped')} dropped`,
    checked.length
      ? `validation ${(checked.reduce((a, b) => a + b, 0) / checked.length).toFixed(1)} ms avg / ${Math.max(...checked).toFixed(1)} ms max`
      : 'validation …',
    tray.heard === 0 ? 'audition: off (original)' : `audition: on (option ${tray.heard})`,
    swap,
  ].join(' · ');
  const hint = tray.stale
    ? '<span class="stale">Selection changed — options are stale. Playing the original. Esc to close.</span>'
    : '1–4 audition (Alt+1–4 from the editor) · 0/Esc original · Enter commit · R regenerate · Esc again closes';
  const error = tray.error ? ` · <span class="stale">${escapeHtml(tray.error)}</span>` : '';
  trayEl.innerHTML = `<div class="meta">${escapeHtml(status)}${error}</div><div class="meta">${hint}</div><div class="cards">${original}${options.join('')}</div>`;
  statusEl.textContent = `${KEYS_HINT} · ${swap.replace('(T)', '(Alt+T)')}`;
}

function providerLabel() {
  if (!(provider instanceof MockProvider) || provider.faultRate === 0) return provider.name;
  return `${provider.name} (faults ${Math.round(provider.faultRate * 100)}%${provider.faultKind ? ` ${provider.faultKind}` : ''}${provider.retryFails ? ', retries fail' : ''})`;
}

const placeholder = (text: string) => `<span class="placeholder">${escapeHtml(text)}</span>`;

function slotCard(slot: number, s: SlotCard, heard: Slot, original: string) {
  const classes = [s.status, slot === heard ? 'heard' : ''];
  const why = s.drop ? reasonLabel(s.drop.reason, s.drop.message) : '';
  switch (s.status) {
    case 'pending':
      return card(slot, classes, '…', placeholder('waiting for option'));
    case 'validating':
      return card(slot, classes, s.retried ? 'replacement' : '…', placeholder('validating…'), { title: s.drop?.message });
    case 'retrying':
      return card(slot, classes, '…', placeholder(`retrying… (${why})`), { title: s.drop?.message });
    case 'dropped':
      return card(slot, classes, 'dropped', placeholder(`dropped: ${why}`), { title: s.drop?.message });
    case 'empty':
      return card(slot, classes, '—', placeholder('no option'));
    case 'ready':
    case 'failed': {
      const label = s.status === 'failed' ? `${s.option!.label} (failed)` : s.option!.label;
      const badges = (s.warnings ?? []).map((w) => (w === 'empty' ? 'empty' : `unknown sample: ${(s.unknownSounds ?? []).join(', ')}`));
      if (s.retried) badges.push('retried');
      const title = s.retried && s.drop ? `Replaces an option dropped for ${why}: ${s.drop.message}` : undefined;
      return card(slot, classes, label, diffHtml(original, s.option!.code), { badges, title });
    }
  }
}

function card(slot: number, classes: string[], label: string, body: string, extra: { title?: string; badges?: string[] } = {}) {
  const title = extra.title ? ` title="${escapeHtml(extra.title)}"` : '';
  const badges = (extra.badges ?? []).map((b) => `<span class="badge${b === 'retried' ? ' info' : ''}">${escapeHtml(b)}</span>`).join('');
  return `<div class="card ${classes.join(' ')}" data-slot="${slot}"${title}><b>${slot}</b> ${escapeHtml(label)}${badges}<code>${body}</code></div>`;
}

function diffHtml(before: string, after: string) {
  return diffSegments(before, after)
    .map(({ kind, text }) => (kind === 'same' ? codeHtml(text) : `<${kind}>${codeHtml(text)}</${kind}>`))
    .join('');
}

/** Escaped code with line-break opportunities before each `.method`, so narrow cards wrap at calls, not mid-token. */
function codeHtml(code: string) {
  return escapeHtml(code).replace(/\.(?=[A-Za-z_$])/g, '<wbr>.');
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

render();

// --- Measurement ------------------------------------------------------------------------------

/**
 * Presses random ready slots (and 0) at random gaps while tapping the scheduler's own queries, then
 * checks every onset that played against what the sequence of swaps should have produced.
 * Run from the console with the tray open and options ready: `await __shaper.measure(12)`.
 * `{ validate: true }` validates 4 options per batch in the background, back to back, the whole time
 * (every other batch in a buffer with setcps(1)), and checks the live session is untouched.
 * `measure(0, { validate: true, holdMs: 20000 })` measures validation alone; the tray needn't be open.
 */
async function measure(
  swaps = 12,
  { minGapMs = 300, maxGapMs = 900, validate = false, holdMs = 2500 }: { minGapMs?: number; maxGapMs?: number; validate?: boolean; holdMs?: number } = {},
) {
  if (!scheduler.started) throw new Error('Press Play first.');
  if (swaps > 0 && state.kind !== 'tray') throw new Error('Open the tray and wait for options.');
  const before = liveSnapshot();
  const loadController = new AbortController();
  const load = validate ? validationLoad(loadController.signal) : null;
  type Onset = { cycle: number; key: string; s: string };
  const played: Onset[] = [];
  const toOnsets = (haps: any[]): Onset[] =>
    haps
      .filter((h) => h.hasOnset())
      .map((h) => ({ cycle: h.whole.begin.valueOf(), s: String(h.value?.s), key: `${h.whole.begin.valueOf().toFixed(6)} ${JSON.stringify(h.value)}` }));
  let windowStart: number | null = null;
  let windowEnd = 0;

  const queryArc = Pattern.prototype.queryArc;
  Pattern.prototype.queryArc = function (begin: number, end: number, controls: any = {}) {
    const haps = queryArc.call(this, begin, end, controls);
    if (controls?.cyclist === 'cyclist') {
      windowStart ??= begin;
      windowEnd = end;
      played.push(...toOnsets(haps));
    }
    return haps;
  };
  const segments: Array<{ at: number; pattern: any; label: string; pressCycle: number }> = [];
  const initial = scheduler.pattern;
  const setPattern = scheduler.setPattern;
  let label = '';
  scheduler.setPattern = (p: any, autostart?: boolean) => {
    const r = setPattern(p, autostart);
    const pending = quantizer.pending;
    segments.push({ at: pending?.at ?? scheduler.lastEnd, pattern: pending?.next ?? p, label, pressCycle: scheduler.now() });
    return r;
  };

  try {
    const rand = Math.random;
    for (let i = 0; i < swaps; i++) {
      await new Promise((r) => setTimeout(r, minGapMs + rand() * (maxGapMs - minGapMs)));
      if (state.kind !== 'tray') break;
      const tray = state;
      const ready = tray.slots.flatMap((s, j) => (s.status === 'ready' ? [j + 1] : []));
      const choices = [0, ...ready].filter((slot) => slot !== tray.heard);
      const slot = choices[Math.floor(rand() * choices.length)] as Slot;
      label = `key ${slot}`;
      await send({ type: 'audition', slot });
    }
    await new Promise((r) => setTimeout(r, holdMs)); // let the last swap land and play a while
  } finally {
    loadController.abort();
    Pattern.prototype.queryArc = queryArc;
    scheduler.setPattern = setPattern;
  }
  const validation = load ? await load : null;
  const isolation = compareSnapshots(before, liveSnapshot(), swaps === 0);

  // Later presses before the same boundary replace earlier ones: keep the last per boundary.
  const landed = segments.filter((s, i) => segments[i + 1]?.at !== s.at);
  const start = windowStart!;
  const end = windowEnd;
  const expected: Onset[] = [];
  const pieces = [{ at: -Infinity, pattern: initial }, ...landed];
  pieces.forEach((piece, i) => {
    const from = Math.max(piece.at, start);
    const to = Math.min(pieces[i + 1]?.at ?? Infinity, end);
    if (to > from) expected.push(...toOnsets(queryArc.call(piece.pattern, from, to, {})));
  });
  const count = (list: Onset[]) => list.reduce((m, o) => m.set(o.key, (m.get(o.key) ?? 0) + 1), new Map<string, number>());
  const want = count(expected);
  const got = count(played);
  const missing = [...want].filter(([k, n]) => (got.get(k) ?? 0) < n).map(([k]) => k);
  const extra = [...got].filter(([k, n]) => (want.get(k) ?? 0) < n).map(([k]) => k);
  const kicks = played.filter((o) => o.s === 'bd').map((o) => o.cycle).sort((a, b) => a - b);
  const kickGapsSec = [...new Set(kicks.slice(1).map((k, i) => +((k - kicks[i]) / scheduler.cps).toFixed(6)))];

  const table = segments.map((s) => ({
    key: s.label,
    swap: quantizer.mode,
    pressCycle: +s.pressCycle.toFixed(4),
    landsAt: +s.at.toFixed(4),
    onBeat: Number.isInteger(+(s.at * quantizer.beatsPerCycle).toFixed(9)),
    msUntilAudible: +(((s.at - s.pressCycle) / scheduler.cps) * 1000).toFixed(0),
    landed: landed.includes(s),
  }));
  console.table(table);
  const summary = {
    swaps: segments.length,
    landed: landed.length,
    window: [+start.toFixed(3), +end.toFixed(3)],
    onsetsPlayed: played.length,
    onsetsExpected: expected.length,
    missing: missing.length,
    extra: extra.length,
    kicks: kicks.length,
    kickGapsSec,
    ...(validation ? { validation } : {}),
    isolation,
  };
  console.log('[shaper] measure', summary);
  return { table, summary, missing, extra };
}

// --- Validation harnesses ----------------------------------------------------------------------

const LINES = ['s("bd*4")', 's("hh*8").gain(0.6)', 'note("c2 [~ c2] eb2 g1").s("sawtooth").lpf(800)'];

/** What validation must never change. */
function liveSnapshot() {
  const sounds = Object.keys(soundMap.get()).sort().join('|');
  let hash = 0;
  for (let i = 0; i < sounds.length; i++) hash = (Math.imul(hash, 31) + sounds.charCodeAt(i)) | 0;
  return {
    cps: scheduler.cps,
    anchorCycle: scheduler.num_cycles_at_cps_change,
    anchorSeconds: scheduler.seconds_at_cps_change,
    pattern: scheduler.pattern,
    editor: view.state.doc.toString(),
    soundCount: Object.keys(soundMap.get()).length,
    soundHash: hash,
    protoKeys: Object.getOwnPropertyNames(Pattern.prototype).length,
    setcps: (globalThis as any).setcps,
  };
}

function compareSnapshots(a: ReturnType<typeof liveSnapshot>, b: ReturnType<typeof liveSnapshot>, comparePattern: boolean) {
  return {
    cps: `${a.cps} → ${b.cps}`,
    anchorKept: a.anchorCycle === b.anchorCycle && a.anchorSeconds === b.anchorSeconds,
    ...(comparePattern ? { patternKept: a.pattern === b.pattern } : {}),
    editorKept: a.editor === b.editor,
    soundMapKept: a.soundCount === b.soundCount && a.soundHash === b.soundHash,
    sounds: b.soundCount,
    prototypeKept: a.protoKeys === b.protoKeys,
    liveSetcpsKept: a.setcps === b.setcps,
  };
}

/** Validates batches of 4 faulty-mock options against the current buffer, back to back, until aborted. */
async function validationLoad(signal: AbortSignal) {
  const mock = new MockProvider({ seed: 1, minDelayMs: 0, maxDelayMs: 0, faultRate: 0.5 });
  const times: number[] = [];
  let batches = 0;
  let setcps1Batches = 0;
  while (!signal.aborted) {
    let buffer = view.state.doc.toString();
    if (batches % 2) {
      buffer = buffer.replace(/setcps\([^)]*\)/, 'setcps(1)');
      if (buffer.includes('setcps(1)')) setcps1Batches++;
    }
    const text = LINES[batches % LINES.length];
    batches++;
    const from = buffer.indexOf(text);
    if (from < 0) {
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    const range = { from, to: from + text.length };
    const req: OptionRequest = { mode: 'shape', buffer, selection: { ...range, text }, instruction: '', cps: scheduler.cps };
    const accepted = [];
    for await (const option of mock.generateOptions(req, signal)) {
      const r = await validator.validate(buffer, range, option, accepted);
      if (r.ms > 0) times.push(r.ms);
      if (r.ok) accepted.push(option);
    }
  }
  const sorted = [...times].sort((x, y) => x - y);
  const round = (v: number) => +v.toFixed(2);
  return {
    batches,
    setcps1Batches,
    checks: times.length,
    msAvg: round(times.reduce((x, y) => x + y, 0) / (times.length || 1)),
    msP95: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    msMax: round(sorted.at(-1) ?? 0),
    timeouts: backend.respawns,
  };
}

/** The open tray's slots (a function, so TypeScript doesn't keep `state` narrowed across awaits). */
const traySlots = (): SlotCard[] => (state.kind === 'tray' ? state.slots : []);

/** Pipeline events seen while a soak runs. */
let soakLog: TrayEvent[] | null = null;

const waitFor = async (cond: () => boolean, timeoutMs = 15000) => {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeoutMs) throw new Error('soak: timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/**
 * Exit-criteria run: `await __shaper.soak({ requests: 30, faultRate: 0.5 })`. Requests options for the
 * kick, hi-hat and bass lines in turn through the real tray, auditions every card that appears
 * through the live repl, and reports how each injected fault was handled. Needs Play.
 */
async function soak({ requests = 30, faultRate = 0.5, retryFails = false, seed = 1 } = {}) {
  if (!scheduler.started) throw new Error('Press Play first.');
  const mock = new MockProvider({ seed, faultRate, retryFails, minDelayMs: 50, maxDelayMs: 200 });
  const savedProvider = provider;
  const savedMode = quantizer.mode;
  provider = mock;
  quantizer.mode = 'immediate'; // auditions don't need to wait for the beat here
  soakLog = [];
  let auditions = 0;
  let failedCards = 0;
  try {
    for (let i = 0; i < requests; i++) {
      while (state.kind === 'tray') await send({ type: 'escape' });
      const doc = view.state.doc.toString();
      const text = LINES[i % LINES.length];
      const from = doc.indexOf(text);
      if (from < 0) throw new Error(`soak: "${text}" is not in the editor`);
      const cap: Capture = { range: { from, to: from + text.length }, text, buffer: doc };
      liveRange = cap.range;
      const requestId = ++requestSeq;
      await send({ type: 'request', requestId, capture: cap, mode: 'shape', instruction: '' });
      await waitFor(() => state.kind === 'tray' && state.requestId === requestId && state.done);
      const ready = traySlots().flatMap((s, j) => (s.status === 'ready' ? [j + 1] : []));
      for (const slot of ready) {
        await send({ type: 'audition', slot: slot as Slot });
        auditions++;
      }
      failedCards += traySlots().filter((s) => s.status === 'failed').length;
    }
    while (state.kind === 'tray') await send({ type: 'escape' });
  } finally {
    provider = savedProvider;
    quantizer.mode = savedMode;
  }
  const log = soakLog;
  soakLog = null;

  // Follow each option through its events: what happened to it, and to its replacement.
  const optionAt = new Map<string, string>(); // `${requestId}:${slot}` → option id currently in that slot
  const outcome = new Map<string, string>(); // option id → outcome
  const replacementOf = new Map<string, string>(); // failed option id → its replacement's id
  for (const e of log) {
    if (!('slot' in e) || !('requestId' in e)) continue;
    const key = `${e.requestId}:${e.slot}`;
    if (e.type === 'optionArrived') {
      const previous = optionAt.get(key);
      if (previous && outcome.get(previous)?.startsWith('retried')) replacementOf.set(previous, e.option.id);
      optionAt.set(key, e.option.id);
      continue;
    }
    const id = optionAt.get(key)!;
    if (e.type === 'optionValidated') outcome.set(id, e.warnings.length ? `warned (${e.warnings.join(', ')})` : 'accepted');
    if (e.type === 'optionRetrying') outcome.set(id, `retried after ${reasonLabel(e.reason, e.message)}`);
    if (e.type === 'optionDropped') outcome.set(id, `dropped for good: ${reasonLabel(e.reason, e.message)}`);
  }
  const byKind: Record<string, Record<string, number>> = {};
  for (const f of mock.faultLog) {
    let result = outcome.get(f.optionId) ?? 'not reached (aborted)';
    const replacement = replacementOf.get(f.optionId);
    if (replacement) result += ` → replacement ${outcome.get(replacement) ?? '?'}`;
    byKind[f.kind] ??= {};
    byKind[f.kind][result] = (byKind[f.kind][result] ?? 0) + 1;
  }
  const hard = new Set(['syntax', 'unknown-function', 'runtime']);
  const hardFaultsAccepted = mock.faultLog.filter((f) => hard.has(f.kind) && outcome.get(f.optionId)?.match(/^(accepted|warned)/)).length;
  const summary = {
    requests,
    faultRate,
    retryFails,
    options: log.filter((e) => e.type === 'optionArrived').length,
    faults: mock.faultLog.length,
    kindsSeen: Object.keys(byKind).length,
    auditions,
    failedCards,
    hardFaultsAccepted,
  };
  console.log('[shaper] soak', summary);
  console.table(Object.entries(byKind).flatMap(([kind, results]) => Object.entries(results).map(([result, n]) => ({ kind, result, n }))));
  return { summary, byKind };
}

// Debug handle for poking at things from the console.
Object.assign(window, {
  __shaper: {
    mirror,
    view,
    scheduler,
    quantizer,
    swapLog,
    send,
    measure,
    soak,
    validator,
    backend,
    get mock() {
      return provider instanceof MockProvider ? provider : null;
    },
    getState: () => state,
    audioContext: () => getAudioContext(),
    get provider() {
      return provider;
    },
    set provider(p: Provider) {
      provider = p;
    },
  },
});
