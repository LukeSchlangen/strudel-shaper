import { describe, expect, it } from 'vitest';
import { formatCode, mapOffset } from '../src/format';

describe('formatCode', () => {
  it('wraps long chains one call per line', async () => {
    const out = await formatCode(`$: s("bd sd hh oh").fast(2).swingBy(0.15, 4).decay(0.1).diode(1).lpf(1000).gain(0.8).room(0.3)`);
    expect(out.split('\n').length).toBeGreaterThan(3);
    expect(out.split('\n').every((l) => l.length <= 80)).toBe(true);
  });

  it('never changes quotes: single stays single, double stays double, backticks stay', async () => {
    const src = `$: s('bd sd').fast(2)\n$: s("bd sd")\n$: s(\`bd\n sd\`)\nsamples('github:a/b/c')`;
    const out = await formatCode(src);
    expect(out).toContain(`s('bd sd')`);
    expect(out).toContain(`s("bd sd")`);
    expect(out).toContain('`bd\n sd`');
    expect(out).toContain(`samples('github:a/b/c')`);
  });

  it('keeps comments, labels and blank lines', async () => {
    const out = await formatCode(`// it's a "comment"\nsetcpm(135/4)\n\n\n$: s("bd")  // trailing 'x'\n/* block */`);
    expect(out).toContain(`// it's a "comment"`);
    expect(out).toContain(`// trailing 'x'`);
    expect(out).toContain('/* block */');
    expect(out).toContain('setcpm(135 / 4)');
    expect(out).toContain('$: s("bd")');
    expect(out).not.toMatch(/\n\n\n/);
  });

  it('is stable when run twice', async () => {
    const once = await formatCode(`stack(s("bd*4"), s("hh*8").gain(0.6), note("c2 [~ c2] eb2 g1").s("sawtooth").lpf(800).decay(.2))`);
    expect(await formatCode(once)).toBe(once);
  });

  it('rejects broken code without touching it', async () => {
    await expect(formatCode(`s("bd".fast(2)`)).rejects.toThrow();
  });
});

describe('mapOffset', () => {
  it('follows the same token across reformatting', () => {
    const a = 's("bd").fast(2)';
    const b = 's("bd")\n  .fast(2)';
    expect(b.slice(mapOffset(a, a.indexOf('fast'), b))).toBe('fast(2)');
  });
});
