// The eval's validation realm: a worker_threads worker running src/sandbox.ts, speaking the same
// messages as src/validator.worker.ts, so WorkerBackend can time out and replace it.
import { parentPort } from 'node:worker_threads';
import { createRunner } from './vite-runner.mjs';

const runner = await createRunner();
const { Sandbox } = await runner.import('/src/sandbox.ts');
const sandbox = await Sandbox.create();
const post = (msg) => parentPort.postMessage(msg);

parentPort.on('message', async (data) => {
  if (data.type === 'init') {
    post({ type: 'ready', stubbed: sandbox.installStubs(data.stubs) });
    return;
  }
  post({ type: 'result', id: data.id, result: await sandbox.check(data.code, data.cps, data.span) });
});
