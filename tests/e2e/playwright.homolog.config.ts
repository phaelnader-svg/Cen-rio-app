import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/**
 * Homologação LOCAL: roda contra a instância já iniciada por `scripts/homolog-local.sh iniciar`
 * (não sobe servidores nem recria banco). Lê as variáveis geradas em .homolog-local/env.
 */
const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, '../../.homolog-local/env');
if (!existsSync(file)) throw new Error('Rode antes: bash scripts/homolog-local.sh preparar');
for (const line of readFileSync(file, 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
}

export default defineConfig({
  testDir: './homolog',
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.HOMOLOG_WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
