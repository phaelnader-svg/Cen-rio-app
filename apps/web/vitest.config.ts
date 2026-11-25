import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Mesmo atalho "@/" do tsconfig, para os testes importarem rotas do app.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
});
