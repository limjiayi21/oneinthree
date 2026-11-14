// Tests cover pure modules only (decision model, gaze mapping), so they run in plain Node with no
// Cloudflare plugin (vitest prefers this file over vite.config.ts).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['worker/**/*.test.ts', 'shared/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
  },
});
