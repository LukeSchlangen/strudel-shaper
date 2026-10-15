/// <reference lib="webworker" />
import { Sandbox } from './sandbox';
import type { WorkerRequest, WorkerResponse } from './validator';

/**
 * The validation realm: its own globals, Pattern.prototype and repl, and no DOM, AudioContext or
 * soundMap. The main thread's WorkerBackend sends `init` once (the stub names), waits for `ready`,
 * then sends one `check` at a time and terminates this worker if a check takes too long.
 */
const post = (msg: WorkerResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
const sandbox = Sandbox.create();

self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  const box = await sandbox;
  if (data.type === 'init') {
    post({ type: 'ready', stubbed: box.installStubs(data.stubs) });
    return;
  }
  post({ type: 'result', id: data.id, result: await box.check(data.code, data.cps, data.span) });
};
