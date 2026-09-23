import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts (which sets root: 'web' for the frontend build).
export default defineConfig({
  root: '.',
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
