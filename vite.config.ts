import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import type { Plugin } from 'vite';

/**
 * Dev only: `await __shaper.saveScope()` in the page POSTs the live scope and sound names here, and
 * they're written to src/generated/ (inputs to `npm run build:reference` and the eval harness).
 */
const saveScope = (): Plugin => ({
  name: 'shaper-save-scope',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__shaper/scope', (req, res) => {
      if (req.method !== 'POST') return void res.writeHead(405).end();
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { globals, methods, sounds } = JSON.parse(body);
        const out = (name: string, value: unknown) =>
          writeFileSync(fileURLToPath(new URL(`./src/generated/${name}`, import.meta.url)), JSON.stringify(value, null, 1) + '\n');
        out('scope.json', { globals: [...globals].sort(), methods: [...methods].sort() });
        out('sounds.json', sounds);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ globals: globals.length, methods: methods.length, sounds: sounds.length }));
      });
    });
  },
});

export default defineConfig({
  plugins: [saveScope()],
  resolve: {
    // One instance of each, shared by @strudel/codemirror and our own code.
    dedupe: [
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/commands',
      '@codemirror/language',
      '@strudel/core',
      '@strudel/webaudio',
      '@strudel/codemirror',
      'superdough',
    ],
  },
  // The validation worker (src/validator.worker.ts) imports Strudel, which code-splits.
  worker: { format: 'es' },
  // The model proxy (server/, started by `npm run dev`) holds the API key; the browser only sees /api.
  server: { proxy: { '/api': `http://127.0.0.1:${process.env.PORT ?? 8787}` } },
  test: {
    environment: 'node',
    // Under Node, @kabelsalat/web resolves to its CJS "main", which lacks SalatRepl (needed by core's
    // repl(), which the validation sandbox constructs). Its ESM "module" entry has it.
    alias: { '@kabelsalat/web': fileURLToPath(new URL('./node_modules/@kabelsalat/web/dist/index.mjs', import.meta.url)) },
    server: {
      // @kabelsalat/web's "main" entry doesn't load under plain Node ESM; let Vite resolve its "module" entry.
      deps: { inline: [/@strudel\//, /@kabelsalat\//] },
    },
  },
});
