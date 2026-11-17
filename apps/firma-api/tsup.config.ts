import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  noExternal: [/^@cenario\//],
  // O banco do Firma Viva (cliente Prisma gerado) é carregado em tempo de execução.
  external: ['@firma/db'],
});
