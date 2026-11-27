import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Mesmo atalho "@/" do tsconfig, para os testes importarem rotas do app.
export default defineConfig({
  // Testes .tsx (renderizar a página do artigo) com o JSX automático do React.
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
});
