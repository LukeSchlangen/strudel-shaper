import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    // One instance of each, shared by @strudel/codemirror and our own code.
    dedupe: ['@codemirror/state', '@codemirror/view', '@codemirror/commands', '@strudel/core'],
  },
  test: {
    environment: 'node',
  },
});
