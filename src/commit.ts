import { isolateHistory } from '@codemirror/commands';
import type { TransactionSpec } from '@codemirror/state';
import type { Range } from './splice';

/**
 * One transaction that replaces the captured range and selects the new text.
 * isolateHistory keeps it from merging with neighbouring edits, so a single undo restores the original.
 */
export function commitSpec(range: Range, insert: string): TransactionSpec {
  return {
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from, head: range.from + insert.length },
    annotations: isolateHistory.of('full'),
    userEvent: 'input.shaper.commit',
    scrollIntoView: true,
  };
}
