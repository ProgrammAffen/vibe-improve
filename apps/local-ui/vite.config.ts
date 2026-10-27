import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/vibe-improve/',
  publicDir: fileURLToPath(new URL('../../tmp/build/public', import.meta.url)),
  cacheDir: fileURLToPath(new URL('../../tmp/cache/vite', import.meta.url)),
  build: { outDir: fileURLToPath(new URL('../../tmp/build/web', import.meta.url)), emptyOutDir: true, target: 'es2022' },
  server: { fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } }
});
