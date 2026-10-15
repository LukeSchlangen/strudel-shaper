import { describe, expect, it } from 'vitest';
import { InstructionHistory } from '../src/instructionHistory';

describe('InstructionHistory', () => {
  it('walks older with Up and back to the draft with Down', () => {
    const h = new InstructionHistory();
    h.add('busier');
    h.add('sparser');
    expect(h.older()).toBe('sparser');
    expect(h.older()).toBe('busier');
    expect(h.older()).toBeUndefined();
    expect(h.newer()).toBe('sparser');
    expect(h.newer()).toBe('');
    expect(h.newer()).toBeUndefined();
  });

  it('keeps the last 10, deduped, and ignores empty instructions', () => {
    const h = new InstructionHistory();
    for (let i = 0; i < 12; i++) h.add(`i${i}`);
    h.add('i5');
    h.add('   ');
    const seen: string[] = [];
    for (let s = h.older(); s !== undefined; s = h.older()) seen.push(s);
    expect(seen).toEqual(['i5', 'i11', 'i10', 'i9', 'i8', 'i7', 'i6', 'i4', 'i3', 'i2']);
  });

  it('reset starts browsing from the newest again', () => {
    const h = new InstructionHistory();
    h.add('a');
    h.add('b');
    h.older();
    h.older();
    h.reset();
    expect(h.older()).toBe('b');
  });
});
