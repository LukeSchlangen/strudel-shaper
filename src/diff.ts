import { diffChars, diffWordsWithSpace } from 'diff';

export interface DiffSegment {
  kind: 'same' | 'ins' | 'del';
  text: string;
}

/**
 * Word-level diff of an option against the captured selection, for the tray cards.
 * Uses the whitespace-preserving variant so same+del rebuilds `before` and same+ins rebuilds `after` exactly.
 */
export function diffSegments(before: string, after: string): DiffSegment[] {
  return diffWordsWithSpace(before, after).map((c) => ({
    kind: c.added ? 'ins' : c.removed ? 'del' : 'same',
    text: c.value,
  }));
}

/**
 * Characters inserted plus characters deleted, from a character diff: `gian`→`gain` is 2 (the
 * diff keeps one of the swapped letters), a missing quote is 1.
 */
export function changeSize(before: string, after: string): number {
  return diffChars(before, after).reduce((n, c) => (c.added || c.removed ? n + c.value.length : n), 0);
}

/**
 * Above this many changed characters, a minimal fix shows a `large change` badge: it rewrote more
 * than a fix should. Chosen from the fix eval (NOTES.md, milestone 5).
 */
export const LARGE_CHANGE_CHARS = 12;
