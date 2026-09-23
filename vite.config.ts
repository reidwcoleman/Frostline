import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5317, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2022', outDir: 'dist', chunkSizeWarningLimit: 4000, assetsInlineLimit: 0 },
  worker: { format: 'es' },
});
