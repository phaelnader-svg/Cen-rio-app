import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  // Pacotes do monorepo são incorporados ao bundle; dependências npm ficam externas.
  noExternal: [/^@cenario\//],
});
