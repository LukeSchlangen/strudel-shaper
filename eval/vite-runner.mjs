// Loads TypeScript modules under Node through Vite, with the same resolution as the tests:
// @kabelsalat/web's CJS "main" lacks SalatRepl (needed by core's repl()), so it's aliased to its
// ESM entry, and @strudel/* and @kabelsalat/* are transformed rather than externalised.
import { fileURLToPath } from 'node:url';
import { createServer, createServerModuleRunner } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function createRunner() {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    resolve: {
      alias: { '@kabelsalat/web': fileURLToPath(new URL('../node_modules/@kabelsalat/web/dist/index.mjs', import.meta.url)) },
    },
    ssr: { noExternal: [/@strudel\//, /@kabelsalat\//] },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
  return {
    import: (path) => runner.import(path),
    close: async () => {
      await runner.close();
      await server.close();
    },
  };
}
