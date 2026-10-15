import { describe, expect, it } from 'vitest';
import { initialState, transition, type TrayEvent, type TrayState } from '../src/trayMachine';
import type { Capture } from '../src/splice';

const capture: Capture = { range: { from: 2, to: 5 }, text: 'abc', buffer: 'xxabcxx' };

function run(events: TrayEvent[], start: TrayState = initialState) {
  let state = start;
  const effects = [];
  for (const e of events) {
    const t = transition(state, e);
    state = t.state;
    effects.push(...t.effects);
  }
  return { state, effects };
}

describe('tray state machine', () => {
  it('opens on capture with the original heard and no effects', () => {
    const { state, effects } = run([{ type: 'capture', capture }]);
    expect(state).toEqual({ kind: 'tray', capture, heard: 0, stale: false });
    expect(effects).toEqual([]);
  });

  it('pauses highlighting once when leaving the original, then swaps options', () => {
    const { state, effects } = run([
      { type: 'capture', capture },
      { type: 'audition', slot: 1 },
      { type: 'audition', slot: 3 },
    ]);
    expect(state).toMatchObject({ kind: 'tray', heard: 3 });
    expect(effects).toEqual([
      { type: 'pauseHighlight' },
      { type: 'auditionOption', slot: 1 },
      { type: 'auditionOption', slot: 3 },
    ]);
  });

  it('re-auditioning the slot already heard does nothing', () => {
    const { effects } = run([
      { type: 'capture', capture },
      { type: 'audition', slot: 2 },
      { type: 'audition', slot: 2 },
    ]);
    expect(effects.filter((e) => e.type === 'auditionOption')).toHaveLength(1);
  });

  it('0 and Esc return to the original and resume highlighting', () => {
    for (const back of [{ type: 'audition', slot: 0 }, { type: 'escape' }] as TrayEvent[]) {
      const { state, effects } = run([{ type: 'capture', capture }, { type: 'audition', slot: 4 }, back]);
      expect(state).toMatchObject({ kind: 'tray', heard: 0 });
      expect(effects.slice(-2)).toEqual([{ type: 'evaluateEditor' }, { type: 'resumeHighlight' }]);
    }
  });

  it('pressing 0 on the original does not re-evaluate', () => {
    const { effects } = run([{ type: 'capture', capture }, { type: 'audition', slot: 0 }]);
    expect(effects).toEqual([]);
  });

  it('Esc on the original closes the tray without evaluating', () => {
    const { state, effects } = run([
      { type: 'capture', capture },
      { type: 'audition', slot: 1 },
      { type: 'escape' },
      { type: 'escape' },
    ]);
    expect(state).toEqual({ kind: 'playing' });
    expect(effects.filter((e) => e.type === 'evaluateEditor')).toHaveLength(1);
  });

  it('follows the 0→1→3→0→4 sequence', () => {
    const { state, effects } = run([
      { type: 'capture', capture },
      { type: 'audition', slot: 0 },
      { type: 'audition', slot: 1 },
      { type: 'audition', slot: 3 },
      { type: 'audition', slot: 0 },
      { type: 'audition', slot: 4 },
    ]);
    expect(state).toMatchObject({ kind: 'tray', heard: 4 });
    expect(effects.map((e) => e.type)).toEqual([
      'pauseHighlight',
      'auditionOption',
      'auditionOption',
      'evaluateEditor',
      'resumeHighlight',
      'pauseHighlight',
      'auditionOption',
    ]);
  });

  it('Enter commits the heard option, then returns to playing', () => {
    const t1 = run([{ type: 'capture', capture }, { type: 'audition', slot: 2 }, { type: 'enter' }]);
    expect(t1.state).toEqual({ kind: 'committed', capture, option: 2 });
    expect(t1.effects.slice(-3)).toEqual([
      { type: 'commit', capture, option: 2 },
      { type: 'evaluateEditor' },
      { type: 'resumeHighlight' },
    ]);
    expect(transition(t1.state, { type: 'commitDone' }).state).toEqual({ kind: 'playing' });
  });

  it('Enter on the original just closes the tray', () => {
    const { state, effects } = run([{ type: 'capture', capture }, { type: 'enter' }]);
    expect(state).toEqual({ kind: 'playing' });
    expect(effects).toEqual([]);
  });

  it('stale returns to the original and blocks further auditions and commit', () => {
    const { state, effects } = run([
      { type: 'capture', capture },
      { type: 'audition', slot: 3 },
      { type: 'stale' },
      { type: 'audition', slot: 1 },
      { type: 'enter' },
    ]);
    expect(state).toEqual({ kind: 'playing' });
    expect(effects.map((e) => e.type)).toEqual(['pauseHighlight', 'auditionOption', 'evaluateEditor', 'resumeHighlight']);
  });

  it('a failed evaluation falls back to the original', () => {
    const { state, effects } = run([{ type: 'capture', capture }, { type: 'audition', slot: 1 }, { type: 'evalFailed' }]);
    expect(state).toMatchObject({ kind: 'tray', heard: 0, stale: false });
    expect(effects.slice(-2)).toEqual([{ type: 'evaluateEditor' }, { type: 'resumeHighlight' }]);
  });

  it('ignores tray keys while playing', () => {
    for (const e of [{ type: 'audition', slot: 1 }, { type: 'escape' }, { type: 'enter' }, { type: 'stale' }] as TrayEvent[]) {
      expect(transition(initialState, e)).toEqual({ state: initialState, effects: [] });
    }
  });
});
