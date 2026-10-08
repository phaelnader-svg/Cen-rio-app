import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
import pg from 'pg';
import { E2E, rootEnv } from './env';

/** Banco E2E recriado do zero a cada execução: migrations + seed oficiais. */
async function prepareDatabase() {
  const env = rootEnv();
  const url = env.E2E_DATABASE_URL!;
  if (url === rootEnv(true).DATABASE_URL || !/test/i.test(new URL(url).pathname)) {
    throw new Error('Recusado: E2E_DATABASE_URL deve ser um banco exclusivo de teste.');
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await client.end();
  const dbDir = resolve(here, '../../packages/db');
  const childEnv = {
    ...env,
    DATABASE_URL: url,
    SEED_ADMIN_EMAIL: E2E.admin.email,
    SEED_ADMIN_PASSWORD: E2E.admin.password,
    SEED_ADMIN_NAME: E2E.admin.name,
  };
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: dbDir,
    env: childEnv,
    stdio: 'pipe',
  });
  execFileSync('pnpm', ['exec', 'tsx', 'src/seed.ts'], {
    cwd: dbDir,
    env: childEnv,
    stdio: 'pipe',
  });
}

prepareDatabase().catch((error: unknown) => {
  console.error('Falha ao preparar o banco E2E:', error);
  process.exit(1);
});
