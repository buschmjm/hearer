import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The API server listens on 5055 in development; `pnpm dev` starts both.
const API_TARGET = process.env.API_TARGET ?? 'http://localhost:5055';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': { target: API_TARGET, changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: false },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['test/setup.ts'],
    css: false,
  },
});
