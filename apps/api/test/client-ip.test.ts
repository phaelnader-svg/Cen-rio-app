import { afterAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { buildClientIpConfig, knownClientIp } from '../src/core/client-ip';
import { createTestApp } from './helpers';

/**
 * Auditoria C3 — IP real do cliente: só o proxy declarado em TRUST_PROXY é confiável, e só
 * como salto imediato; cabeçalhos forjados pelo cliente nunca viram o IP real.
 */
const apps: App[] = [];
afterAll(async () => {
  for (const a of apps) await a.close();
});

async function appWith(trustProxy: string, extra: Record<string, string> = {}) {
  const app = await createTestApp({ TRUST_PROXY: trustProxy, ...extra });
  // Rota de inspeção fora de /api (sem regra de acesso): mostra o que a API concluiu.
  app.app.get('/__teste/ip', (request) => ({ ip: request.ip, known: knownClientIp(request) }));
  apps.push(app);
  return app;
}

async function seen(app: App, remoteAddress: string, xff?: string) {
  const r = await app.app.inject({
    method: 'GET',
    url: '/__teste/ip',
    remoteAddress,
    headers: xff ? { 'x-forwarded-for': xff } : {},
  });
  return r.json() as { ip: string; known: string | null };
}

const PROXY = '172.28.0.250';

describe('IP do cliente atrás do proxy confiável', () => {
  it('proxy confiável: usa só o endereço informado por ele (último salto), nunca valores anteriores', async () => {
    const app = await appWith(PROXY);
    expect(await seen(app, PROXY, '198.51.100.7')).toEqual({
      ip: '198.51.100.7',
      known: '198.51.100.7',
    });
    // Cliente forjou X-Forwarded-For e o proxy acrescentou o IP real: o forjado é ignorado.
    expect(await seen(app, PROXY, '6.6.6.6, 198.51.100.7')).toEqual({
      ip: '198.51.100.7',
      known: '198.51.100.7',
    });
    // Cadeia em que o "cliente" se diz o próprio proxy: continua um salto só.
    expect((await seen(app, PROXY, `6.6.6.6, ${PROXY}`)).ip).toBe(PROXY);
  });

  it('conexão direta de quem não é o proxy: X-Forwarded-For forjado é ignorado', async () => {
    const app = await appWith(PROXY);
    expect(await seen(app, '203.0.113.9', '1.2.3.4')).toEqual({
      ip: '203.0.113.9',
      known: '203.0.113.9',
    });
    // Vizinho da mesma rede interna, mas não o proxy declarado.
    expect((await seen(app, '172.28.0.3', '1.2.3.4')).ip).toBe('172.28.0.3');
  });

  it('proxy confiável sem X-Forwarded-For: IP desconhecido (nunca o do próprio proxy)', async () => {
    const app = await appWith(PROXY);
    expect(await seen(app, PROXY)).toEqual({ ip: PROXY, known: null });
  });

  it('sem TRUST_PROXY (proxy do Next em desenvolvimento): loopback é desconhecido; XFF ignorado', async () => {
    const app = await appWith('false');
    expect(await seen(app, '127.0.0.1', '198.51.100.7')).toEqual({ ip: '127.0.0.1', known: null });
    expect(await seen(app, '::ffff:127.0.0.1')).toEqual({ ip: '::ffff:127.0.0.1', known: null });
    expect(await seen(app, '203.0.113.9', '1.2.3.4')).toEqual({
      ip: '203.0.113.9',
      known: '203.0.113.9',
    });
  });

  it('homologação/produção: TRUST_PROXY=true é ignorado (X-Forwarded-For não vira IP real)', async () => {
    const app = await appWith('true', {
      APP_ENV: 'staging',
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      ALLOWED_ORIGINS: 'https://homolog.example',
    });
    expect(await seen(app, '203.0.113.9', '1.2.3.4')).toEqual({
      ip: '203.0.113.9',
      known: '203.0.113.9',
    });
    expect(app.ctx.clientIp.trust).toBe(false);
    expect(app.ctx.clientIp.warnings.join(' ')).toMatch(/TRUST_PROXY=true foi IGNORADO/);
  });
});

describe('avisos de configuração na partida', () => {
  const strict = { APP_ENV: 'staging' as const };
  it('homologação/produção sem proxy confiável: aviso explícito, sem impedir a partida', () => {
    for (const APP_ENV of ['staging', 'production'] as const) {
      const c = buildClientIpConfig({ APP_ENV, TRUST_PROXY: false });
      expect(c.trust).toBe(false);
      expect(c.warnings).toHaveLength(1);
      expect(c.warnings[0]).toMatch(/IP real dos clientes é desconhecido/);
    }
  });
  it('faixa inteira de rede gera aviso; endereço exato não', () => {
    expect(buildClientIpConfig({ ...strict, TRUST_PROXY: '172.28.0.0/24' }).warnings[0]).toMatch(
      /FAIXA inteira/,
    );
    expect(buildClientIpConfig({ ...strict, TRUST_PROXY: PROXY }).warnings).toEqual([]);
  });
  it('desenvolvimento e teste não emitem aviso; endereço inválido é recusado', () => {
    expect(buildClientIpConfig({ APP_ENV: 'development', TRUST_PROXY: false }).warnings).toEqual(
      [],
    );
    expect(() => buildClientIpConfig({ ...strict, TRUST_PROXY: 'proxy.local' })).toThrow(
      /endereço inválido/,
    );
    expect(() => buildClientIpConfig({ ...strict, TRUST_PROXY: '10.0.0.1/40' })).toThrow(
      /prefixo inválido/,
    );
  });
  it('a função de confiança só aceita o salto 0 vindo do proxy', () => {
    const { trust } = buildClientIpConfig({ ...strict, TRUST_PROXY: `${PROXY},::1` });
    expect(trust && trust(PROXY, 0)).toBe(true);
    expect(trust && trust(`::ffff:${PROXY}`, 0)).toBe(true);
    expect(trust && trust(PROXY, 1)).toBe(false);
    expect(trust && trust('172.28.0.3', 0)).toBe(false);
    expect(trust && trust('::1', 0)).toBe(true);
  });
});
