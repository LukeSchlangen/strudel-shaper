import { diffChars, diffWordsWithSpace } from 'diff';

export interface DiffSegment {
  kind: 'same' | 'ins' | 'del';
  text: string;
  /**
   * What to display, when it differs from `text`: an inserted or deleted run of only whitespace is
   * invisible on its own, so spaces show as `·` and newlines as `⏎`.
   */
  shown?: string;
}

export type DiffGranularity = 'word' | 'char';

/** A char diff with more changed runs than this is noise (a rewrite, not a fix): show the word diff instead. */
export const MAX_CHAR_CHANGES = 12;

/**
 * Diff of an option against the captured selection, for the tray cards. Word level by default;
 * `char` for minimal fixes, where the whole change is often one quote, bracket or letter that a
 * word diff would hide inside a changed word. Whitespace-preserving, so same+del rebuilds `before`
 * and same+ins rebuilds `after` exactly.
 */
export function diffSegments(before: string, after: string, granularity: DiffGranularity = 'word'): DiffSegment[] {
  if (granularity === 'char') {
    const chars = diffChars(before, after).map(toSegment);
    if (chars.filter((c) => c.kind !== 'same').length <= MAX_CHAR_CHANGES) return chars.map(showWhitespace);
  }
  return diffWordsWithSpace(before, after).map(toSegment);
}

function toSegment(c: { added?: boolean; removed?: boolean; value: string }): DiffSegment {
  return { kind: c.added ? 'ins' : c.removed ? 'del' : 'same', text: c.value };
}

function showWhitespace(seg: DiffSegment): DiffSegment {
  if (seg.kind === 'same' || /\S/.test(seg.text)) return seg;
  return { ...seg, shown: seg.text.replace(/ /g, '·').replace(/\t/g, '→').replace(/\n/g, '⏎\n') };
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
 * than a fix should. From the fix eval (NOTES.md, milestone 5): 33 working minimal fixes changed
 * 1–9 characters (p90 9), except swapped arguments (`s(0.4).gain("hh*8")` → `s("hh*8").gain(0.4)`)
 * at 18; ⌘⇧J rewrites of the same code changed 30 at the median.
 */
export const LARGE_CHANGE_CHARS = 20;
