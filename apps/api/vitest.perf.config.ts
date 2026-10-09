import { defineConfig } from 'vitest/config';

/** Fase 12 — testes de desempenho (manuais; não rodam no `pnpm test`). */
export default defineConfig({
  test: {
    include: ['perf/**/*.perf.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup-env.ts'],
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 900_000,
  },
});
