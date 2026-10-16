import { describe, expect, it } from 'vitest';
import { initialState, transition, type Effect, type OptionSlot, type TrayEvent, type TrayState } from '../src/trayMachine';
import type { Option } from '../src/provider';
import type { Capture } from '../src/splice';

const capture: Capture = { range: { from: 2, to: 5 }, text: 'abc', buffer: 'xxabcxx' };
const opt = (n: number, requestId = 1): Option => ({ id: `r${requestId}-${n}`, label: `opt ${n}`, code: `abc.o${n}()` });

const request: TrayEvent = { type: 'request', requestId: 1, capture, mode: 'shape', instruction: 'busier' };
/** Option n has arrived and passed validation, in slot n. */
const arrive = (n: number, requestId = 1): TrayEvent => ({
  type: 'optionValidated',
  requestId,
  slot: n as OptionSlot,
  option: opt(n, requestId),
  warnings: [],
  ms: 1,
});
/** Open the tray and let all four options arrive. */
const ready: TrayEvent[] = [request, arrive(1), arrive(2), arrive(3), arrive(4), { type: 'requestDone', requestId: 1 }];

function run(events: TrayEvent[], start: TrayState = initialState) {
  let state = start;
  const effects: Effect[] = [];
  for (const e of events) {
    const t = transition(state, e);
    state = t.state;
    effects.push(...t.effects);
  }
  return { state, effects };
}

/** Effects after the setup events. */
function after(setup: TrayEvent[], events: TrayEvent[]) {
  const base = run(setup);
  return run(events, base.state);
}

describe('tray state machine: milestone 1 behaviour', () => {
  it('opens on request with the original heard, all slots pending, and starts the request', () => {
    const { state, effects } = run([request]);
    expect(state).toMatchObject({ kind: 'tray', capture, heard: 0, stale: false, done: false, requestId: 1 });
    expect(state.kind === 'tray' && state.slots).toEqual(Array(4).fill({ status: 'pending' }));
    expect(effects).toEqual([{ type: 'startRequest', requestId: 1, capture, mode: 'shape', instruction: 'busier' }]);
  });

  it('pauses highlighting once when leaving the original, then swaps options', () => {
    const { state, effects } = after(ready, [
      { type: 'audition', slot: 1 },
      { type: 'audition', slot: 3 },
    ]);
    expect(state).toMatchObject({ kind: 'tray', heard: 3 });
    expect(effects).toEqual([
      { type: 'pauseHighlight' },
      { type: 'auditionOption', slot: 1, code: 'abc.o1()' },
      { type: 'auditionOption', slot: 3, code: 'abc.o3()' },
    ]);
  });

  it('re-auditioning the slot already heard does nothing', () => {
    const { effects } = after(ready, [
      { type: 'audition', slot: 2 },
      { type: 'audition', slot: 2 },
    ]);
    expect(effects.filter((e) => e.type === 'auditionOption')).toHaveLength(1);
  });

  it('0 and Esc return to the original and resume highlighting', () => {
    for (const back of [{ type: 'audition', slot: 0 }, { type: 'escape' }] as TrayEvent[]) {
      const { state, effects } = after(ready, [{ type: 'audition', slot: 4 }, back]);
      expect(state).toMatchObject({ kind: 'tray', heard: 0 });
      expect(effects.slice(-2)).toEqual([{ type: 'evaluateEditor' }, { type: 'resumeHighlight' }]);
    }
  });

  it('pressing 0 on the original does not re-evaluate', () => {
    expect(after(ready, [{ type: 'audition', slot: 0 }]).effects).toEqual([]);
  });

  it('Esc on the original closes the tray without evaluating', () => {
    const { state, effects } = after(ready, [{ type: 'audition', slot: 1 }, { type: 'escape' }, { type: 'escape' }]);
    expect(state).toEqual({ kind: 'playing' });
    expect(effects.filter((e) => e.type === 'evaluateEditor')).toHaveLength(1);
  });

  it('follows the 0→1→3→0→4 sequence', () => {
    const { state, effects } = after(
      ready,
      [0, 1, 3, 0, 4].map((slot) => ({ type: 'audition', slot }) as TrayEvent),
    );
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
    const t1 = after(ready, [{ type: 'audition', slot: 2 }, { type: 'enter' }]);
    expect(t1.state).toEqual({ kind: 'committed', capture, option: opt(2) });
    expect(t1.effects.slice(-3)).toEqual([
      { type: 'commit', capture, code: 'abc.o2()' },
      { type: 'evaluateEditor' },
      { type: 'resumeHighlight' },
    ]);
    expect(transition(t1.state, { type: 'commitDone' }).state).toEqual({ kind: 'playing' });
  });

  it('Enter on the original just closes the tray', () => {
    const { state, effects } = after(ready, [{ type: 'enter' }]);
    expect(state).toEqual({ kind: 'playing' });
    expect(effects).toEqual([]);
  });

  it('stale returns to the original and blocks further auditions and commit', () => {
    const { state, effects } = after(ready, [
      { type: 'audition', slot: 3 },
      { type: 'stale' },
      { type: 'audition', slot: 1 },
      { type: 'enter' },
    ]);
    expect(state).toEqual({ kind: 'playing' });
    expect(effects.map((e) => e.type)).toEqual(['pauseHighlight', 'auditionOption', 'evaluateEditor', 'resumeHighlight']);
  });

  it('a failed evaluation marks the card failed and falls back to the original', () => {
    const { state, effects } = after(ready, [{ type: 'audition', slot: 1 }, { type: 'evalFailed', slot: 1 }]);
    expect(state).toMatchObject({ kind: 'tray', heard: 0, stale: false });
    expect(state.kind === 'tray' && state.slots[0].status).toBe('failed');
    expect(effects.slice(-2)).toEqual([{ type: 'evaluateEditor' }, { type: 'resumeHighlight' }]);
  });

  it('a failed card can no longer be auditioned', () => {
    const { effects } = after(
      [...ready, { type: 'audition', slot: 1 }, { type: 'evalFailed', slot: 1 }],
      [{ type: 'audition', slot: 1 }],
    );
    expect(effects).toEqual([]);
  });

  it('ignores tray keys while playing', () => {
    const events: TrayEvent[] = [
      { type: 'audition', slot: 1 },
      { type: 'escape' },
      { type: 'enter' },
      { type: 'stale' },
      { type: 'regenerate', requestId: 2 },
      { type: 'externalEval' },
      arrive(1),
    ];
    for (const e of events) expect(transition(initialState, e)).toEqual({ state: initialState, effects: [] });
  });
});

describe('tray state machine: streaming', () => {
  it('auditioning a pending slot does nothing', () => {
    const { state, effects } = after([request, arrive(1)], [{ type: 'audition', slot: 2 }]);
    expect(state).toMatchObject({ heard: 0 });
    expect(effects).toEqual([]);
  });

  it('fills slots in arrival order', () => {
    const { state } = run([request, arrive(1), arrive(2)]);
    expect(state.kind === 'tray' && state.slots.map((s) => s.status)).toEqual(['ready', 'ready', 'pending', 'pending']);
    expect(state.kind === 'tray' && state.slots[1].option).toEqual(opt(2));
  });

  it('drops options and completion from an old request', () => {
    const { state } = run([request, arrive(1, 99), { type: 'requestDone', requestId: 99 }]);
    expect(state).toMatchObject({ done: false });
    expect(state.kind === 'tray' && state.slots.every((s) => s.status === 'pending')).toBe(true);
  });

  it('requestDone turns leftover placeholders empty and records an error', () => {
    const { state } = run([request, arrive(1), { type: 'requestDone', requestId: 1, error: 'boom' }]);
    expect(state).toMatchObject({ done: true, error: 'boom' });
    expect(state.kind === 'tray' && state.slots.map((s) => s.status)).toEqual(['ready', 'empty', 'empty', 'empty']);
  });

  it('a minimal fix has two slots (one fix, or two for an ambiguous intent); a rewrite has four', () => {
    const minimal = run([{ ...request, mode: 'fix-minimal', instruction: '' } as TrayEvent]).state;
    expect(minimal.kind === 'tray' && minimal.slots).toHaveLength(2);
    const rewrite = run([{ ...request, mode: 'fix-rewrite' } as TrayEvent]).state;
    expect(rewrite.kind === 'tray' && rewrite.slots).toHaveLength(4);
  });

  it('closing with Esc or Enter aborts a request in flight, but not a finished one', () => {
    expect(after([request], [{ type: 'escape' }]).effects).toEqual([{ type: 'abortRequest' }]);
    expect(after(ready, [{ type: 'escape' }]).effects).toEqual([]);
    const commit = after([request, arrive(1), { type: 'audition', slot: 1 }], [{ type: 'enter' }]);
    expect(commit.effects[0]).toEqual({ type: 'abortRequest' });
  });
});

describe('tray state machine: regenerate, new requests and outside evaluation', () => {
  it('regenerate aborts, restarts with the same instruction and returns to the original', () => {
    const { state, effects } = after([request, arrive(1), arrive(2), { type: 'audition', slot: 2 }], [
      { type: 'regenerate', requestId: 2 },
    ]);
    expect(state).toMatchObject({ kind: 'tray', requestId: 2, heard: 0, done: false, instruction: 'busier' });
    expect(state.kind === 'tray' && state.slots.every((s) => s.status === 'pending')).toBe(true);
    expect(effects).toEqual([
      { type: 'abortRequest' },
      { type: 'evaluateEditor' },
      { type: 'resumeHighlight' },
      { type: 'startRequest', requestId: 2, capture, mode: 'shape', instruction: 'busier' },
    ]);
  });

  it('regenerate after completion does not abort', () => {
    const { effects } = after(ready, [{ type: 'regenerate', requestId: 2 }]);
    expect(effects.map((e) => e.type)).toEqual(['startRequest']);
  });

  it('options from the replaced request are ignored after regenerate', () => {
    const { state } = after([request, { type: 'regenerate', requestId: 2 }], [arrive(1, 1), arrive(1, 2)]);
    expect(state.kind === 'tray' && state.slots[0].option).toEqual(opt(1, 2));
    expect(state.kind === 'tray' && state.slots[1].status).toBe('pending');
  });

  it('regenerate is blocked while stale', () => {
    const { state, effects } = after([...ready, { type: 'stale' }], [{ type: 'regenerate', requestId: 2 }]);
    expect(state).toMatchObject({ requestId: 1, stale: true });
    expect(effects).toEqual([]);
  });

  it('stale aborts a request in flight and clears its placeholders', () => {
    const { state, effects } = after([request, arrive(1)], [{ type: 'stale' }]);
    expect(effects).toEqual([{ type: 'abortRequest' }]);
    expect(state.kind === 'tray' && state.slots.map((s) => s.status)).toEqual(['ready', 'empty', 'empty', 'empty']);
  });

  it('a new request from the tray aborts the old one and starts fresh', () => {
    const other: Capture = { range: { from: 0, to: 2 }, text: 'xx', buffer: 'xxabcxx' };
    const { state, effects } = after([request, arrive(1), { type: 'audition', slot: 1 }], [
      { type: 'request', requestId: 2, capture: other, mode: 'shape', instruction: '' },
    ]);
    expect(state).toMatchObject({ kind: 'tray', capture: other, requestId: 2, heard: 0, stale: false });
    expect(effects.map((e) => e.type)).toEqual(['abortRequest', 'evaluateEditor', 'resumeHighlight', 'startRequest']);
  });

  it('an outside evaluation closes the tray without re-evaluating', () => {
    const heard = after([request, arrive(1), { type: 'audition', slot: 1 }], [{ type: 'externalEval' }]);
    expect(heard.state).toEqual({ kind: 'playing' });
    expect(heard.effects).toEqual([{ type: 'abortRequest' }, { type: 'resumeHighlight' }]);
    const original = after(ready, [{ type: 'externalEval' }]);
    expect(original).toEqual({ state: { kind: 'playing' }, effects: [] });
  });
});

describe('tray state machine: validation', () => {
  const slotsOf = (state: TrayState) => (state.kind === 'tray' ? state.slots : []);
  const raw = (n: number): TrayEvent => ({ type: 'optionArrived', requestId: 1, slot: n as OptionSlot, option: opt(n) });

  it('a raw option shows as validating and cannot be auditioned', () => {
    const { state, effects } = after([request, raw(2)], [{ type: 'audition', slot: 2 }]);
    expect(slotsOf(state).map((s) => s.status)).toEqual(['pending', 'validating', 'pending', 'pending']);
    expect(slotsOf(state)[1].option).toEqual(opt(2));
    expect(effects).toEqual([]);
  });

  it('validated with warnings: ready, badges kept, auditionable', () => {
    const { state, effects } = run([
      request,
      raw(1),
      { type: 'optionValidated', requestId: 1, slot: 1, option: opt(1), warnings: ['unknown-sample'], unknownSounds: ['zzzz'], ms: 4 },
      { type: 'audition', slot: 1 },
    ]);
    expect(slotsOf(state)[0]).toEqual({ status: 'ready', option: opt(1), warnings: ['unknown-sample'], unknownSounds: ['zzzz'], retried: undefined });
    expect(effects.map((e) => e.type)).toEqual(['startRequest', 'pauseHighlight', 'auditionOption']);
    expect(state).toMatchObject({ validationMs: [4] });
  });

  it('retrying, then the replacement passes: ready and marked retried', () => {
    const replacement = { ...opt(9), code: 'abc.fast(2)' };
    const { state } = run([
      request,
      raw(1),
      { type: 'optionRetrying', requestId: 1, slot: 1, reason: 'syntax', message: 'Unexpected token', ms: 1 },
    ]);
    expect(slotsOf(state)[0]).toMatchObject({ status: 'retrying', retried: true, drop: { reason: 'syntax' } });
    const done = run(
      [
        { type: 'optionArrived', requestId: 1, slot: 1, option: replacement },
        { type: 'optionValidated', requestId: 1, slot: 1, option: replacement, warnings: [], ms: 2 },
      ],
      state,
    ).state;
    expect(slotsOf(done)[0]).toMatchObject({ status: 'ready', option: replacement, retried: true });
    expect(done).toMatchObject({ validationMs: [1, 2] });
  });

  it('dropped for good keeps the reason and message', () => {
    const { state } = run([
      request,
      raw(1),
      { type: 'optionRetrying', requestId: 1, slot: 1, reason: 'eval', message: 'x.wobble is not a function', ms: 1 },
      { type: 'optionDropped', requestId: 1, slot: 1, reason: 'query', message: 'boom', ms: 1 },
      { type: 'audition', slot: 1 },
    ]);
    expect(slotsOf(state)[0]).toMatchObject({ status: 'dropped', retried: true, drop: { reason: 'query', message: 'boom' } });
    expect(state).toMatchObject({ heard: 0 });
  });

  it('ignores validation events from an old request or for a slot that does not exist', () => {
    const { state } = run([
      request,
      { type: 'optionDropped', requestId: 0, slot: 1, reason: 'syntax', message: '', ms: 1 },
      { type: 'optionArrived', requestId: 1, slot: 4, option: opt(4) },
    ]);
    expect(slotsOf(state).map((s) => s.status)).toEqual(['pending', 'pending', 'pending', 'validating']);
    const fix = run([{ ...request, mode: 'fix-minimal', instruction: '' } as TrayEvent, raw(3)]).state;
    expect(slotsOf(fix).map((s) => s.status)).toEqual(['pending', 'pending']);
  });

  it('stale clears slots still validating or retrying', () => {
    const { state } = after(
      [request, arrive(1), raw(2), { type: 'optionRetrying', requestId: 1, slot: 3, reason: 'syntax', message: '', ms: 1 }],
      [{ type: 'stale' }],
    );
    expect(slotsOf(state).map((s) => s.status)).toEqual(['ready', 'empty', 'empty', 'empty']);
  });
});
