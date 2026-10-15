// `node eval/runner.mjs <module.ts> [args…]`: runs the module's `main(args)` through Vite (see vite-runner.mjs).
import 'dotenv/config';
import { createRunner } from './vite-runner.mjs';

const [entry, ...args] = process.argv.slice(2);
const runner = await createRunner();
let code = 0;
try {
  const mod = await runner.import(`/${entry}`);
  await mod.main(args);
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  await runner.close();
}
process.exit(code);
