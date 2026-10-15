import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { ensureSyntaxTree } from '@codemirror/language';
import { captureRange } from '../src/capture';
import { STARTER_CODE } from '../src/options';

function stateAt(anchor: number, head = anchor, doc = STARTER_CODE) {
  const state = EditorState.create({ doc, selection: { anchor, head }, extensions: javascript() });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

const text = (state: EditorState) => {
  const r = captureRange(state);
  return state.doc.sliceString(r.from, r.to);
};

/** Cursor at `offset` characters into the first occurrence of `needle`. */
const at = (needle: string, offset = 0) => STARTER_CODE.indexOf(needle) + offset;

describe('captureRange', () => {
  it('uses a non-empty selection as is', () => {
    expect(text(stateAt(at('"bd*4"'), at('"bd*4"', 6)))).toBe('"bd*4"');
  });

  it('picks the expression on the cursor line, without indent or trailing comma', () => {
    expect(text(stateAt(at('bd*4')))).toBe('s("bd*4")');
    expect(text(stateAt(at('gain')))).toBe('s("hh*8").gain(0.6)');
    expect(text(stateAt(at('lpf')))).toBe('note("c2 [~ c2] eb2 g1").s("sawtooth").lpf(800)');
    expect(text(stateAt(at('setcps')))).toBe('setcps(0.5)');
  });

  it('works from the indent and from after the comma', () => {
    const line = STARTER_CODE.split('\n')[3]; // '  s("hh*8").gain(0.6),'
    const lineStart = at(line);
    expect(text(stateAt(lineStart))).toBe('s("hh*8").gain(0.6)');
    expect(text(stateAt(lineStart + line.length))).toBe('s("hh*8").gain(0.6)');
  });

  it('falls back to the trimmed line when no expression fits on it', () => {
    expect(text(stateAt(at('stack(', 3)))).toBe('stack(');
  });

  it('prefers the expression under the cursor when a line has several', () => {
    const doc = 'stack(s("bd"), s("hh"))\ns("bd"), s("hh*2")';
    const second = doc.indexOf('s("hh*2")') + 2;
    expect(text(stateAt(second, second, doc))).toBe('s("hh*2")');
  });
});
