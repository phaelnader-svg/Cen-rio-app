import { defineConfig } from 'vitest/config';

/**
 * Evolução, Fase 8 — só para `scripts/test-evolution-migrations.sh`: roda o check sobre um banco
 * JÁ preparado (sem global setup, sem reset). Nunca aponte para um banco real.
 */
export default defineConfig({
  test: {
    include: ['test/evolution-migration.check.ts'],
    setupFiles: ['test/setup-env.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
