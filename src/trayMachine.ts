import type { Mode, Option } from './provider';
import type { Capture } from './splice';
import type { DropReason, Warning } from './validator';

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
  /** A replacement was asked for. */
  retried?: boolean;
  /** Why the slot was (last) dropped. */
  drop?: { reason: DropReason; message: string };
}

export interface TrayRequest {
  capture: Capture;
  mode: Mode;
  instruction: string;
}

export interface Tray extends TrayRequest {
  kind: 'tray';
  requestId: number;
  slots: SlotCard[]; // slots[i] is card i + 1
  done: boolean; // the provider has finished (or was aborted)
  error?: string;
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
  | { type: 'optionValidated'; requestId: number; slot: OptionSlot; option: Option; warnings: Warning[]; unknownSounds?: string[]; ms: number }
  | { type: 'optionRetrying'; requestId: number; slot: OptionSlot; reason: DropReason; message: string; ms: number }
  | { type: 'optionDropped'; requestId: number; slot: OptionSlot; reason: DropReason; message: string; ms: number }
  | { type: 'requestDone'; requestId: number; error?: string }
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
  | { type: 'commit'; capture: Capture; code: string };

export interface Transition {
  state: TrayState;
  effects: Effect[];
}

export const initialState: TrayState = { kind: 'playing' };

export const slotCount = (mode: Mode) => (mode === 'shape' ? 4 : 1);

const stay = (state: TrayState): Transition => ({ state, effects: [] });

function openTray(req: TrayRequest, requestId: number): Transition {
  const { capture, mode, instruction } = req;
  const slots = Array.from({ length: slotCount(mode) }, (): SlotCard => ({ status: 'pending' }));
  return {
    state: { kind: 'tray', capture, mode, instruction, requestId, slots, done: false, heard: 0, stale: false, validationMs: [] },
    effects: [{ type: 'startRequest', requestId, capture, mode, instruction }],
  };
}

export function transition(state: TrayState, event: TrayEvent): Transition {
  switch (state.kind) {
    case 'playing':
      if (event.type === 'request') return openTray(event, event.requestId);
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
  const restoreOriginal: Effect[] = state.heard === 0 ? [] : [{ type: 'evaluateEditor' }, { type: 'resumeHighlight' }];
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
      return { state: next.state, effects: [...abort, ...restoreOriginal, ...next.effects] };
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
            retried: card.retried,
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

    case 'requestDone': {
      if (event.requestId !== state.requestId) return stay(state);
      const slots = state.slots.map((s): SlotCard => (s.status === 'pending' ? { status: 'empty' } : s));
      return withSlots(slots, { done: true, error: event.error });
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
