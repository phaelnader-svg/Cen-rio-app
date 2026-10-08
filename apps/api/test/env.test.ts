import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  ALLOWED_ORIGINS: 'http://localhost:3000',
  TOKEN_HASH_SECRET: 'x'.repeat(40),
};

describe('Validação de ambiente', () => {
  it('aceita configuração mínima de desenvolvimento', () => {
    const env = loadEnv(base);
    expect(env.APP_ENV).toBe('development');
    expect(env.TRUST_PROXY).toBe(false);
  });

  it('rejeita segredo curto e URL de banco inválida', () => {
    expect(() => loadEnv({ ...base, TOKEN_HASH_SECRET: 'curto' })).toThrow(/TOKEN_HASH_SECRET/);
    expect(() => loadEnv({ ...base, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
  });

  it('homologação/produção exigem HTTPS, cookies seguros e NODE_ENV=production', () => {
    expect(() => loadEnv({ ...base, APP_ENV: 'production', NODE_ENV: 'production' })).toThrow(
      /COOKIE_SECURE/,
    );
    expect(() =>
      loadEnv({ ...base, APP_ENV: 'staging', NODE_ENV: 'production', COOKIE_SECURE: 'true' }),
    ).toThrow(/HTTPS/);
    const prod = loadEnv({
      ...base,
      APP_ENV: 'production',
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      ALLOWED_ORIGINS: 'https://gestao.exemplo.com.br',
      TRUST_PROXY: 'loopback',
    });
    expect(prod.TRUST_PROXY).toBe('loopback');
  });
});
