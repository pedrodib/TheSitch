import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ['electron'],
        input: { index: resolve('src/main/index.ts'), worker: resolve('src/main/worker.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ['electron'],
        input: resolve('src/main/preload.ts'),
        output: { format: 'cjs', entryFileNames: 'preload.js' },
      },
    },
  },
  renderer: { root: 'src/renderer', plugins: [react()] },
});
