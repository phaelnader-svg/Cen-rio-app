/**
 * LGPD (2026-11-25): pedidos sobre dados pessoais. Página pública (sem login), pedido de dentro
 * do painel (conta ou empresa inteira), lista só para o dono da plataforma, e-mails para quem
 * pediu e para o encarregado, e a regra principal: NADA é apagado sozinho.
 */
import { LEGAL_VERSION, annualRefundCents, planPriceCents } from '@cenario/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { Client, createTestApp, db, resetDatabase, loginPlatform, EMPRESA_NOVA } from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};

async function criarConta(email = 'nova@tapecaria.local') {
  const c = new Client(app);
  ok(
    await c.post('/api/auth/signup', {
      ...EMPRESA_NOVA,
      email,
      password: 'senha123',
      passwordConfirm: 'senha123',
    }),
    201,
  );
  return c;
}

const pedidoPublico = {
  name: 'Maria Cliente',
  email: 'maria@cliente.local',
  kind: 'EXCLUIR',
  requester: 'CLIENTE_TAPECARIA',
  company: 'Tapeçaria do Bairro',
  message: 'Não quero mais receber mensagens.',
};

describe('Pedido público sobre dados', () => {
  it('registra com protocolo e prazo de 15 dias, avisa quem pediu e não apaga nada', async () => {
    const antes = await db().customer.count();
    const anon = new Client(app);
    const r = ok(await anon.post('/api/v1/privacy/requests', pedidoPublico), 201);
    expect(r.protocol).toMatch(/^[0-9A-F]{8}$/);
    const dias = (new Date(r.dueAt).getTime() - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(14.9);
    expect(dias).toBeLessThan(15.1);
    const row = await db().privacyRequest.findFirstOrThrow();
    expect(row).toMatchObject({ scope: 'PUBLICO', kind: 'EXCLUIR', status: 'NOVO', companyId: 0 });
    const mail = await db().outboundEmail.findFirstOrThrow({
      where: { kind: 'lgpd-pedido-recebido' },
    });
    expect(mail.to).toBe('maria@cliente.local');
    expect(mail.text).toContain(r.protocol);
    expect(await db().customer.count()).toBe(antes);
  });

  it('valida os campos e recusa o robô do campo-isca', async () => {
    const anon = new Client(app);
    expect(
      (await anon.post('/api/v1/privacy/requests', { ...pedidoPublico, email: 'x' })).status,
    ).toBe(400);
    expect(
      (await anon.post('/api/v1/privacy/requests', { ...pedidoPublico, kind: 'QUALQUER' })).status,
    ).toBe(400);
    const robo = await anon.post('/api/v1/privacy/requests', {
      ...pedidoPublico,
      website: 'http://spam',
    });
    expect(robo.status).toBeGreaterThanOrEqual(400);
    expect(await db().privacyRequest.count()).toBe(0);
  });

  it('limita a 5 pedidos por hora no mesmo endereço', async () => {
    const anon = new Client(app);
    anon.remoteAddress = '203.0.113.9';
    for (let i = 0; i < 5; i++) ok(await anon.post('/api/v1/privacy/requests', pedidoPublico), 201);
    expect((await anon.post('/api/v1/privacy/requests', pedidoPublico)).status).toBe(429);
  });
});

describe('Pedido de dentro do painel', () => {
  it('a conta pede pelos próprios dados; só o dono da plataforma vê a lista e marca o andamento', async () => {
    const nova = await criarConta();
    const r = ok(
      await nova.post('/api/v1/privacy/my-request', { scope: 'MINHA_CONTA', kind: 'ACESSAR' }),
      201,
    );
    expect(r.protocol).toHaveLength(8);
    expect((await nova.get('/api/v1/platform/privacy-requests')).status).toBe(401);

    const admin = await loginPlatform(app);
    const list = ok(await admin.get('/api/v1/platform/privacy-requests'));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      scope: 'MINHA_CONTA',
      kind: 'ACESSAR',
      email: 'nova@tapecaria.local',
      status: 'NOVO',
      protocol: r.protocol,
    });
    ok(
      await admin.post(`/api/v1/platform/privacy-requests/${list.items[0].id}/status`, {
        status: 'ATENDIDO',
      }),
    );
    expect((await db().privacyRequest.findFirstOrThrow()).status).toBe('ATENDIDO');
  });

  it('pedir para apagar a empresa não apaga nada: a empresa e o usuário continuam lá', async () => {
    const nova = await criarConta('apagar@tapecaria.local');
    ok(await nova.post('/api/v1/privacy/my-request', { scope: 'EMPRESA', kind: 'EXCLUIR' }), 201);
    const user = await db().user.findUniqueOrThrow({ where: { email: 'apagar@tapecaria.local' } });
    expect(user.active).toBe(true);
    expect(await db().companySettings.findUnique({ where: { id: user.companyId } })).not.toBeNull();
    const audit = await db().auditLog.findFirstOrThrow({ where: { action: 'privacy.requested' } });
    expect(audit.summary).toContain('Nada foi apagado');
  });

  it('a empresa de uma conta não vê o pedido de outra (trava do banco)', async () => {
    const a = await criarConta('a@tapecaria.local');
    ok(await a.post('/api/v1/privacy/my-request', { scope: 'MINHA_CONTA', kind: 'EXCLUIR' }), 201);
    await criarConta('b@tapecaria.local');
    const b = await db().user.findUniqueOrThrow({ where: { email: 'b@tapecaria.local' } });
    const rows = await db().$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.company_id', ${String(b.companyId)}, true),
        set_config('app.bypass_rls', 'off', true)`;
      await tx.$executeRaw`SET LOCAL ROLE cenario_app`;
      return tx.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM privacy_requests`;
    });
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe('Criar conta registra o aceite dos termos', () => {
  it('a auditoria guarda a versão dos termos aceitos', async () => {
    await criarConta('termos@tapecaria.local');
    const a = await db().auditLog.findFirstOrThrow({ where: { action: 'auth.signup' } });
    expect(a.summary).toContain(`versão ${LEGAL_VERSION}`);
  });
});

describe('Devolução do plano anual (decisão do dono, 2026-11-25)', () => {
  it('meses usados pelo preço mensal, o resto volta; nunca negativo', () => {
    expect(planPriceCents('gestao', 'ANUAL')).toBe(406_980);
    expect(annualRefundCents('gestao', 0)).toBe(406_980);
    expect(annualRefundCents('gestao', 3)).toBe(406_980 - 3 * 39_900);
    expect(annualRefundCents('gestao', 2.1)).toBe(406_980 - 3 * 39_900);
    expect(annualRefundCents('gestao', 11)).toBe(0);
    expect(annualRefundCents('gestao_jogo', 1)).toBe(
      planPriceCents('gestao_jogo', 'ANUAL') - 59_900,
    );
  });
});
