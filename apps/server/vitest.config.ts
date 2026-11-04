import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // ffmpeg-heavy upload tests can exceed the 5 s default when the whole suite runs in parallel.
    testTimeout: 20_000,
  },
});
