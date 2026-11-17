import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** .env da raiz + bancos de TESTE do Firma Viva e do Cenário Gestão (usado em processo). */
const envFile = resolve(__dirname, '../../../.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2];
  }
}
if (!process.env.FIRMA_TEST_DATABASE_URL || !process.env.TEST_DATABASE_URL)
  throw new Error('FIRMA_TEST_DATABASE_URL e TEST_DATABASE_URL são obrigatórios.');
process.env.FIRMA_DATABASE_URL = process.env.FIRMA_TEST_DATABASE_URL;
process.env.FIRMA_APP_ENV = 'test';
process.env.FIRMA_WEB_URL = 'http://localhost:3100';
process.env.CENARIO_API_URL = 'http://cenario.interno';
process.env.CENARIO_WEB_URL = 'http://localhost:3000';
process.env.FIRMA_LOG_LEVEL = 'silent';
// Cenário Gestão (em processo, banco de teste dele).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.APP_ENV = 'test';
process.env.NODE_ENV = 'test';
process.env.TOKEN_HASH_SECRET ??= 'test-secret-test-secret-test-secret-1234';
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
process.env.DISABLE_BACKGROUND_JOBS = 'true';
process.env.SEED_ADMIN_EMAIL = 'gestor@teste.local';
process.env.SEED_ADMIN_PASSWORD = 'SenhaDeTeste123';
process.env.SEED_ADMIN_NAME = 'Gestor Teste';
