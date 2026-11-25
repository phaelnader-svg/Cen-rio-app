/**
 * Cobrança, planos e e-mails (melhorias 1, 2, 3, 4, 5 e 7 — 2026-11-17).
 * Decisões do dono: Asaas, teste grátis de 7 dias, e-mail pelo Resend, R$ 399 e R$ 599 (com o
 * jogo), 15% no anual, bloqueio 5 dias depois do vencimento.
 */
import { addCycle, planPriceCents, subscriptionStatus } from '@cenario/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { Client, createTestApp, db, loginAdmin, loginPlatform, resetDatabase } from './helpers';

const WEBHOOK = 'token-do-webhook-de-teste-com-32-caracteres!!';
let app: App;
let asaasCalls: { method: string; url: string; body: unknown }[] = [];
let payments: {
  id: string;
  value: number;
  dueDate: string;
  status: string;
  invoiceUrl: string;
  subscription: string;
}[] = [];

beforeAll(async () => {
  app = await createTestApp({
    BILLING_ENABLED: 'true',
    ASAAS_API_KEY: 'chave-falsa',
    ASAAS_BASE_URL: 'https://asaas.teste/v3',
    ASAAS_WEBHOOK_TOKEN: WEBHOOK,
    PUBLIC_WEB_URL: 'https://painel.teste',
  });
  app.ctx.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    asaasCalls.push({ method, url, body });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (url.endsWith('/customers')) return json({ id: 'cus_1' });
    if (url.endsWith('/subscriptions') && method === 'POST') {
      const b = body as { value: number; nextDueDate: string };
      payments = [
        {
          id: `pay_${asaasCalls.length}`,
          value: b.value,
          dueDate: b.nextDueDate,
          status: 'PENDING',
          invoiceUrl: `https://asaas.teste/i/${asaasCalls.length}`,
          subscription: `sub_${asaasCalls.length}`,
        },
      ];
      return json({ id: payments[0]!.subscription });
    }
    if (/\/subscriptions\/[^/]+\/payments$/.test(url)) return json({ data: payments });
    if (method === 'DELETE') return json({ deleted: true });
    return json({});
  }) as typeof fetch;
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  asaasCalls = [];
  payments = [];
});

async function criarConta(email = 'nova@tapecaria.local') {
  const c = new Client(app);
  const r = await c.post('/api/auth/signup', {
    email,
    password: 'senha123',
    passwordConfirm: 'senha123',
  });
  expect(r.status).toBe(201);
  const user = await db().user.findUniqueOrThrow({ where: { email } });
  return { c, user, companyId: user.companyId };
}

function webhook(event: string, payment: object) {
  return new Client(app, null).post(
    '/api/webhooks/assinatura/asaas',
    { event, payment },
    { 'asaas-access-token': WEBHOOK },
  );
}

const linkDe = (text: string, path: string) => {
  const m = new RegExp(`https://painel\\.teste${path}\\?token=([A-Za-z0-9_%-]+)`).exec(text);
  return m ? decodeURIComponent(m[1]!) : null;
};

describe('Preços e situação', () => {
  it('R$ 399 e R$ 599 por mês; anual com 15% de desconto', () => {
    expect(planPriceCents('gestao', 'MENSAL')).toBe(39_900);
    expect(planPriceCents('gestao', 'ANUAL')).toBe(406_980);
    expect(planPriceCents('gestao_jogo', 'MENSAL')).toBe(59_900);
    expect(planPriceCents('gestao_jogo', 'ANUAL')).toBe(610_980);
  });

  it('situação pelas datas: teste, em dia, atrasada nos 5 dias, vencida depois', () => {
    const d = (s: string) => new Date(s);
    const now = d('2026-12-10T12:00:00Z');
    expect(subscriptionStatus({ courtesy: true, trialEndsAt: null, paidUntil: null }, now, 5)).toBe(
      'CORTESIA',
    );
    expect(
      subscriptionStatus(
        { courtesy: false, trialEndsAt: d('2026-12-11'), paidUntil: null },
        now,
        5,
      ),
    ).toBe('TESTE');
    // Fim do teste grátis não tem tolerância.
    expect(
      subscriptionStatus(
        { courtesy: false, trialEndsAt: d('2026-12-09'), paidUntil: null },
        now,
        5,
      ),
    ).toBe('VENCIDA');
    expect(
      subscriptionStatus(
        { courtesy: false, trialEndsAt: null, paidUntil: d('2026-12-20') },
        now,
        5,
      ),
    ).toBe('ATIVA');
    expect(
      subscriptionStatus(
        { courtesy: false, trialEndsAt: null, paidUntil: d('2026-12-07') },
        now,
        5,
      ),
    ).toBe('ATRASADA');
    expect(
      subscriptionStatus(
        { courtesy: false, trialEndsAt: null, paidUntil: d('2026-12-04') },
        now,
        5,
      ),
    ).toBe('VENCIDA');
    expect(addCycle(d('2027-01-31T12:00:00Z'), 'MENSAL').toISOString().slice(0, 10)).toBe(
      '2027-02-28',
    );
    expect(addCycle(d('2027-01-15T12:00:00Z'), 'ANUAL').toISOString().slice(0, 10)).toBe(
      '2028-01-15',
    );
  });
});

describe('Conta nova: teste grátis, jogo desligado e e-mail de confirmação', () => {
  it('nasce em teste grátis de 7 dias no plano básico, sem o jogo, e recebe o link de confirmação', async () => {
    const { c, user, companyId } = await criarConta();
    const company = await db().companySettings.findUniqueOrThrow({ where: { id: companyId } });
    expect(company.plan).toBe('gestao');
    const dias = (company.trialEndsAt!.getTime() - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(6.9);
    expect(dias).toBeLessThan(7.1);

    // Com envio de e-mail configurado (aqui um falso que segura tudo na fila), pede confirmação.
    app.ctx.mailer.useTransport(async () => {
      throw new Error('segura na fila');
    });
    let me;
    try {
      me = await c.get('/api/auth/me');
      expect(me.body.user.emailConfirmed).toBe(false);
      expect((await c.get('/api/auth/signup-config')).body.emailEnabled).toBe(true);
    } finally {
      app.ctx.mailer.useTransport(null);
    }
    expect(me.body.company.subscription).toMatchObject({ status: 'TESTE', locked: false });

    // Jogo: desligado e o gestor não consegue ligar sozinho.
    expect((await c.get('/api/v1/modules')).body.ambiente_interativo).toBe(false);
    const put = await c.put(
      '/api/company/modules/ambiente_interativo',
      { enabled: true, version: 0 },
      { 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
    );
    expect(put.status).toBe(422);
    expect(put.body.error.message).toContain('Assinatura');

    // E-mail de confirmação na fila, com link de uso único.
    const mail = await db().outboundEmail.findFirstOrThrow({
      where: { to: 'nova@tapecaria.local' },
    });
    expect(mail.kind).toBe('confirmar-email');
    expect(mail.companyId).toBe(companyId);
    const token = linkDe(mail.text, '/entrar/confirmar')!;
    expect(token).toBeTruthy();
    const ok = await new Client(app).post('/api/auth/email/confirm', { token });
    expect(ok.status).toBe(200);
    expect(
      (await db().user.findUniqueOrThrow({ where: { id: user.id } })).emailConfirmedAt,
    ).not.toBeNull();
    expect((await c.get('/api/auth/me')).body.user.emailConfirmed).toBe(true);
    // O token não fica guardado em claro.
    expect(JSON.stringify(await db().emailToken.findMany())).not.toContain(token);
  });

  it('a Cenário Estofados tem cortesia no plano com o jogo', async () => {
    const admin = await loginAdmin(app);
    const me = await admin.get('/api/auth/me');
    expect(me.body.company.subscription).toMatchObject({ status: 'CORTESIA', plan: 'gestao_jogo' });
    expect((await admin.get('/api/v1/modules')).body.ambiente_interativo).toBe(true);
  });

  it('reenviar o link de confirmação: no máximo 3 por hora', async () => {
    const { c } = await criarConta();
    for (let i = 0; i < 3; i++) expect((await c.post('/api/auth/email/resend')).status).toBe(204);
    expect((await c.post('/api/auth/email/resend')).status).toBe(429);
    // Só o último link vale.
    const tokens = await db().emailToken.findMany({
      where: { purpose: 'CONFIRMAR_EMAIL', usedAt: null },
    });
    expect(tokens).toHaveLength(1);
  });
});

describe('Esqueci minha senha', () => {
  it('manda o link, troca a senha uma vez só, encerra as sessões e não revela quem tem conta', async () => {
    const { c } = await criarConta();
    const anon = new Client(app);
    expect(
      (await anon.post('/api/auth/password/forgot', { email: 'ninguem@x.local' })).status,
    ).toBe(204);
    expect(await db().outboundEmail.count({ where: { to: 'ninguem@x.local' } })).toBe(0);

    expect(
      (await anon.post('/api/auth/password/forgot', { email: 'NOVA@tapecaria.local' })).status,
    ).toBe(204);
    const mail = await db().outboundEmail.findFirstOrThrow({ where: { kind: 'redefinir-senha' } });
    const token = linkDe(mail.text, '/entrar/nova-senha')!;

    const fraca = await anon.post('/api/auth/password/reset', {
      token,
      password: '123',
      passwordConfirm: '123',
    });
    expect(fraca.status).toBe(400);
    const r = await anon.post('/api/auth/password/reset', {
      token,
      password: 'senhanova1',
      passwordConfirm: 'senhanova1',
    });
    expect(r.status).toBe(204);
    // A sessão antiga caiu; a senha antiga não entra; a nova entra.
    expect((await c.get('/api/auth/me')).status).toBe(401);
    expect(
      (
        await new Client(app).post('/api/auth/login', {
          email: 'nova@tapecaria.local',
          password: 'senha123',
        })
      ).status,
    ).toBe(401);
    const login = await new Client(app).post('/api/auth/login', {
      email: 'nova@tapecaria.local',
      password: 'senhanova1',
    });
    expect(login.status).toBe(200);
    // Redefinir pelo e-mail também confirma o e-mail.
    expect(login.body.user.emailConfirmed).toBe(true);
    // Link de uso único.
    const de_novo = await anon.post('/api/auth/password/reset', {
      token,
      password: 'outrasenha1',
      passwordConfirm: 'outrasenha1',
    });
    expect(de_novo.status).toBe(422);
  });

  it('link vencido (mais de 1 hora) não vale', async () => {
    await criarConta();
    await new Client(app).post('/api/auth/password/forgot', { email: 'nova@tapecaria.local' });
    const mail = await db().outboundEmail.findFirstOrThrow({ where: { kind: 'redefinir-senha' } });
    const token = linkDe(mail.text, '/entrar/nova-senha')!;
    await db().emailToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await new Client(app).post('/api/auth/password/reset', {
      token,
      password: 'senhanova1',
      passwordConfirm: 'senhanova1',
    });
    expect(r.status).toBe(422);
  });
});

describe('Anti-robô', () => {
  it('campo-isca preenchido é recusado e não gasta o limite', async () => {
    const r = await new Client(app).post('/api/auth/signup', {
      email: 'robo@x.local',
      password: 'senha123',
      passwordConfirm: 'senha123',
      website: 'http://spam',
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('CAPTCHA_FAILED');
    expect(await db().user.count({ where: { email: 'robo@x.local' } })).toBe(0);
    expect(await db().authThrottle.count({ where: { key: 'signup:global' } })).toBe(0);
  });

  it('com o Turnstile ligado, sem token válido não cria conta', async () => {
    const original = app.ctx.captcha;
    app.ctx.captcha = async (token) => token === 'ok';
    try {
      const base = { email: 'a@x.local', password: 'senha123', passwordConfirm: 'senha123' };
      expect((await new Client(app).post('/api/auth/signup', base)).status).toBe(400);
      expect(
        (await new Client(app).post('/api/auth/signup', { ...base, captcha: 'ok' })).status,
      ).toBe(201);
    } finally {
      app.ctx.captcha = original;
    }
  });
});

describe('Assinatura pelo Asaas e bloqueio', () => {
  it('assinar gera a cobrança, o pagamento libera um mês e troca o plano (com o jogo)', async () => {
    const { c, companyId } = await criarConta();
    const sem_doc = await c.post('/api/v1/subscription/checkout', {
      plan: 'gestao_jogo',
      cycle: 'MENSAL',
    });
    expect(sem_doc.status).toBe(400);

    const r = await c.post('/api/v1/subscription/checkout', {
      plan: 'gestao_jogo',
      cycle: 'MENSAL',
      document: '123.456.789-09',
    });
    expect(r.status).toBe(200);
    expect(r.body.paymentUrl).toMatch(/^https:\/\/asaas\.teste\/i\//);
    const sub = asaasCalls.find((x) => x.url.endsWith('/subscriptions') && x.method === 'POST')!;
    expect(sub.body).toMatchObject({ value: 599, cycle: 'MONTHLY', billingType: 'UNDEFINED' });
    // Plano novo vence hoje (o jogo liga ao pagar).
    const invoice = await db().subscriptionInvoice.findFirstOrThrow({ where: { companyId } });
    expect(invoice).toMatchObject({ status: 'PENDENTE', amountCents: 59_900, plan: 'gestao_jogo' });
    expect((await c.get('/api/v1/modules')).body.ambiente_interativo).toBe(false);

    // Sem o token do webhook: recusado.
    expect(
      (
        await new Client(app, null).post('/api/webhooks/assinatura/asaas', {
          event: 'PAYMENT_RECEIVED',
          payment: payments[0],
        })
      ).status,
    ).toBe(401);

    expect((await webhook('PAYMENT_RECEIVED', payments[0]!)).body.result).toMatch(/^paga até/);
    // Repetir a notificação não paga duas vezes.
    expect((await webhook('PAYMENT_CONFIRMED', payments[0]!)).body.result).toBe('já paga');
    const company = await db().companySettings.findUniqueOrThrow({ where: { id: companyId } });
    expect(company.plan).toBe('gestao_jogo');
    expect(company.paidUntil!.getTime()).toBeGreaterThan(Date.now() + 27 * 86_400_000);
    expect((await c.get('/api/v1/modules')).body.ambiente_interativo).toBe(true);
    const s = await c.get('/api/v1/subscription');
    expect(s.body).toMatchObject({ status: 'ATIVA', plan: 'gestao_jogo', includesGame: true });
    expect(await db().outboundEmail.count({ where: { kind: 'assinatura-paga' } })).toBeGreaterThan(
      0,
    );

    // Próxima cobrança do ciclo (o Asaas cria e avisa): vira uma cobrança nova da empresa.
    await webhook('PAYMENT_CREATED', { ...payments[0]!, id: 'pay_next', dueDate: '2027-01-17' });
    expect(await db().subscriptionInvoice.count({ where: { companyId } })).toBe(2);
  });

  it('vencida depois da tolerância: só a assinatura abre; dentro dos 5 dias funciona', async () => {
    const { c, companyId } = await criarConta();
    await db().companySettings.update({
      where: { id: companyId },
      data: { trialEndsAt: new Date(Date.now() - 86_400_000) },
    });
    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.company.subscription).toMatchObject({ status: 'VENCIDA', locked: true });
    const bloqueado = await c.get('/api/v1/customers');
    expect(bloqueado.status).toBe(402);
    expect(bloqueado.body.error.code).toBe('SUBSCRIPTION_REQUIRED');
    expect((await c.get('/api/v1/subscription')).status).toBe(200);

    // Pagou fora (Pix direto) e o dono registrou: volta na hora.
    await db().companySettings.update({
      where: { id: companyId },
      data: { paidUntil: new Date(Date.now() + 30 * 86_400_000) },
    });
    expect((await c.get('/api/v1/customers')).status).toBe(200);

    // Atrasada dentro dos 5 dias: funciona, com aviso.
    await db().companySettings.update({
      where: { id: companyId },
      data: { paidUntil: new Date(Date.now() - 2 * 86_400_000) },
    });
    expect((await c.get('/api/v1/customers')).status).toBe(200);
    expect((await c.get('/api/auth/me')).body.company.subscription.status).toBe('ATRASADA');
  });
});

describe('Painel da plataforma: Empresas', () => {
  it('mostra plano, situação, pedidos e e-mail confirmado; troca plano e registra pagamento', async () => {
    const { companyId } = await criarConta();
    const admin = await loginPlatform(app);
    const list = await admin.get('/api/v1/platform/companies');
    const row = list.body.items.find((x: { id: number }) => x.id === companyId);
    expect(row).toMatchObject({
      orders: 0,
      ownerEmailConfirmed: false,
      plan: 'gestao',
      status: 'TESTE',
      tone: 'trial',
    });
    const r = await admin.put(`/api/v1/platform/companies/${companyId}`, {
      plan: 'gestao_jogo',
      paidUntil: '2099-01-31',
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ATIVA', plan: 'gestao_jogo' });
    const log = await db().platformAuditLog.findFirstOrThrow({
      where: { action: 'platform.company_edited' },
    });
    expect(log.targetCompanyId).toBe(companyId);
    expect(log.summary).toContain('pago até 31/01/2099');
  });
});

describe('Fila de e-mails (Resend)', () => {
  it('envia o que está na fila e tenta de novo depois de uma falha', async () => {
    await criarConta();
    const enviados: string[] = [];
    let falhar = true;
    app.ctx.mailer.useTransport(async (m) => {
      if (falhar) throw new Error('Resend fora do ar');
      enviados.push(`${m.to}|${m.subject}`);
    });
    try {
      expect(await app.ctx.mailer.drain()).toBe(0);
      const falhou = await db().outboundEmail.findFirstOrThrow();
      expect(falhou).toMatchObject({ attempts: 1, sentAt: null });
      expect(falhou.lastError).toContain('fora do ar');
      // Antes da hora da nova tentativa, nada; depois, envia.
      expect(await app.ctx.mailer.drain()).toBe(0);
      falhar = false;
      expect(await app.ctx.mailer.drain(new Date(Date.now() + 2 * 60_000))).toBe(1);
      expect(enviados).toEqual(['nova@tapecaria.local|Confirme o seu e-mail — Cenário Gestão']);
      expect((await db().outboundEmail.findFirstOrThrow()).sentAt).not.toBeNull();
    } finally {
      app.ctx.mailer.useTransport(null);
    }
  });
});

describe('Sem as chaves (Resend, Turnstile): publica desligado sem quebrar nada', () => {
  it('cria conta e entra sem confirmar e-mail, sem anti-robô e sem link de esqueci a senha', async () => {
    const cfg = await new Client(app).get('/api/auth/signup-config');
    expect(cfg.body).toEqual({ captchaSiteKey: null, emailEnabled: false });
    const { c } = await criarConta();
    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(200);
    // Sem como mandar o e-mail, ninguém fica com aviso para confirmar.
    expect(me.body.user.emailConfirmed).toBe(true);
  });

  it('e-mail parado na fila há mais de um dia é descartado quando o envio é ligado', async () => {
    await criarConta();
    await db().outboundEmail.updateMany({
      data: { createdAt: new Date(Date.now() - 2 * 86_400_000) },
    });
    const enviados: string[] = [];
    app.ctx.mailer.useTransport(async (m) => {
      enviados.push(m.to);
    });
    try {
      expect(await app.ctx.mailer.drain()).toBe(0);
      expect(enviados).toEqual([]);
      const m = await db().outboundEmail.findFirstOrThrow();
      expect(m.sentAt).toBeNull();
      expect(m.lastError).toContain('Descartado');
    } finally {
      app.ctx.mailer.useTransport(null);
    }
  });
});
