import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Carrega o .env da raiz (sem sobrescrever) e aponta tudo para o banco de TESTE. */
const envFile = resolve(__dirname, '../../../.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2];
  }
}
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('TEST_DATABASE_URL não definido.');
process.env.DATABASE_URL = testUrl;
process.env.APP_ENV = 'test';
process.env.NODE_ENV = 'test';
process.env.TOKEN_HASH_SECRET ??= 'test-secret-test-secret-test-secret-1234';
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
process.env.DISABLE_BACKGROUND_JOBS = 'true';
process.env.SEED_ADMIN_EMAIL = 'gestor@teste.local';
process.env.SEED_ADMIN_PASSWORD = 'SenhaDeTeste123';
process.env.SEED_ADMIN_NAME = 'Gestor Teste';
