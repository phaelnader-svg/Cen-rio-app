import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { ADMIN, Client, ORIGIN, WsClient, createTestApp, resetDatabase } from './helpers';

/**
 * Limite de requisições (auditoria P3/C3). Limites baixos via variáveis de ambiente para os
 * testes; valores reais em config/env.ts. Cada teste usa IPs próprios (contadores separados).
 */
const PROXY = '172.28.0.250';
const LIMITS = {
  RATE_LIMIT_IP_PER_MIN: '40',
  RATE_LIMIT_UNKNOWN_IP_PER_MIN: '60',
  RATE_LIMIT_SESSION_PER_MIN: '10',
  RATE_LIMIT_ANON_PER_MIN: '5',
  RATE_LIMIT_UNKNOWN_ANON_PER_MIN: '8',
};

let behindProxy: App; // TRUST_PROXY = endereço exato do proxy (homologação)
let unknownIp: App; // sem proxy confiável (Next em desenvolvimento): IP desconhecido
beforeAll(async () => {
  await resetDatabase();
  behindProxy = await createTestApp({ ...LIMITS, TRUST_PROXY: PROXY });
  unknownIp = await createTestApp({ ...LIMITS, TRUST_PROXY: 'false' });
  await unknownIp.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await behindProxy.close();
  await unknownIp.close();
});

/** Cliente que chega pelo proxy confiável vindo de `clientIp` (como o Caddy encaminha). */
function viaProxy(app: App, clientIp: string) {
  const c = new Client(app);
  c.remoteAddress = PROXY;
  c.networkHeaders = { 'x-forwarded-for': clientIp };
  return c;
}

async function login(c: Client) {
  const r = await c.post('/api/auth/login', ADMIN);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return c;
}

/** Requisição a uma rota pública com um cookie de sessão inventado. */
function randomCookie(app: App, remoteAddress: string, xff?: string) {
  return app.app.inject({
    method: 'GET',
    url: '/api/health',
    remoteAddress,
    headers: {
      cookie: `${app.ctx.cookies.session}=${crypto.randomUUID()}`,
      ...(xff ? { 'x-forwarded-for': xff } : {}),
    },
  });
}

describe('Limite de requisições — IP real conhecido (atrás do proxy confiável)', () => {
  it('cookies aleatórios não criam contadores novos: caem no contador anônimo do IP', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++)
      codes.push((await randomCookie(behindProxy, PROXY, '198.51.100.10')).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    const blocked = await randomCookie(behindProxy, PROXY, '198.51.100.10');
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Outro cliente (outro IP real) não é afetado.
    expect((await randomCookie(behindProxy, PROXY, '198.51.100.11')).statusCode).toBe(200);
  });

  it('sessões válidas distintas no mesmo IP têm contadores próprios (painel no limite não bloqueia tablets)', async () => {
    const a = await login(viaProxy(behindProxy, '198.51.100.20'));
    const b = await login(viaProxy(behindProxy, '198.51.100.20'));
    for (let i = 0; i < 10; i++) expect((await a.get('/api/auth/me')).status).toBe(200);
    expect((await a.get('/api/auth/me')).status).toBe(429);
    expect((await b.get('/api/auth/me')).status).toBe(200);
  });

  it('teto por IP: muitas sessões atrás do mesmo IP público somam até o teto; outro IP segue livre', async () => {
    const office = '198.51.100.30';
    const sessions = [];
    // 5 logins (anônimos: exatamente o limite anônimo do IP) já contam no teto de 40.
    for (let i = 0; i < 5; i++) sessions.push(await login(viaProxy(behindProxy, office)));
    let ok = 0;
    for (let i = 0; i < 35; i++) {
      const r = await sessions[i % sessions.length]!.get('/api/auth/me');
      if (r.status === 200) ok++;
    }
    expect(ok).toBe(35); // 7 por sessão (< 10): só o teto por IP limita
    expect((await sessions[0]!.get('/api/auth/me')).status).toBe(429);
    const elsewhere = await login(viaProxy(behindProxy, '198.51.100.31'));
    expect((await elsewhere.get('/api/auth/me')).status).toBe(200);
  });

  it('X-Forwarded-For forjado por quem não é o proxy é ignorado: o contador é o da conexão', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++)
      codes.push((await randomCookie(behindProxy, '203.0.113.40', `10.9.${i}.1`)).statusCode);
    expect(codes.at(-1)).toBe(429);
    // Pelo proxy, um valor forjado ANTES do IP real também não muda o contador.
    const forged: number[] = [];
    for (let i = 0; i < 6; i++)
      forged.push(
        (await randomCookie(behindProxy, PROXY, `10.8.${i}.1, 198.51.100.41`)).statusCode,
      );
    expect(forged).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it('proxy confiável sem X-Forwarded-For: contador global, nunca o IP do próprio proxy', async () => {
    const r = await behindProxy.app.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress: PROXY,
    });
    expect(r.statusCode).toBe(200);
  });
});

describe('Limite de requisições — IP desconhecido (sem proxy confiável)', () => {
  it('WebSocket isento do limite da sessão: conecta mesmo com a sessão no limite', async () => {
    const c = await login(new Client(unknownIp));
    for (let i = 0; i < 10; i++) await c.get('/api/auth/me');
    expect((await c.get('/api/auth/me')).status).toBe(429);
    const ws = await WsClient.connect(unknownIp, c);
    await ws.waitFor((m) => m.kind === 'hello');
    await ws.close();
  });

  it('anônimos compartilham um contador global, mas sessões válidas seguem atendidas', async () => {
    const valid = await login(new Client(unknownIp)); // mais 1 anônimo (login)
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await randomCookie(unknownIp, '127.0.0.1')).statusCode);
    expect(codes.at(-1)).toBe(429); // 1 + 8 > 8
    expect((await valid.get('/api/auth/me')).status).toBe(200);
  });

  it('tentativas de upgrade sem sessão válida contam no teto (não ficam ilimitadas)', async () => {
    const statuses = new Set<number>();
    for (let i = 0; i < 70; i++) {
      const r = await unknownIp.app.inject({
        method: 'GET',
        url: '/api/realtime',
        remoteAddress: '127.0.0.1',
        headers: {
          origin: ORIGIN,
          connection: 'Upgrade',
          upgrade: 'websocket',
          cookie: `${unknownIp.ctx.cookies.session}=${crypto.randomUUID()}`,
        },
      });
      statuses.add(r.statusCode);
    }
    expect(statuses.has(401)).toBe(true);
    expect(statuses.has(429)).toBe(true); // teto global de 60 atingido
  });
});
