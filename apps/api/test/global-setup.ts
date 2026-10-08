import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

/**
 * Prepara o banco de teste do zero: apaga o schema e aplica TODAS as migrations
 * versionadas com `prisma migrate deploy` (o mesmo comando usado em produção).
 * Isso valida, a cada execução, que as migrations sobem num banco vazio.
 */
export default async function setup() {
  const envFile = resolve(__dirname, '../../../.env');
  const fileEnv: Record<string, string> = {};
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) fileEnv[m[1]!] = m[2]!;
    }
  }
  const url = process.env.TEST_DATABASE_URL ?? fileEnv.TEST_DATABASE_URL;
  const mainUrl = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL não definido.');
  if (url === mainUrl) throw new Error('Recusado: TEST_DATABASE_URL é igual ao DATABASE_URL.');
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error('Recusado: o nome do banco de teste precisa conter "test".');
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await client.end();

  const dbDir = resolve(__dirname, '../../../packages/db');
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: dbDir,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
