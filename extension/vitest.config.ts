import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __TARGET__: JSON.stringify('chrome') },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    pool: 'threads',
    maxWorkers: 1,
  },
});
