import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // One instance of each, shared by @strudel/codemirror and our own code.
    dedupe: [
      '@codemirror/state',
      '@codemirror/view',
      '@codemirror/commands',
      '@codemirror/language',
      '@strudel/core',
      '@strudel/webaudio',
      'superdough',
    ],
  },
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
