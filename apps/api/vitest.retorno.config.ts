import { defineConfig } from 'vitest/config';

/**
 * Preparação da homologação integrada — só para criar o banco LOCAL representativo usado no teste
 * da versão de retorno (`test/retorno-integrado.check.ts`). Sem global setup. Nunca aponte para um
 * banco real.
 */
export default defineConfig({
  test: {
    include: ['test/retorno-integrado.check.ts'],
    setupFiles: ['test/setup-env.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
