import { defineConfig } from 'vitest/config';

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
    server: {
      // @kabelsalat/web's "main" entry doesn't load under plain Node ESM; let Vite resolve its "module" entry.
      deps: { inline: [/@strudel\//, /@kabelsalat\//] },
    },
  },
});
