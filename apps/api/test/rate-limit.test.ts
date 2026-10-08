import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { createTestApp } from './helpers';

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());

describe('Limite de requisições', () => {
  it('é por sessão: um painel no limite não bloqueia os tablets atrás do mesmo IP', async () => {
    const hit = (cookie: string) =>
      app.app.inject({
        method: 'GET',
        url: '/api/health',
        remoteAddress: '127.0.0.1',
        headers: { cookie: `${app.ctx.cookies.session}=${cookie}` },
      });
    for (let i = 0; i < 600; i++) await hit('sessao-a');
    expect((await hit('sessao-a')).statusCode).toBe(429);
    // Outra sessão no mesmo IP (proxy do Next) continua atendida.
    expect((await hit('sessao-b')).statusCode).toBe(200);
  });
});
