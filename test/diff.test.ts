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
