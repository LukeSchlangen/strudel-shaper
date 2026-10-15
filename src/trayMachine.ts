import type { Capture } from './splice';

/** 0 is the original (the editor's real text); 1–4 index into the option list. */
export type Slot = 0 | 1 | 2 | 3 | 4;

export type TrayState =
  | { kind: 'playing' }
  | { kind: 'tray'; capture: Capture; heard: Slot; stale: boolean }
  | { kind: 'committed'; capture: Capture; option: Slot };

export type TrayEvent =
  | { type: 'capture'; capture: Capture }
  | { type: 'audition'; slot: Slot }
  | { type: 'escape' }
  | { type: 'enter' }
  | { type: 'stale' }
  | { type: 'evalFailed' }
  | { type: 'commitDone' };

export type Effect =
  | { type: 'pauseHighlight' }
  | { type: 'resumeHighlight' }
  | { type: 'auditionOption'; slot: Slot }
  | { type: 'evaluateEditor' }
  | { type: 'commit'; capture: Capture; option: Slot };

export interface Transition {
  state: TrayState;
  effects: Effect[];
}

export const initialState: TrayState = { kind: 'playing' };

const stay = (state: TrayState): Transition => ({ state, effects: [] });

export function transition(state: TrayState, event: TrayEvent): Transition {
  switch (state.kind) {
    case 'playing':
      if (event.type === 'capture') {
        return stay({ kind: 'tray', capture: event.capture, heard: 0, stale: false });
      }
      return stay(state);

    case 'tray':
      return trayTransition(state, event);

    case 'committed':
      if (event.type === 'commitDone') return stay({ kind: 'playing' });
      return stay(state);
  }
}

function trayTransition(state: Extract<TrayState, { kind: 'tray' }>, event: TrayEvent): Transition {
  const backToOriginal = (stale: boolean): Transition => ({
    state: { ...state, heard: 0, stale },
    effects: state.heard === 0 ? [] : [{ type: 'evaluateEditor' }, { type: 'resumeHighlight' }],
  });

  switch (event.type) {
    case 'audition': {
      if (event.slot === 0) return backToOriginal(state.stale);
      if (state.stale || event.slot === state.heard) return stay(state);
      const effects: Effect[] = state.heard === 0 ? [{ type: 'pauseHighlight' }] : [];
      effects.push({ type: 'auditionOption', slot: event.slot });
      return { state: { ...state, heard: event.slot }, effects };
    }
    case 'escape':
      if (state.heard !== 0) return backToOriginal(state.stale);
      return stay({ kind: 'playing' });
    case 'enter':
      if (state.heard === 0 || state.stale) return stay({ kind: 'playing' });
      return {
        state: { kind: 'committed', capture: state.capture, option: state.heard },
        effects: [
          { type: 'commit', capture: state.capture, option: state.heard },
          { type: 'evaluateEditor' },
          { type: 'resumeHighlight' },
        ],
      };
    case 'stale':
      return backToOriginal(true);
    case 'evalFailed':
      return backToOriginal(state.stale);
    default:
      return stay(state);
  }
}
