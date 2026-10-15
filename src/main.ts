import '@strudel/repl/repl-component.mjs';
import { EditorView } from '@codemirror/view';
import { StateEffect } from '@codemirror/state';
import { commitSpec } from './commit';
import { HIHAT_OPTIONS, STARTER_CODE } from './options';
import { isRangeIntact, mapRange, splice, type Capture, type Edit, type Range } from './splice';
import { initialState, transition, type Effect, type Slot, type TrayEvent, type TrayState } from './trayMachine';

// --- Strudel wiring -------------------------------------------------------------------------

const host = document.createElement('strudel-editor') as HTMLElement & { editor: any; settings: any };
host.setAttribute('code', STARTER_CODE);
document.getElementById('editor-wrap')!.append(host);

// connectedCallback creates the StrudelMirror synchronously.
const mirror = host.editor; // StrudelMirror (@strudel/codemirror/codemirror.mjs)
const view: EditorView = mirror.editor; // CodeMirror EditorView
const scheduler = mirror.repl.scheduler; // Cyclist (@strudel/core/cyclist.mjs)

const statusEl = document.getElementById('status')!;
const trayEl = document.getElementById('tray')!;

document.getElementById('play')!.addEventListener('click', () => mirror.evaluate());
document.getElementById('stop')!.addEventListener('click', () => mirror.stop());

// --- Evaluation -------------------------------------------------------------------------------

/**
 * Serialises evaluations and drops any that were superseded while waiting, so rapid key presses
 * can't land out of order. Resolves true if the code evaluated (or was superseded), false on error.
 */
let evalChain: Promise<unknown> = Promise.resolve();
let evalGeneration = 0;
function evaluateCode(code: string, label: string): Promise<boolean> {
  const generation = ++evalGeneration;
  const result = evalChain.then(async () => {
    if (generation !== evalGeneration) return true;
    const before = clockSnapshot();
    // repl.evaluate swallows errors: returns the pattern on success, undefined on failure.
    const pattern = await mirror.repl.evaluate(code);
    logSwap(label, before, clockSnapshot());
    return pattern !== undefined;
  });
  evalChain = result;
  return result;
}

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
  const entry = {
    label,
    started: `${a.started}→${b.started}`,
    cycleBefore: +a.cycle.toFixed(4),
    cycleAfter: +b.cycle.toFixed(4),
    evalMs: +((b.audioTime - a.audioTime) * 1000).toFixed(1),
    // new pattern is first queried from this cycle on; everything before it was already scheduled
    takesEffectAtCycle: +b.queuedUntil.toFixed(4),
    takesEffectInMs: +(((b.queuedUntil - b.cycle) / b.cps) * 1000).toFixed(1),
    anchorKept,
  };
  swapLog.push(entry);
  console.log('[shaper] swap', entry);
}

// --- Highlighting -----------------------------------------------------------------------------

// Uses StrudelMirror.reconfigureExtension rather than updateSettings so nothing is persisted.
const highlightWasEnabled = () => host.settings?.isPatternHighlightingEnabled !== false;
const setHighlight = (on: boolean) => mirror.reconfigureExtension('isPatternHighlightingEnabled', on);

// --- Tray state -------------------------------------------------------------------------------

let state: TrayState = initialState;
let liveRange: Range | null = null; // the captured range, carried through edits made outside it
const failed = new Set<number>();

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
    case 'pauseHighlight':
      setHighlight(false);
      return;
    case 'resumeHighlight':
      // After the original has been re-evaluated, so StrudelMirror.miniLocations match the editor again.
      if (highlightWasEnabled()) setHighlight(true);
      return;
    case 'auditionOption': {
      const option = HIHAT_OPTIONS[effect.slot - 1];
      const code = splice(view.state.doc.toString(), liveRange!, option.code);
      const ok = await evaluateCode(code, `option ${effect.slot}`);
      if (!ok) {
        failed.add(effect.slot);
        await send({ type: 'evalFailed' });
      }
      return;
    }
    case 'evaluateEditor':
      await evaluateCode(mirror.code, 'original');
      return;
    case 'commit': {
      const option = HIHAT_OPTIONS[effect.option - 1];
      view.dispatch(commitSpec(liveRange!, option.code));
      mirror.flash();
      liveRange = null;
      return;
    }
  }
}

function capture() {
  if (state.kind !== 'playing') return;
  const sel = view.state.selection.main;
  if (sel.empty) {
    statusEl.textContent = 'Select some code first, then press ⌘/Ctrl+K.';
    return;
  }
  const buffer = view.state.doc.toString();
  const range = { from: sel.from, to: sel.to };
  const cap: Capture = { range, text: buffer.slice(range.from, range.to), buffer };
  liveRange = range;
  failed.clear();
  send({ type: 'capture', capture: cap });
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

window.addEventListener(
  'keydown',
  (e) => {
    // Capture phase, so CodeMirror's own Ctrl-K (emacs deleteToLineEnd on macOS) never sees it.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      e.stopPropagation();
      capture();
    }
  },
  true,
);

trayEl.addEventListener('keydown', (e) => {
  if (state.kind !== 'tray') return;
  if (/^[0-4]$/.test(e.key)) {
    send({ type: 'audition', slot: Number(e.key) as Slot });
  } else if (e.key === 'Escape') {
    send({ type: 'escape' });
  } else if (e.key === 'Enter') {
    send({ type: 'enter' });
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

function render() {
  if (state.kind !== 'tray') {
    // Check focus before hiding: hiding a focused element moves focus to <body>.
    const hadFocus = trayEl.contains(document.activeElement);
    trayEl.hidden = true;
    if (hadFocus) view.focus();
    return;
  }
  const tray = state;
  trayEl.hidden = false;
  trayEl.classList.toggle('is-stale', tray.stale);
  const cards = [{ label: 'original', code: tray.capture.text }, ...HIHAT_OPTIONS]
    .map((o, slot) => {
      const classes = ['card', slot === tray.heard ? 'heard' : '', failed.has(slot) ? 'failed' : ''].join(' ');
      return `<div class="${classes}" data-slot="${slot}"><b>${slot}</b> ${escapeHtml(o.label)}<code>${escapeHtml(o.code)}</code></div>`;
    })
    .join('');
  const meta = tray.stale
    ? '<span class="stale">Selection changed — options are stale. Playing the original. Esc to close.</span>'
    : '1–4 audition · 0/Esc original · Enter commit · Esc again closes';
  trayEl.innerHTML = `<div class="meta">${meta}</div><div class="cards">${cards}</div>`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// Debug handle for poking at things from the console.
Object.assign(window, { __shaper: { mirror, view, scheduler, swapLog, send, getState: () => state } });
