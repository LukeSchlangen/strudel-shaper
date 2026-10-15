import { describe, expect, it } from 'vitest';
import { isRangeIntact, mapRange, splice } from '../src/splice';
import { STARTER_CODE } from '../src/options';

const HH = 's("hh*8").gain(0.6)';
const hhRange = () => {
  const from = STARTER_CODE.indexOf(HH);
  return { from, to: from + HH.length };
};

describe('splice', () => {
  it('replaces the range and leaves the rest of the buffer alone', () => {
    const out = splice(STARTER_CODE, hhRange(), 's("~ hh").gain(0.6)');
    expect(out).toContain('  s("~ hh").gain(0.6),\n');
    expect(out).not.toContain(HH);
    expect(out.startsWith('setcps(0.5)\nstack(\n  s("bd*4"),\n')).toBe(true);
    expect(out.endsWith('.lpf(800)\n)')).toBe(true);
  });

  it('handles empty ranges and empty replacements', () => {
    expect(splice('abc', { from: 1, to: 1 }, 'X')).toBe('aXbc');
    expect(splice('abc', { from: 0, to: 3 }, '')).toBe('');
  });

  it('rejects ranges outside the buffer', () => {
    expect(() => splice('abc', { from: 2, to: 5 }, 'x')).toThrow(RangeError);
    expect(() => splice('abc', { from: 2, to: 1 }, 'x')).toThrow(RangeError);
  });
});

describe('range invalidation', () => {
  const range = { from: 10, to: 20 };

  it('keeps the range when nothing changed', () => {
    expect(mapRange(range, [])).toEqual(range);
  });

  it('shifts the range for edits before it', () => {
    expect(mapRange(range, [{ fromA: 0, toA: 0, insertedLength: 3 }])).toEqual({ from: 13, to: 23 });
    expect(mapRange(range, [{ fromA: 2, toA: 6, insertedLength: 0 }])).toEqual({ from: 6, to: 16 });
  });

  it('ignores edits after it', () => {
    expect(mapRange(range, [{ fromA: 25, toA: 30, insertedLength: 1 }])).toEqual(range);
  });

  it('treats insertions exactly at the boundaries as outside', () => {
    expect(mapRange(range, [{ fromA: 10, toA: 10, insertedLength: 2 }])).toEqual({ from: 12, to: 22 });
    expect(mapRange(range, [{ fromA: 20, toA: 20, insertedLength: 2 }])).toEqual(range);
  });

  it('invalidates on edits inside or overlapping the range', () => {
    expect(mapRange(range, [{ fromA: 15, toA: 15, insertedLength: 1 }])).toBeNull();
    expect(mapRange(range, [{ fromA: 12, toA: 14, insertedLength: 0 }])).toBeNull();
    expect(mapRange(range, [{ fromA: 5, toA: 11, insertedLength: 0 }])).toBeNull();
    expect(mapRange(range, [{ fromA: 19, toA: 25, insertedLength: 4 }])).toBeNull();
    expect(mapRange(range, [{ fromA: 0, toA: 30, insertedLength: 30 }])).toBeNull();
  });

  it('accumulates several edits', () => {
    const edits = [
      { fromA: 0, toA: 1, insertedLength: 3 },
      { fromA: 5, toA: 5, insertedLength: 1 },
      { fromA: 22, toA: 22, insertedLength: 9 },
    ];
    expect(mapRange(range, edits)).toEqual({ from: 13, to: 23 });
  });

  it('checks the text at a range', () => {
    expect(isRangeIntact(STARTER_CODE, hhRange(), HH)).toBe(true);
    expect(isRangeIntact(STARTER_CODE.replace('hh*8', 'hh*4'), hhRange(), HH)).toBe(false);
    expect(isRangeIntact('short', hhRange(), HH)).toBe(false);
  });
});
