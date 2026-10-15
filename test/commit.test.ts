import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { history, undo, undoDepth } from '@codemirror/commands';
import { commitSpec } from '../src/commit';
import { STARTER_CODE } from '../src/options';

const HH = 's("hh*8").gain(0.6)';
const OPTION = 's("hh*8").gain(0.6).off(1/8, x => x.gain(0.3))';

describe('commit transaction', () => {
  it('is a single undo step, even right after typing', () => {
    let state = EditorState.create({ doc: STARTER_CODE, extensions: [history()] });
    // a recent typed edit that history would normally merge with the next change
    state = state.update({ changes: { from: 0, insert: '// ' }, userEvent: 'input.type' }).state;
    const before = state.doc.toString();
    const from = before.indexOf(HH);

    state = state.update(commitSpec({ from, to: from + HH.length }, OPTION)).state;
    expect(state.doc.toString()).toContain(OPTION);
    expect(undoDepth(state)).toBe(2);

    let undone = state;
    undo({ state, dispatch: (tr) => (undone = tr.state) });
    expect(undone.doc.toString()).toBe(before);
  });
});
