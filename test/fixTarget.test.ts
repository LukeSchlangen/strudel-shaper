import { beforeAll, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { ensureSyntaxTree } from '@codemirror/language';
import { codeOccurrences, locateError } from '../src/errorPosition';
import { diagnoseFix, noRequestReason, trayFix, type Diagnosis } from '../src/fixTarget';
import { STARTER_CODE } from '../src/options';
import { Sandbox } from '../src/sandbox';
import { Validator } from '../src/validator';

const HH = 's("hh*8").gain(0.6)';
const KICK = 's("bd*4")';

let sandbox: Sandbox;
let validator: Validator;
beforeAll(async () => {
  sandbox = await Sandbox.create();
  validator = new Validator({ backend: sandbox, hasSound: (k) => ['bd', 'hh', 'oh', 'sawtooth', 'triangle'].includes(k), cps: () => 0.5 });
});

function editor(doc: string, anchor = 0, head = anchor) {
  const state = EditorState.create({ doc, selection: { anchor, head }, extensions: javascript() });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

/** The starter with the hi-hat line replaced; cursor at the start of the buffer (line 1) unless given. */
const broken = (hat: string, kick = KICK) => STARTER_CODE.replace(HH, hat).replace(KICK, kick);

async function diagnose(doc: string, opts: { cursor?: number; select?: string } = {}) {
  const selFrom = opts.select ? doc.indexOf(opts.select) : -1;
  const state = editor(doc, opts.cursor ?? 0);
  const selection = opts.select ? { from: selFrom, to: selFrom + opts.select.length } : null;
  const d = await diagnoseFix({ state, selection, validator });
  return { d, text: doc.slice(d.range.from, d.range.to) };
}

describe('Strudel error messages (what positions they carry)', () => {
  it.each([
    ['a misspelled method', 's("hh*8").gian(0.6)', 'eval', /^s\(\.\.\.\)\.gian is not a function$/],
    ['unbalanced mini-notation', 's("hh*8[").gain(0.6)', 'syntax', /^\[mini\] parse error at line 4: /],
    ['a missing quote', 's("hh*8).gain(0.6)', 'syntax', /^Unterminated string constant \(4:4\)$/],
    // Reported where acorn gave up: the closing line of stack(, two lines below the mistake.
    ['a missing paren', 's("hh*8".gain(0.6)', 'syntax', /^Unexpected token \(6:1\)$/],
    ['a value called as a function', 'silence()', 'eval', /^silence is not a function$/],
    ['swapped euclid arguments', 's("hh").euclid(8, 3).gain(0.6)', 'eval', /^Invalid array length$/],
    ['a string where a number goes', 's("hh*8").fast("double").gain(0.6)', 'query', /^Invalid argument$/],
  ])('%s', async (_name, hat, stage, message) => {
    const r = await sandbox.check(broken(hat), 0.5);
    expect(r).toMatchObject({ ok: false, stage });
    expect(r.ok ? '' : r.message).toMatch(message);
  });

  it('runtime errors carry no position, so names are searched for outside strings', () => {
    const doc = broken('s(hh*8).gain(0.6)');
    expect(locateError(doc, 'hh is not defined')).toEqual({ pos: doc.indexOf('hh*8)'), line: 4 });
    expect(locateError(doc, 'Invalid array length')).toEqual({});
    const chained = broken('s("hh*8").gain(0.6).zork(1)');
    expect(locateError(chained, 's(...).gain(...).zork is not a function')).toEqual({ pos: chained.indexOf('zork'), line: 4 });
    expect(locateError(STARTER_CODE, 's is not a function')).toEqual({}); // `s` occurs three times: no guess
    expect(codeOccurrences('s("hh").hh(1) // hh\n/* hh */ hhh', 'hh')).toEqual([8]);
  });

  it('reads (line:col) and mini-notation lines', () => {
    const doc = broken('s("hh*8).gain(0.6)');
    expect(locateError(doc, 'Unterminated string constant (4:4)')).toEqual({ line: 4, pos: doc.indexOf('"hh*8)') }); // col 4: the opening quote
    expect(locateError(doc, '[mini] parse error at line 4: Expected …')).toEqual({ line: 4, pos: doc.indexOf('s("hh*8)') });
  });
});

describe('diagnoseFix: what ⌘J fixes with only a cursor', () => {
  it.each([
    ['a misspelled method', 's("hh*8").gian(0.6)', 's("hh*8").gian(0.6)'],
    ['unbalanced mini-notation', 's("hh*8[").gain(0.6)', 's("hh*8[").gain(0.6)'],
    ['a missing quote', 's("hh*8).gain(0.6)', 's("hh*8).gain(0.6)'],
    ['a missing paren (reported two lines below)', 's("hh*8".gain(0.6)', 's("hh*8".gain(0.6)'],
    ['a value called as a function', 'silence()', 'silence()'],
    ['a signal called as a function', 's("hh*8").gain(sine())', 's("hh*8").gain(sine())'],
    ['swapped arguments (no position: found by checking lines alone)', 's("hh").euclid(8, 3).gain(0.6)', 's("hh").euclid(8, 3).gain(0.6)'],
    ['a wrong argument type (query error)', 's("hh*8").fast("double").gain(0.6)', 's("hh*8").fast("double").gain(0.6)'],
  ])('%s → the hi-hat expression, wherever the cursor is', async (_name, hat, expected) => {
    const { d, text } = await diagnose(broken(hat));
    expect(d.kind).toBe('broken');
    expect(text).toBe(expected);
  });

  it('a silent line (wrong scale name) is broken when the cursor is on it', async () => {
    const hat = 'n("0 2 4").scale("D:dorain").s("sawtooth")';
    const doc = broken(hat);
    const { d, text } = await diagnose(doc, { cursor: doc.indexOf(hat) + 3 });
    expect(d).toMatchObject({ kind: 'broken', error: { stage: 'silent' } });
    expect(text).toBe(hat);
  });

  it('an unknown sound is broken', async () => {
    const hat = 's("hihat*8").gain(0.6)';
    const doc = broken(hat);
    const { d } = await diagnose(doc, { cursor: doc.indexOf(hat) });
    expect(d).toMatchObject({ kind: 'broken', error: { stage: 'unknown-sample', message: '`hihat` is not a loaded sound.' } });
  });

  it('nothing to fix: the buffer runs and the line at the cursor sounds', async () => {
    for (const cursor of [0, STARTER_CODE.indexOf(HH) + 2]) {
      expect((await diagnose(STARTER_CODE, { cursor })).d.kind).toBe('ok');
    }
  });
});

describe('diagnoseFix with an explicit selection', () => {
  it('the error inside the selection: fix the selection', async () => {
    const hat = 's("hh*8").gian(0.6)';
    const { d, text } = await diagnose(broken(hat), { select: hat });
    expect(d).toMatchObject({ kind: 'broken', error: { stage: 'eval' } });
    expect(text).toBe(hat);
  });

  it('the error outside a selection that works: nothing is sent, and the line is named', async () => {
    const { d } = await diagnose(broken(HH, 's("bd*4").gian(2)'), { select: HH });
    expect(d).toMatchObject<Partial<Diagnosis>>({ kind: 'outside', error: { stage: 'eval', message: 's(...).gian is not a function', line: 3, pos: expect.any(Number) } });
  });

  it('the error outside a selection that is broken itself: fix the selection, judged alone', async () => {
    const hat = 's("hh*8").fast("double").gain(0.6)';
    const { d, text } = await diagnose(broken(hat, 's("bd*4").gian(2)'), { select: hat });
    expect(d).toMatchObject({ kind: 'broken', error: { stage: 'query' }, otherErrors: { message: 's(...).gian is not a function' } });
    expect(text).toBe(hat);
  });

  it('a silent selection in a buffer that runs', async () => {
    const hat = 's("~ ~ ~ ~").gain(0.6)';
    const { d } = await diagnose(broken(hat), { select: hat });
    expect(d).toMatchObject({ kind: 'broken', error: { stage: 'silent' } });
  });

  it('a working selection in a working buffer: nothing to fix', async () => {
    expect((await diagnose(STARTER_CODE, { select: HH })).d.kind).toBe('ok');
  });
});

describe('from diagnosis to request', () => {
  const r = { from: 0, to: 5 };
  const err = { stage: 'eval' as const, message: 's(...).gian is not a function', line: 3, pos: 20 };

  it('⌘J sends nothing for code that runs, an error outside the selection, or an error it can’t place', () => {
    expect(noRequestReason({ kind: 'ok', range: r }, 'fix-minimal')).toBe('nothing to fix: this code runs');
    expect(noRequestReason({ kind: 'outside', range: r, error: err }, 'fix-minimal')).toBe('the error is on line 3, outside the selection: s(...).gian is not a function');
    expect(noRequestReason({ kind: 'unknown', range: r, error: { stage: 'eval', message: 'Invalid array length' } }, 'fix-minimal')).toMatch(/^can't tell where the error is \(Invalid array length\)/);
    expect(noRequestReason({ kind: 'broken', range: r, error: err }, 'fix-minimal')).toBeNull();
  });

  it('⌘⇧J always runs: a rewrite is useful on working code too', () => {
    for (const d of [{ kind: 'ok', range: r }, { kind: 'outside', range: r, error: err }] as Diagnosis[]) expect(noRequestReason(d, 'fix-rewrite')).toBeNull();
  });

  it('the end to end "nothing to fix" path: the starter buffer sends nothing on ⌘J', async () => {
    const { d } = await diagnose(STARTER_CODE, { cursor: STARTER_CODE.indexOf(HH) });
    expect(noRequestReason(d, 'fix-minimal')).toBe('nothing to fix: this code runs');
  });

  it('maps each diagnosis to the request fields, the validation context and whether the original evaluates', () => {
    expect(trayFix({ kind: 'ok', range: r })).toEqual({ broken: false });
    expect(trayFix({ kind: 'broken', range: r, error: err })).toEqual({
      broken: true,
      error: err.message,
      errorAt: { line: 3, inSelection: true },
      context: { originalError: { stage: 'eval', message: err.message }, judgeAlone: false },
    });
    // A silent selection: the buffer still evaluates, so 0/Esc can re-evaluate it.
    expect(trayFix({ kind: 'broken', range: r, error: { stage: 'silent', message: 'It runs but makes no sound.' } }).broken).toBe(false);
    const other = trayFix({ kind: 'broken', range: r, error: { stage: 'query', message: 'Invalid argument' }, otherErrors: err });
    expect(other).toMatchObject({ broken: true, errorAt: { inSelection: true, otherError: { message: err.message, line: 3 } }, context: { judgeAlone: true } });
    expect(trayFix({ kind: 'outside', range: r, error: err })).toMatchObject({ broken: true, errorAt: { line: 3, inSelection: false }, context: { judgeAlone: true } });
  });
});
