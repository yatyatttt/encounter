import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src/web') } },
  build: { outDir: '../../dist', emptyOutDir: true },
  // Require the slash so the frontend module /api.ts stays with Vite.
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api/': 'http://127.0.0.1:8787' } },
  test: { root: '.', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
});
