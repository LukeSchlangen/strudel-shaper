import type { RetryReason } from './feedback';
import type { TrayFix } from './fixTarget';
import type { RequestStats } from './pipeline';
import type { Mode, Option } from './provider';
import type { Capture } from './splice';
import type { Warning } from './validator';

/** 0 is the original (the editor's real text); 1–4 are the option cards. */
export type Slot = 0 | 1 | 2 | 3 | 4;

/** 1–4: the option cards. */
export type OptionSlot = Exclude<Slot, 0>;

/**
 * pending: nothing yet · validating: raw option arrived, being checked · retrying: dropped once,
 * waiting for the replacement · ready: passed, can be auditioned · dropped: failed for good ·
 * failed: passed validation but the live evaluation failed (backstop) · empty: the provider sent nothing.
 */
export type SlotStatus = 'pending' | 'validating' | 'retrying' | 'ready' | 'dropped' | 'failed' | 'empty';

export interface SlotCard {
  status: SlotStatus;
  option?: Option;
  warnings?: Warning[];
  unknownSounds?: string[];
  /** Passed only when checked on its own, because the buffer itself fails. */
  checkedAlone?: boolean;
  /** Fix modes: characters changed against the selection. */
  changeSize?: number;
  /** A replacement was asked for. */
  retried?: boolean;
  /** Why the slot was (last) dropped or retried. */
  drop?: { reason: RetryReason; message: string };
}

export interface TrayRequest {
  capture: Capture;
  mode: Mode;
  instruction: string;
  /** Fix modes: what was diagnosed (src/fixTarget.ts). */
  fix?: TrayFix;
}

export interface Tray extends TrayRequest {
  kind: 'tray';
  requestId: number;
  slots: SlotCard[]; // slots[i] is card i + 1
  done: boolean; // the provider has finished (or was aborted)
  error?: string;
  /** The unmodified buffer's own error, from the request's baseline check. */
  bufferError?: string;
  /** Provider usage for this request (all calls), when the provider reports it. */
  stats?: RequestStats;
  heard: Slot;
  stale: boolean;
  /** Time each validation took, for the status line. */
  validationMs: number[];
}

export type TrayState =
  | { kind: 'playing' }
  | Tray
  | { kind: 'committed'; capture: Capture; option: Option };

export type TrayEvent =
  // requestId comes from the caller so ids stay unique across trays.
  | ({ type: 'request'; requestId: number } & TrayRequest)
  | { type: 'regenerate'; requestId: number }
  | { type: 'optionArrived'; requestId: number; slot: OptionSlot; option: Option }
  | {
      type: 'optionValidated';
      requestId: number;
      slot: OptionSlot;
      option: Option;
      warnings: Warning[];
      unknownSounds?: string[];
      checkedAlone?: boolean;
      changeSize?: number;
      ms: number;
    }
  | { type: 'optionRetrying'; requestId: number; slot: OptionSlot; reason: RetryReason; message: string; ms: number }
  | { type: 'optionDropped'; requestId: number; slot: OptionSlot; reason: RetryReason; message: string; ms: number }
  | { type: 'bufferChecked'; requestId: number; error?: string }
  | { type: 'requestDone'; requestId: number; error?: string; stats?: RequestStats }
  | { type: 'audition'; slot: Slot }
  | { type: 'escape' }
  | { type: 'enter' }
  | { type: 'stale' }
  | { type: 'evalFailed'; slot: Slot }
  | { type: 'externalEval' }
  | { type: 'commitDone' };

export type Effect =
  | ({ type: 'startRequest'; requestId: number } & TrayRequest)
  | { type: 'abortRequest' }
  | { type: 'pauseHighlight' }
  | { type: 'resumeHighlight' }
  | { type: 'auditionOption'; slot: Slot; code: string }
  | { type: 'evaluateEditor' }
  /** Fix modes on code that doesn't evaluate: remember what is playing now (the last good pattern)… */
  | { type: 'snapshotPlaying' }
  /** …and go back to it (0/Esc), quantized like any swap, instead of evaluating the broken original. */
  | { type: 'restoreSnapshot' }
  | { type: 'commit'; capture: Capture; code: string };

export interface Transition {
  state: TrayState;
  effects: Effect[];
}

export const initialState: TrayState = { kind: 'playing' };

/** Shape and rewrite: 3–4 options. A minimal fix is 1 option, 2 when the intent is ambiguous. */
export const slotCount = (mode: Mode) => (mode === 'fix-minimal' ? 2 : 4);

const stay = (state: TrayState): Transition => ({ state, effects: [] });

function openTray(req: TrayRequest, requestId: number): Transition {
  const { capture, mode, instruction, fix } = req;
  const slots = Array.from({ length: slotCount(mode) }, (): SlotCard => ({ status: 'pending' }));
  const withFix = fix ? { fix } : {};
  return {
    state: { kind: 'tray', capture, mode, instruction, ...withFix, requestId, slots, done: false, heard: 0, stale: false, validationMs: [] },
    effects: [{ type: 'startRequest', requestId, capture, mode, instruction, ...withFix }],
  };
}

/** The original can't be evaluated, so "back to the original" means back to what played before the tray. */
const restoresSnapshot = (t: { fix?: TrayFix }) => !!t.fix?.broken;

export function transition(state: TrayState, event: TrayEvent): Transition {
  switch (state.kind) {
    case 'playing':
      if (event.type === 'request') {
        const opened = openTray(event, event.requestId);
        return restoresSnapshot(event) ? { ...opened, effects: [{ type: 'snapshotPlaying' }, ...opened.effects] } : opened;
      }
      return stay(state);

    case 'tray':
      return trayTransition(state, event);

    case 'committed':
      if (event.type === 'commitDone') return stay({ kind: 'playing' });
      return stay(state);
  }
}

function trayTransition(state: Tray, event: TrayEvent): Transition {
  const abort: Effect[] = state.done ? [] : [{ type: 'abortRequest' }];
  const restoreOriginal: Effect[] =
    state.heard === 0 ? [] : [{ type: restoresSnapshot(state) ? 'restoreSnapshot' : 'evaluateEditor' }, { type: 'resumeHighlight' }];
  const backToOriginal = (patch: Partial<Tray> = {}, effects: Effect[] = []): Transition => ({
    state: { ...state, heard: 0, ...patch },
    effects: [...effects, ...restoreOriginal],
  });
  const close = (effects: Effect[] = []): Transition => ({ state: { kind: 'playing' }, effects: [...abort, ...effects] });
  const withSlots = (slots: SlotCard[], patch: Partial<Tray> = {}): Transition =>
    stay({ ...state, slots, ...patch });

  switch (event.type) {
    case 'request':
    case 'regenerate': {
      if (event.type === 'regenerate' && state.stale) return stay(state);
      const req = event.type === 'request' ? event : state;
      const next = openTray(req, event.requestId);
      // A broken-code tray replacing one that already holds the snapshot keeps it: what plays after
      // restoreOriginal is that snapshot. Otherwise, after restoreOriginal, the original is playing.
      const snap: Effect[] = restoresSnapshot(req) && !restoresSnapshot(state) ? [{ type: 'snapshotPlaying' }] : [];
      return { state: next.state, effects: [...abort, ...restoreOriginal, ...snap, ...next.effects] };
    }

    case 'optionArrived':
    case 'optionValidated':
    case 'optionRetrying':
    case 'optionDropped': {
      if (event.requestId !== state.requestId || state.stale) return stay(state);
      const i = event.slot - 1;
      const card = state.slots[i];
      if (!card) return stay(state);
      const timed = 'ms' in event ? { validationMs: [...state.validationMs, event.ms] } : {};
      const slots = [...state.slots];
      switch (event.type) {
        case 'optionArrived':
          slots[i] = { ...card, status: 'validating', option: event.option };
          break;
        case 'optionValidated':
          slots[i] = {
            status: 'ready',
            option: event.option,
            warnings: event.warnings,
            unknownSounds: event.unknownSounds,
            checkedAlone: event.checkedAlone,
            changeSize: event.changeSize,
            retried: card.retried,
            drop: card.drop,
          };
          break;
        case 'optionRetrying':
          slots[i] = { ...card, status: 'retrying', retried: true, drop: { reason: event.reason, message: event.message } };
          break;
        case 'optionDropped':
          slots[i] = { ...card, status: 'dropped', drop: { reason: event.reason, message: event.message } };
          break;
      }
      return withSlots(slots, timed);
    }

    case 'bufferChecked':
      if (event.requestId !== state.requestId) return stay(state);
      return stay({ ...state, bufferError: event.error });

    case 'requestDone': {
      if (event.requestId !== state.requestId) return stay(state);
      const slots = state.slots.map((s): SlotCard => (s.status === 'pending' ? { status: 'empty' } : s));
      return withSlots(slots, { done: true, error: event.error, stats: event.stats });
    }

    case 'audition': {
      if (event.slot === 0) return backToOriginal();
      const card = state.slots[event.slot - 1];
      if (state.stale || event.slot === state.heard || card?.status !== 'ready') return stay(state);
      const effects: Effect[] = state.heard === 0 ? [{ type: 'pauseHighlight' }] : [];
      effects.push({ type: 'auditionOption', slot: event.slot, code: card.option!.code });
      return { state: { ...state, heard: event.slot }, effects };
    }

    case 'evalFailed': {
      const slots = state.slots.map((s, j): SlotCard => (j === event.slot - 1 ? { ...s, status: 'failed' } : s));
      if (event.slot !== state.heard) return withSlots(slots);
      return backToOriginal({ slots });
    }

    case 'escape':
      if (state.heard !== 0) return backToOriginal();
      return close();

    case 'enter': {
      if (state.heard === 0 || state.stale) return close();
      const option = state.slots[state.heard - 1].option!;
      return {
        state: { kind: 'committed', capture: state.capture, option },
        effects: [
          ...abort,
          { type: 'commit', capture: state.capture, code: option.code },
          { type: 'evaluateEditor' },
          { type: 'resumeHighlight' },
        ],
      };
    }

    case 'stale': {
      // The options no longer fit the text, so there's no point waiting for more.
      const unsettled = ['pending', 'validating', 'retrying'];
      const slots = state.slots.map((s): SlotCard => (unsettled.includes(s.status) ? { status: 'empty' } : s));
      return backToOriginal({ stale: true, slots, done: true }, abort);
    }

    case 'externalEval':
      // The user's own evaluation is already playing: don't re-evaluate, just undo the highlight pause.
      return close(state.heard === 0 ? [] : [{ type: 'resumeHighlight' }]);

    default:
      return stay(state);
  }
}
