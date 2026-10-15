import { diffWordsWithSpace } from 'diff';

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
