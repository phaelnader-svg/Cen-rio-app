import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Roteiro de homologação contra uma instância JÁ em execução (não sobe servidores nem recria
 * banco). Sem HOMOLOG_WEB_URL definido, usa a homologação local (.homolog-local/env, gerado por
 * scripts/homolog-local.sh). Para a pilha atrás do Caddy, defina HOMOLOG_WEB_URL, as credenciais
 * do gestor (SEED_ADMIN_*) e do proxy (HOMOLOG_BASIC_USER/HOMOLOG_BASIC_PASSWORD).
 */
const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, '../../.homolog-local/env');
if (!process.env.HOMOLOG_WEB_URL) {
  if (!existsSync(file)) throw new Error('Rode antes: bash scripts/homolog-local.sh preparar');
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
}
// Pilha atrás do proxy (Caddy): credenciais da autenticação adicional e, só em teste local com
// certificado interno, HOMOLOG_IGNORE_HTTPS=1.
const proxy = process.env.HOMOLOG_BASIC_USER
  ? { username: process.env.HOMOLOG_BASIC_USER, password: process.env.HOMOLOG_BASIC_PASSWORD ?? '' }
  : undefined;

export default defineConfig({
  testDir: './homolog',
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.HOMOLOG_WEB_URL,
    httpCredentials: proxy,
    ignoreHTTPSErrors: process.env.HOMOLOG_IGNORE_HTTPS === '1',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
