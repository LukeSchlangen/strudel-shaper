/** A half-open character range [from, to) into a buffer. */
export interface Range {
  from: number;
  to: number;
}

/** A selection captured with Cmd/Ctrl+K: its text, its range, and the buffer it was taken from. */
export interface Capture {
  range: Range;
  text: string;
  buffer: string;
}

/** One change in old-document coordinates, as reported by CodeMirror's ChangeSet.iterChanges. */
export interface Edit {
  fromA: number;
  toA: number;
  insertedLength: number;
}

export function splice(buffer: string, range: Range, replacement: string): string {
  if (range.from < 0 || range.to > buffer.length || range.from > range.to) {
    throw new RangeError(`range ${range.from}-${range.to} is outside buffer of length ${buffer.length}`);
  }
  return buffer.slice(0, range.from) + replacement + buffer.slice(range.to);
}

export function isRangeIntact(doc: string, range: Range, expected: string): boolean {
  return range.to <= doc.length && doc.slice(range.from, range.to) === expected;
}

/**
 * Carry a captured range through a set of edits. Edits that touch the inside of the range
 * invalidate it (returns null). Edits entirely before it shift it; edits after it are ignored.
 * An insertion exactly at either boundary is treated as outside the range.
 */
export function mapRange(range: Range, edits: Edit[]): Range | null {
  let shift = 0;
  for (const { fromA, toA, insertedLength } of edits) {
    const isInsertion = fromA === toA;
    if (isInsertion ? fromA > range.from && fromA < range.to : fromA < range.to && toA > range.from) {
      return null;
    }
    if (toA <= range.from) {
      shift += insertedLength - (toA - fromA);
    }
  }
  return { from: range.from + shift, to: range.to + shift };
}
