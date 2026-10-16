import { beforeAll, describe, expect, it } from 'vitest';
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import { transpiler } from '@strudel/transpiler';
import { nextBoundary, Quantizer, stitch, type SchedulerLike } from '../src/quantize';

beforeAll(async () => {
  await core.evalScope(core, mini);
});

async function pat(code: string) {
  return (await core.evaluate(code, transpiler, {})).pattern;
}

const onsets = (p: any, begin: number, end: number) =>
  p
    .queryArc(begin, end)
    .filter((h: any) => h.hasOnset())
    .map((h: any) => [h.whole.begin.valueOf(), h.value.s] as [number, string])
    .sort((a: any, b: any) => a[0] - b[0] || a[1].localeCompare(b[1]));

/** Mimics the Cyclist: queries consecutive [lastEnd, lastEnd + step) spans and keeps the onsets. */
class FakeScheduler implements SchedulerLike {
  lastEnd = 0;
  started = true;
  cps = 0.5;
  played: Array<[number, string]> = [];
  constructor(public pattern: any) {}
  now() {
    return this.lastEnd - 0.05; // the look-ahead: what's audible trails what's queued
  }
  setPattern(p: any) {
    this.pattern = p;
  }
  tickUntil(cycle: number, step = 0.025) {
    while (this.lastEnd < cycle) {
      const begin = this.lastEnd;
      this.lastEnd = begin + step; // float accumulation, like the real clock
      const haps = this.pattern.queryArc(begin, this.lastEnd, { cyclist: 'cyclist' });
      for (const h of haps) if (h.hasOnset()) this.played.push([h.whole.begin.valueOf(), h.value.s]);
    }
  }
  /** Simulates our evaluateCode: setPattern while armed. */
  swap(q: Quantizer, p: any) {
    q.armed = true;
    this.setPattern(p);
    q.armed = false;
  }
}

describe('nextBoundary', () => {
  it('rounds up to the next beat or cycle, never below lastEnd', () => {
    expect(nextBoundary(23.3, 'beat')).toBe(23.5);
    expect(nextBoundary(23.25, 'beat')).toBe(23.25); // already on a boundary: nothing after it is scheduled yet
    expect(nextBoundary(23.2500000001, 'beat')).toBe(23.5);
    expect(nextBoundary(23.2499999999, 'beat')).toBe(23.25);
    expect(nextBoundary(23.3, 'beat', 3)).toBeCloseTo(23 + 1 / 3, 12);
    expect(nextBoundary(23.4, 'beat', 3)).toBeCloseTo(23 + 2 / 3, 12);
    expect(nextBoundary(23.3, 'cycle')).toBe(24);
    expect(nextBoundary(23.3, 'immediate')).toBeNull();
    for (const x of [0.01, 1.999, 7.75, 100.0001]) {
      expect(nextBoundary(x, 'beat')!).toBeGreaterThanOrEqual(x);
      expect(nextBoundary(x, 'cycle')!).toBeGreaterThanOrEqual(x);
    }
  });
});

describe('stitch', () => {
  it('plays the old pattern before the boundary and the new one from it', async () => {
    const p = stitch(await pat('s("bd*4")'), await pat('s("hh*8")'), 1.25);
    expect(onsets(p, 1, 2)).toEqual([
      [1, 'bd'],
      [1.25, 'hh'],
      [1.375, 'hh'],
      [1.5, 'hh'],
      [1.625, 'hh'],
      [1.75, 'hh'],
      [1.875, 'hh'],
    ]);
  });

  it('gives the same onsets for many tick-sized queries as for one big query', async () => {
    const p = stitch(await pat('s("bd*4, hh*3")'), await pat('s("bd*4, oh*5")'), 2.5);
    const whole = onsets(p, 0, 5);
    const ticked: Array<[number, string]> = [];
    for (let t = 0; t < 5; t += 0.0375) ticked.push(...onsets(p, t, Math.min(t + 0.0375, 5)));
    ticked.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
    expect(ticked).toEqual(whole);
  });

  it('handles zero-width queries on either side (the Drawer does these)', async () => {
    const p = stitch(await pat('s("bd")'), await pat('s("hh")'), 1);
    expect(p.queryArc(0.5, 0.5).map((h: any) => h.value.s)).toEqual(['bd']);
    expect(p.queryArc(1, 1).map((h: any) => h.value.s)).toEqual(['hh']);
  });

  it('passes query controls through', async () => {
    const seen: any[] = [];
    const spy = new core.Pattern((state: any) => (seen.push(state.controls), []));
    stitch(spy, spy, 1).queryArc(0.5, 1.5, { painters: ['x'] });
    expect(seen).toEqual([{ painters: ['x'] }, { painters: ['x'] }]);
  });
});

describe('Quantizer', () => {
  // Kicks before cycle 3 (ticking overshoots the target slightly).
  const kicks = (played: Array<[number, string]>) =>
    played.filter(([s, x]) => x === 'bd' && s < 3).map(([t]) => t);

  it('lands a swap on the next beat with the kick grid intact', async () => {
    const s = new FakeScheduler(await pat('s("bd*4, hh*8")'));
    const q = new Quantizer(s);
    s.tickUntil(1.3);
    s.swap(q, await pat('s("bd*4, oh*8")'));
    expect(q.pending?.at).toBe(1.5);
    s.tickUntil(3);
    const hats = s.played.filter(([, x]) => x !== 'bd');
    expect(hats.filter(([, x]) => x === 'hh').every(([t]) => t < 1.5)).toBe(true);
    expect(hats.filter(([, x]) => x === 'oh').map(([t]) => t)[0]).toBe(1.5);
    expect(kicks(s.played)).toEqual(Array.from({ length: 12 }, (_, i) => i * 0.25));
  });

  it('a second press before the boundary replaces the pending choice', async () => {
    const s = new FakeScheduler(await pat('s("bd*4, hh*8")'));
    const q = new Quantizer(s);
    s.tickUntil(1.3);
    s.swap(q, await pat('s("bd*4, cp*8")'));
    const first = q.pending!;
    s.tickUntil(1.4);
    s.swap(q, await pat('s("bd*4, oh*8")'));
    expect(q.pending!.at).toBe(1.5);
    expect(q.pending!.base).toBe(first.base); // stitched from the pattern still playing, not from cp
    s.tickUntil(3);
    expect(s.played.some(([, x]) => x === 'cp')).toBe(false);
    expect(s.played.filter(([, x]) => x === 'oh')[0][0]).toBe(1.5);
    expect(kicks(s.played)).toEqual(Array.from({ length: 12 }, (_, i) => i * 0.25));
  });

  it('a press after the boundary stitches from the landed pattern, without nesting', async () => {
    const s = new FakeScheduler(await pat('s("bd*4, hh*8")'));
    const q = new Quantizer(s);
    const cp = await pat('s("bd*4, cp*8")');
    s.tickUntil(1.3);
    s.swap(q, cp);
    s.tickUntil(1.6);
    s.swap(q, await pat('s("bd*4, oh*8")'));
    expect(q.pending!.base).toBe(cp);
    expect(q.pending!.at).toBe(1.75);
    s.tickUntil(3);
    const cpTimes = s.played.filter(([, x]) => x === 'cp').map(([t]) => t);
    expect(cpTimes).toEqual([1.5, 1.625]);
    expect(kicks(s.played)).toEqual(Array.from({ length: 12 }, (_, i) => i * 0.25));
  });

  it('restoring a snapshot (fix modes) lands on the beat, and the restored pattern is the snapshot itself', async () => {
    const good = await pat('s("bd*4, hh*8")');
    const s = new FakeScheduler(good);
    const q = new Quantizer(s);
    s.tickUntil(1.1);
    const snapshot = q.playing(); // the tray opens over a broken buffer
    expect(snapshot).toBe(good);
    s.swap(q, await pat('s("bd*4, oh*8")')); // audition a fix: lands at 1.25
    s.tickUntil(1.6);
    q.swapTo(snapshot); // 0 / Esc
    expect(q.pending!.at).toBe(1.75);
    s.tickUntil(3);
    q.settle();
    expect(s.pattern).toBe(good); // no wrapper left: the restored pattern is the snapshot object
    const ohs = s.played.filter(([, x]) => x === 'oh').map(([t]) => t);
    expect(ohs[0]).toBe(1.25);
    expect(ohs.at(-1)).toBeLessThan(1.75);
    expect(s.played.filter(([t, x]) => x === 'hh' && t >= 1.75)[0][0]).toBe(1.75);
    expect(kicks(s.played)).toEqual(Array.from({ length: 12 }, (_, i) => i * 0.25));
  });

  it('a snapshot taken while a swap is pending is the pattern about to land', async () => {
    const s = new FakeScheduler(await pat('s("bd*4, hh*8")'));
    const q = new Quantizer(s);
    s.tickUntil(1.1);
    const next = await pat('s("bd*4, cp*8")');
    s.swap(q, next);
    expect(q.playing()).toBe(next);
  });

  it('many presses at random times: every kick exactly once, every swap on a beat', async () => {
    const pats = await Promise.all(['hh', 'oh', 'cp', 'rim', 'sd'].map((x) => pat(`s("bd*4, ${x}*8")`)));
    const s = new FakeScheduler(pats[0]);
    const q = new Quantizer(s);
    const rand = (() => {
      let a = 3;
      return () => ((a = (a * 16807) % 2147483647) / 2147483647);
    })();
    let t = 0.5;
    for (let i = 0; i < 30; i++) {
      t += 0.05 + rand() * 0.6;
      s.tickUntil(t);
      s.swap(q, pats[i % pats.length]);
      expect((q.pending!.at * 4) % 1).toBe(0);
    }
    s.tickUntil(t + 2);
    const end = Math.floor(s.lastEnd * 4) / 4;
    const expected = Array.from({ length: end * 4 }, (_, i) => i * 0.25);
    const allKicks = s.played.filter(([k, x]) => x === 'bd' && k < end).map(([k]) => k);
    expect(allKicks).toEqual(expected);
    // Every hat sits on the 8th grid: no stray half-onsets from the seams.
    for (const [time] of s.played) expect((time * 8) % 1).toBe(0);
  });

  it('immediate mode and outside evaluations bypass the wrapper', async () => {
    const s = new FakeScheduler(await pat('s("bd")'));
    const q = new Quantizer(s);
    const a = await pat('s("hh")');
    q.mode = 'immediate';
    s.swap(q, a);
    expect(s.pattern).toBe(a);
    q.mode = 'beat';
    s.tickUntil(0.3);
    s.swap(q, await pat('s("oh")'));
    expect(q.pending).not.toBeNull();
    const outside = await pat('s("cp")');
    s.setPattern(outside); // not armed: Ctrl+Enter
    expect(s.pattern).toBe(outside);
    expect(q.pending).toBeNull();
  });

  it('does not quantize while stopped, and settle(true) unwraps on stop', async () => {
    const s = new FakeScheduler(await pat('s("bd")'));
    const q = new Quantizer(s);
    s.tickUntil(0.3);
    const next = await pat('s("oh")');
    s.swap(q, next);
    q.settle(true);
    expect(s.pattern).toBe(next);
    s.started = false;
    const a = await pat('s("hh")');
    s.swap(q, a);
    expect(s.pattern).toBe(a);
  });

  it('cycle mode lands on the next whole cycle', async () => {
    const s = new FakeScheduler(await pat('s("bd*4, hh*8")'));
    const q = new Quantizer(s);
    q.mode = 'cycle';
    s.tickUntil(1.3);
    s.swap(q, await pat('s("bd*4, oh*8")'));
    s.tickUntil(3);
    expect(s.played.filter(([, x]) => x === 'oh')[0][0]).toBe(2);
    expect(s.played.filter(([, x]) => x === 'hh').at(-1)![0]).toBe(1.875);
  });
});
