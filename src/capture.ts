import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { Range } from './splice';

/**
 * What Cmd/Ctrl+K and J operate on: the selection if there is one, otherwise the expression on the
 * cursor's line (from the JS syntax tree), otherwise the trimmed line without a trailing comma.
 */
export function captureRange(state: EditorState): Range {
  const sel = state.selection.main;
  if (!sel.empty) {
    // Drop surrounding whitespace and a trailing separator (a whole-line or triple-click selection
    // picks up `,` and the newline), so they stay in the buffer and options replace just the expression.
    const text = state.doc.sliceString(sel.from, sel.to);
    const lead = text.length - text.trimStart().length;
    const core = text.slice(lead).replace(/[\s,;]+$/, '');
    if (core) return { from: sel.from + lead, to: sel.from + lead + core.length };
    return { from: sel.from, to: sel.to };
  }

  return captureAt(state, sel.head);
}

/** The trimmed line at `pos`, without a trailing comma (what capture falls back to). */
export function lineRangeAt(state: EditorState, pos: number): Range {
  const line = state.doc.lineAt(pos);
  const lead = line.text.length - line.text.trimStart().length;
  const trimmed = line.text.trim().replace(/,$/, '').trimEnd();
  return { from: line.from + lead, to: line.from + lead + trimmed.length };
}

/**
 * The expression at `pos`, as ⌘K captures it with no selection: the largest expression that fits on
 * that line (preferring the one under `pos`), else the trimmed line. ⌘J uses it at an error's position.
 */
export function captureAt(state: EditorState, pos: number): Range {
  const lineRange = lineRangeAt(state, pos);
  if (lineRange.from === lineRange.to) return { from: pos, to: pos };

  // The largest expressions that fit entirely on this line.
  const candidates: Range[] = [];
  syntaxTree(state).iterate({
    from: lineRange.from,
    to: lineRange.to,
    enter(node) {
      if (node.from < lineRange.from || node.to > lineRange.to) return; // spans other lines: look inside
      if (!node.type.is('Expression') || node.name === 'SequenceExpression') return; // `a, b`: look inside
      const coversLine = node.from === lineRange.from && node.to === lineRange.to;
      if (node.name === 'CallExpression' || coversLine) candidates.push({ from: node.from, to: node.to });
      return false;
    },
  });
  if (candidates.length === 0) return lineRange;
  const size = (r: Range) => r.to - r.from;
  return (
    candidates.find((r) => r.from <= pos && pos <= r.to) ??
    candidates.reduce((a, b) => (size(b) > size(a) ? b : a))
  );
}
