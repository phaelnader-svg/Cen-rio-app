import { defineConfig, devices } from '@playwright/test';
import { E2E, rootEnv } from './env';

const env = rootEnv();
const dbUrl = env.E2E_DATABASE_URL;
if (!dbUrl) throw new Error('E2E_DATABASE_URL não definido (veja .env.example).');
const origin = `http://localhost:${E2E.webPort}`;

export default defineConfig({
  testDir: './specs',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: origin,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Fuso explícito da oficina (antes: o do sistema, UTC no contêiner de testes).
    timezoneId: 'America/Sao_Paulo',
    launchOptions: env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: env.PLAYWRIGHT_CHROMIUM_PATH }
      : undefined,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Recria o banco E2E (migrations + seed) e só então inicia a API.
      command: 'node --import tsx prepare-db.ts && node --import tsx ../../apps/api/src/server.ts',
      url: `http://localhost:${E2E.apiPort}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...env,
        APP_ENV: 'test',
        NODE_ENV: 'test',
        DATABASE_URL: dbUrl,
        API_PORT: String(E2E.apiPort),
        ALLOWED_ORIGINS: origin,
        LOG_LEVEL: 'warn',
        STORAGE_DIR: '../../storage-e2e',
        // Fase 8: relógio de teste (só aceito com APP_ENV=test) — presença em qualquer horário.
        ENABLE_TEST_CLOCK: 'true',
      },
    },
    {
      command: `cd ../../apps/web && NEXT_DIST_DIR=.next-e2e pnpm exec next start --port ${E2E.webPort}`,
      url: `${origin}/entrar`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { ...env, API_INTERNAL_URL: `http://localhost:${E2E.apiPort}` },
    },
  ],
});
