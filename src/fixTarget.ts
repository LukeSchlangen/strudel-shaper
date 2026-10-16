import type { EditorState } from '@codemirror/state';
import { captureAt, lineRangeAt } from './capture';
import type { CheckResult, CheckStage } from './sandbox';
import type { Range } from './splice';
import { sameError, tempoLines, type Validator } from './validator';

/**
 * What ⌘J / ⌘⇧J operate on, and why. Runs only when the user presses one of them: nothing here
 * fixes or even diagnoses code on its own. DOM-free, so the eval harness uses it too.
 *
 * Where Strudel's errors point (measured in test/fixTarget.test.ts):
 * - JS syntax errors (acorn, via the transpiler) end in `(line:col)`, buffer coordinates. A missing
 *   `)` is reported where parsing gave up, often the closing line of `stack(`, not the broken line.
 * - Mini-notation errors say `[mini] parse error at line N: …`: a line, no column.
 * - Runtime errors (`s(...).gian is not a function`, `Invalid array length`) carry no position: the
 *   transpiled code runs through Function(), so their stacks point into generated code. For
 *   "X is not a function / defined" the name is searched for in the buffer instead.
 */

/** `silent` and `unknown-sample`: the code runs but the target makes no (known) sound. */
export type FixStage = CheckStage | 'silent' | 'unknown-sample';

export interface FixError {
  stage: FixStage;
  message: string;
  /** Buffer offset of the error, when it can be told. */
  pos?: number;
  /** 1-based buffer line of the error, when it can be told. */
  line?: number;
}

export type Diagnosis =
  /** Nothing is broken. `range` is what ⌘⇧J would rewrite. */
  | { kind: 'ok'; range: Range }
  /**
   * `range` is broken and is what to fix. `otherErrors`: the buffer also fails outside `range`
   * (so options are judged on their own).
   */
  | { kind: 'broken'; range: Range; error: FixError; otherErrors?: FixError }
  /** An explicit selection that works, while the buffer fails elsewhere. */
  | { kind: 'outside'; range: Range; error: FixError }
  /** The buffer fails, but no expression could be found that fails the same way on its own. */
  | { kind: 'unknown'; range: Range; error: FixError };

export interface DiagnoseInput {
  state: EditorState;
  /** The trimmed explicit selection, or null when ⌘J was pressed with only a cursor. */
  selection: Range | null;
  validator: Pick<Validator, 'baseline' | 'inspect' | 'hasSound'>;
  /** The live repl's last eval error, when it came from evaluating exactly the current text. */
  liveError?: string;
}

const MAX_LINE_CHECKS = 40;

export async function diagnoseFix({ state, selection, validator, liveError }: DiagnoseInput): Promise<Diagnosis> {
  const buffer = state.doc.toString();
  const cursorTarget = () => captureAt(state, state.selection.main.head);
  const baseline = await validator.baseline(buffer);

  if (baseline.ok && !liveError) {
    // The buffer runs. The target may still be silent or use sounds that aren't loaded.
    const range = selection ?? cursorTarget();
    const silent = range.from < range.to ? await soundProblem(validator, buffer, range) : null;
    return silent ? { kind: 'broken', range, error: silent } : { kind: 'ok', range };
  }

  const stage: CheckStage = baseline.ok ? 'eval' : baseline.stage;
  const message = baseline.ok ? liveError! : baseline.message;
  const error: FixError = { stage, message, ...(await locate(state, validator, stage, message)) };

  if (selection) {
    if (await errorInside(validator, buffer, selection, error)) return { kind: 'broken', range: selection, error };
    // The error is elsewhere, but the selection may be broken in its own way: then fix that.
    const own = await aloneProblem(validator, buffer, selection);
    if (own) return { kind: 'broken', range: selection, error: own, otherErrors: error };
    return { kind: 'outside', range: selection, error };
  }

  if (error.pos !== undefined) return { kind: 'broken', range: targetAt(state, error.pos, stage), error };
  // No position: the expression at the cursor, then each line's expression, checked alone.
  const tried = new Set<string>();
  const lines = [state.doc.lineAt(state.selection.main.head).number, ...Array.from({ length: state.doc.lines }, (_, i) => i + 1)];
  for (const n of lines) {
    if (tried.size >= MAX_LINE_CHECKS) break;
    const line = state.doc.line(n);
    const range = n === lines[0] ? cursorTarget() : captureAt(state, line.from + (line.text.length - line.text.trimStart().length));
    const key = `${range.from}:${range.to}`;
    if (range.from === range.to || tried.has(key)) continue;
    tried.add(key);
    const alone = await checkAlone(validator, buffer, range);
    if (!alone.ok && sameError(alone, error)) {
      return { kind: 'broken', range, error: { ...error, pos: range.from, line: n } };
    }
  }
  return { kind: 'unknown', range: cursorTarget(), error };
}

/** Where the error is: a position from the message, a mini-notation line, or a unique name in the buffer. */
async function locate(state: EditorState, validator: DiagnoseInput['validator'], stage: CheckStage, message: string): Promise<Pick<FixError, 'pos' | 'line'>> {
  const found = locateError(state.doc.toString(), message);
  if (stage !== 'syntax' || found.line === undefined) return found;
  // Syntax: walk up from the reported line to the first line that doesn't parse on its own.
  const line = await brokenLineFrom(state, validator, found.line);
  if (line === found.line) return found;
  const l = state.doc.line(line);
  return { line, pos: l.from + (l.text.length - l.text.trimStart().length) };
}

/** Position from the message text alone: `(L:C)`, `at line N`, or a unique `name` from "X is not a function/defined". */
export function locateError(buffer: string, message: string): { pos?: number; line?: number } {
  const lineStart = (n: number) => {
    let pos = 0;
    for (let i = 1; i < n; i++) {
      const nl = buffer.indexOf('\n', pos);
      if (nl < 0) return buffer.length;
      pos = nl + 1;
    }
    return pos;
  };
  const lc = /\((\d+):(\d+)\)\s*$/.exec(message);
  if (lc) {
    const line = Number(lc[1]);
    return { line, pos: Math.min(buffer.length, lineStart(line) + Number(lc[2])) };
  }
  const mini = /\bparse error at line (\d+)/.exec(message);
  if (mini) {
    const line = Number(mini[1]);
    const start = lineStart(line);
    const text = buffer.slice(start).split('\n')[0];
    return { line, pos: start + (text.length - text.trimStart().length) };
  }
  const named = /([\w$.]+)(?:\(\.\.\.\))?(?:\.([\w$]+))? is not (?:a function|defined)/.exec(message);
  if (named) {
    const name = (named[2] ?? named[1]).split('.').at(-1)!;
    const hits = codeOccurrences(buffer, name);
    if (hits.length === 1) return { pos: hits[0], line: buffer.slice(0, hits[0]).split('\n').length };
  }
  return {};
}

/** Offsets of `name` as a whole identifier outside strings and comments. */
export function codeOccurrences(code: string, name: string): number[] {
  const hits: number[] = [];
  const word = /[\w$]/;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < code.length && code[i] !== c; i++) if (code[i] === '\\') i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 1;
      continue;
    }
    if (code.startsWith(name, i) && !word.test(code[i - 1] ?? '') && !word.test(code[i + name.length] ?? '')) {
      hits.push(i);
      i += name.length - 1;
    }
  }
  return hits;
}

/** A line that can't be the culprit: only closing brackets and separators, or one that just opens a call (`stack(`). */
const structural = (text: string) => /^[\s)\]},;]*$/.test(text) || /[([{]\s*$/.test(text) || /^\s*\./.test(text);

/**
 * From the reported line upwards (a few lines), the first line whose own text doesn't parse alone.
 * Falls back to the reported line, or the nearest line above it with code when that one is structural.
 */
async function brokenLineFrom(state: EditorState, validator: DiagnoseInput['validator'], reported: number): Promise<number> {
  const first = Math.min(reported, state.doc.lines);
  let fallback: number | null = null;
  for (let n = first; n >= Math.max(1, first - 8); n--) {
    const r = lineRangeAt(state, state.doc.line(n).from);
    const text = state.doc.sliceString(r.from, r.to);
    if (structural(text)) continue;
    fallback ??= n;
    const alone = await validator.inspect(text);
    if (!alone.ok && alone.stage === 'syntax') return n;
  }
  return fallback ?? first;
}

/** For a syntax error the syntax tree is unreliable, so the whole trimmed line is the target. */
function targetAt(state: EditorState, pos: number, stage: CheckStage): Range {
  return stage === 'syntax' ? lineRangeAt(state, pos) : captureAt(state, pos);
}

/** The range checked alone, with the buffer's tempo lines so `.cpm()` and the like behave. */
function checkAlone(validator: DiagnoseInput['validator'], buffer: string, range: Range): Promise<CheckResult> {
  const tempo = tempoLines(buffer);
  const text = buffer.slice(range.from, range.to);
  return validator.inspect(tempo + text, { from: tempo.length, to: tempo.length + text.length });
}

async function errorInside(validator: DiagnoseInput['validator'], buffer: string, range: Range, error: FixError): Promise<boolean> {
  if (error.pos !== undefined) return error.pos >= range.from && error.pos <= range.to;
  const alone = await checkAlone(validator, buffer, range);
  return !alone.ok && sameError(alone, error);
}

/** The selection's own failure, checked alone: an error, no sound, or unknown sounds. */
async function aloneProblem(validator: DiagnoseInput['validator'], buffer: string, range: Range): Promise<FixError | null> {
  const alone = await checkAlone(validator, buffer, range);
  if (!alone.ok) return { stage: alone.stage, message: alone.message, pos: range.from };
  return eventProblem(validator, alone.span ?? alone);
}

/** In a buffer that runs: the target's own events, or (without mini-notation to tell them apart) the target alone. */
async function soundProblem(validator: DiagnoseInput['validator'], buffer: string, range: Range): Promise<FixError | null> {
  const inBuffer = await validator.inspect(buffer, range);
  if (inBuffer.ok && inBuffer.span) return eventProblem(validator, inBuffer.span);
  // Not a pattern on its own (`setcps(0.5)`, a variable): nothing to judge, so nothing to fix.
  const alone = await checkAlone(validator, buffer, range);
  return alone.ok ? eventProblem(validator, alone.span ?? alone) : null;
}

function eventProblem(validator: DiagnoseInput['validator'], events: { eventCount: number; sounds: string[] }): FixError | null {
  if (events.eventCount === 0) return { stage: 'silent', message: 'This code runs but makes no sound.' };
  const unknown = events.sounds.filter((s) => !validator.hasSound(s));
  if (unknown.length) {
    return { stage: 'unknown-sample', message: `${unknown.map((s) => `\`${s}\``).join(', ')} ${unknown.length > 1 ? 'are not loaded sounds' : 'is not a loaded sound'}.` };
  }
  return null;
}
