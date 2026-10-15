import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckResult } from '../src/sandbox';
import { VALIDATION_TIMEOUT_MS, WorkerBackend, type WorkerLike, type WorkerRequest, type WorkerResponse } from '../src/validator';

/** A fake worker whose answers the test controls. */
class FakeWorker implements WorkerLike {
  onmessage: ((e: { data: WorkerResponse }) => void) | null = null;
  received: WorkerRequest[] = [];
  terminated = false;
  postMessage(msg: WorkerRequest) {
    this.received.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: WorkerResponse) {
    this.onmessage?.({ data });
  }
  checks() {
    return this.received.filter((m): m is Extract<WorkerRequest, { type: 'check' }> => m.type === 'check');
  }
}

const ok = (n: number): CheckResult => ({ ok: true, eventCount: n, sounds: [], ms: 1 });
const stubs = { globals: ['samples'], methods: ['pianoroll'] };

let workers: FakeWorker[];
let backend: WorkerBackend;

beforeEach(() => {
  vi.useFakeTimers();
  workers = [];
  backend = new WorkerBackend(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
});
afterEach(() => vi.useRealTimers());

describe('WorkerBackend', () => {
  it('waits for ready before sending checks, then runs them one at a time in order', async () => {
    const a = backend.check('a', 0.5);
    const b = backend.check('b', 0.5);
    expect(workers[0].checks()).toHaveLength(0);
    backend.init(stubs);
    expect(workers[0].received[0]).toEqual({ type: 'init', stubs });
    workers[0].reply({ type: 'ready' });
    expect(workers[0].checks().map((c) => c.code)).toEqual(['a']);
    workers[0].reply({ type: 'result', id: workers[0].checks()[0].id, result: ok(1) });
    expect(workers[0].checks().map((c) => c.code)).toEqual(['a', 'b']);
    workers[0].reply({ type: 'result', id: workers[0].checks()[1].id, result: ok(2) });
    expect(await a).toEqual(ok(1));
    expect(await b).toEqual(ok(2));
  });

  it('times out a check that never answers, replaces the worker, and carries on', async () => {
    backend.init(stubs);
    workers[0].reply({ type: 'ready' });
    const stuck = backend.check('while(true){}', 0.5);
    const next = backend.check('s("bd")', 0.5);
    vi.advanceTimersByTime(VALIDATION_TIMEOUT_MS - 1);
    expect(workers).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(await stuck).toMatchObject({ ok: false, stage: 'timeout' });
    expect(workers[0].terminated).toBe(true);
    expect(backend.respawns).toBe(1);

    // The new worker is re-initialised with the same stubs; the queued check waits for its ready.
    expect(workers).toHaveLength(2);
    expect(workers[1].received).toEqual([{ type: 'init', stubs }]);
    workers[1].reply({ type: 'ready' });
    const [check] = workers[1].checks();
    expect(check.code).toBe('s("bd")');
    workers[1].reply({ type: 'result', id: check.id, result: ok(4) });
    expect(await next).toEqual(ok(4));
  });

  it('ignores a late answer from the terminated worker', async () => {
    backend.init(stubs);
    workers[0].reply({ type: 'ready' });
    const stuck = backend.check('slow', 0.5);
    const id = workers[0].checks()[0].id;
    vi.advanceTimersByTime(VALIDATION_TIMEOUT_MS);
    workers[0].reply({ type: 'result', id, result: ok(9) });
    expect(await stuck).toMatchObject({ stage: 'timeout' });
  });

  it('does not time out a check that answers in time', async () => {
    backend.init(stubs);
    workers[0].reply({ type: 'ready' });
    const p = backend.check('a', 0.5);
    vi.advanceTimersByTime(VALIDATION_TIMEOUT_MS - 10);
    workers[0].reply({ type: 'result', id: workers[0].checks()[0].id, result: ok(3) });
    vi.advanceTimersByTime(1000);
    expect(await p).toEqual(ok(3));
    expect(workers).toHaveLength(1);
  });
});
