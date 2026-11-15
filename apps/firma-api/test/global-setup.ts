import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

/** Recria do zero os bancos de teste do Firma Viva e do Cenário Gestão (migrations oficiais). */
export default async function setup() {
  const envFile = resolve(__dirname, '../../../.env');
  const fileEnv: Record<string, string> = {};
  if (existsSync(envFile))
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) fileEnv[m[1]!] = m[2]!;
    }
  const get = (k: string) => process.env[k] ?? fileEnv[k];
  const targets: [string, string, Record<string, string>][] = [
    [
      get('FIRMA_TEST_DATABASE_URL')!,
      '../../../packages/firma-db',
      { FIRMA_DATABASE_URL: get('FIRMA_TEST_DATABASE_URL')! },
    ],
    [
      get('TEST_DATABASE_URL')!,
      '../../../packages/db',
      { DATABASE_URL: get('TEST_DATABASE_URL')! },
    ],
  ];
  for (const [url, dir, env] of targets) {
    if (!url || !/test/i.test(new URL(url).pathname))
      throw new Error('Banco de teste inválido (precisa conter "test").');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await client.end();
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      cwd: resolve(__dirname, dir),
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });
  }
}
