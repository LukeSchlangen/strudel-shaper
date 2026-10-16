import { describe, expect, it } from 'vitest';
import { diffSegments, type DiffSegment } from '../src/diff';

const rebuild = (segs: DiffSegment[], skip: DiffSegment['kind']) =>
  segs.filter((s) => s.kind !== skip).map((s) => s.text).join('');

describe('diffSegments', () => {
  it('shows an appended transform as one insertion', () => {
    expect(diffSegments('s("hh*8").gain(0.6)', 's("hh*8").gain(0.6).fast(2)')).toEqual([
      { kind: 'same', text: 's("hh*8").gain(0.6)' },
      { kind: 'ins', text: '.fast(2)' },
    ]);
  });

  it('shows changed numbers as a deletion followed by an insertion', () => {
    const segs = diffSegments('s("hh*8").gain(0.6)', 's("hh*16").gain(0.3)');
    expect(segs.filter((s) => s.kind !== 'same')).toEqual([
      { kind: 'del', text: '8' },
      { kind: 'ins', text: '16' },
      { kind: 'del', text: '6' },
      { kind: 'ins', text: '3' },
    ]);
  });

  it('returns a single same segment for identical input', () => {
    expect(diffSegments('s("bd*4")', 's("bd*4")')).toEqual([{ kind: 'same', text: 's("bd*4")' }]);
  });

  it('rebuilds both sides exactly, whitespace included', () => {
    const cases: Array<[string, string]> = [
      ['stack(\n  s("bd*4"),\n  s("hh*8")\n)', 'stack(\n  s("bd*4").fast(2),\n    s("hh*16")\n)'],
      ['note("c2  eb2")', 'note("c2 eb2 g1").rev()'],
      ['', 's("bd")'],
    ];
    for (const [before, after] of cases) {
      const segs = diffSegments(before, after);
      expect(rebuild(segs, 'ins')).toBe(before);
      expect(rebuild(segs, 'del')).toBe(after);
    }
  });
});

describe('character diffs (minimal fixes)', () => {
  it('a one-character fix is exactly one insertion of that character', () => {
    expect(diffSegments('s("hh*8).gain(0.6)', 's("hh*8").gain(0.6)', 'char')).toEqual([
      { kind: 'same', text: 's("hh*8' },
      { kind: 'ins', text: '"' },
      { kind: 'same', text: ').gain(0.6)' },
    ]);
  });

  it('a word diff would hide it inside a changed word; the char diff marks just the letters', () => {
    const word = diffSegments('s("hh*8").gian(0.6)', 's("hh*8").gain(0.6)').filter((s) => s.kind !== 'same');
    expect(word.map((s) => s.text)).toEqual(['gian', 'gain']);
    const char = diffSegments('s("hh*8").gian(0.6)', 's("hh*8").gain(0.6)', 'char').filter((s) => s.kind !== 'same');
    expect(char.map((s) => s.text).join('').length).toBe(2);
  });

  it('a deleted stray bracket is one deletion', () => {
    expect(diffSegments('s("hh*8[").gain(0.6)', 's("hh*8").gain(0.6)', 'char').filter((s) => s.kind !== 'same')).toEqual([{ kind: 'del', text: '[' }]);
  });

  it('whitespace-only changes are shown with visible markers, and still rebuild exactly', () => {
    const before = 'stack(s("bd"),s("hh"))';
    const after = 'stack(s("bd"),\n  s("hh"))';
    const segs = diffSegments(before, after, 'char');
    expect(segs.find((s) => s.kind === 'ins')).toEqual({ kind: 'ins', text: '\n  ', shown: '⏎\n··' });
    expect(rebuild(segs, 'del')).toBe(after);
    expect(rebuild(segs, 'ins')).toBe(before);
  });

  it('falls back to the word diff when the char diff is noise (a rewrite)', () => {
    const before = 's("hh*8").gain(0.6)';
    const after = 'n("0 [2 4] <5 7> 4").scale("D:dorian").s("square").lpf(1800)';
    expect(diffSegments(before, after, 'char')).toEqual(diffSegments(before, after, 'word'));
  });
});
