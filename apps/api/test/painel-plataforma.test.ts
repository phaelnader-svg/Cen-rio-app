/**
 * Painel da plataforma (/plataforma, 2026-11-25). Pedido do dono: um painel só dele, separado da
 * conta da Cenário Estofados, para cobrar as assinaturas por PIX (sem Asaas por enquanto):
 * empresas, "Recebi o pagamento", preços, PIX e WhatsApp, aviso antes do vencimento e bloqueio
 * sozinho depois da tolerância.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { sendDueNotices } from '../src/modules/platform/due-notices';
import {
  Client,
  PLATFORM_ADMIN,
  createTestApp,
  db,
  loginAdmin,
  loginPlatform,
  resetDatabase,
} from './helpers';

let app: App;
type J = any; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(async () => {
  app = await createTestApp({ PUBLIC_WEB_URL: 'https://painel.teste' });
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(() => resetDatabase());

function ok(r: { status: number; body: J }, status = 200) {
  if (r.status !== status) throw new Error(`${r.status}: ${JSON.stringify(r.body)}`);
  return r.body;
}

async function criarConta(email = 'cliente@tapecaria.local') {
  const c = new Client(app);
  ok(
    await c.post('/api/auth/signup', {
      email,
      password: 'SenhaBoa123',
      passwordConfirm: 'SenhaBoa123',
      acceptTerms: true,
    }),
    201,
  );
  const user = await db().user.findUniqueOrThrow({ where: { email } });
  return { c, companyId: user.companyId };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000);

describe('Acesso do painel', () => {
  it('o primeiro acesso é criado uma vez, pelo gestor da Cenário Estofados', async () => {
    const anon = new Client(app);
    expect(ok(await anon.get('/api/plataforma/estado')).hasAdmin).toBe(false);
    // Sem login de empresa: não cria.
    expect(
      (
        await anon.post('/api/plataforma/primeiro-acesso', {
          email: 'x@x.local',
          displayName: 'X',
          password: 'Senha12345',
          passwordConfirm: 'Senha12345',
        })
      ).status,
    ).toBe(401);
    // Gestor de outra empresa: não cria.
    const { c } = await criarConta();
    const outra = await c.post('/api/plataforma/primeiro-acesso', {
      email: 'x@x.local',
      displayName: 'X',
      password: 'Senha12345',
      passwordConfirm: 'Senha12345',
    });
    expect(outra.status).toBe(403);
    // A mensagem diz em qual empresa o navegador está logado (o engano comum).
    expect(JSON.stringify(outra.body)).toMatch(/Este navegador está logado na empresa/);
    const painel = await loginPlatform(app);
    expect(ok(await painel.get('/api/plataforma/eu')).email).toBe(PLATFORM_ADMIN.email);
    // Segunda vez: recusa.
    const gestor = await loginAdmin(app);
    expect(
      (
        await gestor.post('/api/plataforma/primeiro-acesso', {
          email: 'outro@x.local',
          displayName: 'Outro',
          password: 'Senha12345',
          passwordConfirm: 'Senha12345',
        })
      ).status,
    ).toBe(409);
  });

  it('o login do painel é separado: não abre o painel das empresas, e vice-versa', async () => {
    const painel = await loginPlatform(app);
    const cookies = [...painel.cookies.keys()];
    expect(cookies).toContain('cen_plat');
    // O login do painel não vale nas rotas das empresas…
    const soPainel = new Client(app);
    soPainel.cookies.set('cen_plat', painel.cookies.get('cen_plat')!);
    expect((await soPainel.get('/api/auth/me')).status).toBe(401);
    expect((await soPainel.get('/api/v1/platform/companies')).status).toBe(200);
    // …e o da Cenário Estofados não vale no painel.
    const estofados = await loginAdmin(app);
    expect((await estofados.get('/api/v1/platform/companies')).status).toBe(401);
    // Senha errada.
    expect(
      (
        await new Client(app).post('/api/plataforma/entrar', {
          email: PLATFORM_ADMIN.email,
          password: 'errada',
        })
      ).status,
    ).toBe(401);
    // Sair encerra só o painel.
    ok(await painel.post('/api/plataforma/sair'));
    expect((await soPainel.get('/api/v1/platform/companies')).status).toBe(401);
  });

  it('troca a senha e derruba as outras sessões; o histórico registra', async () => {
    const a = await loginPlatform(app);
    const b = await loginPlatform(app);
    expect(
      (
        await a.post('/api/plataforma/senha', {
          currentPassword: 'errada',
          newPassword: 'NovaSenha123',
          newPasswordConfirm: 'NovaSenha123',
        })
      ).status,
    ).toBe(400);
    ok(
      await a.post('/api/plataforma/senha', {
        currentPassword: PLATFORM_ADMIN.password,
        newPassword: 'NovaSenha123',
        newPasswordConfirm: 'NovaSenha123',
      }),
    );
    expect((await b.get('/api/plataforma/eu')).status).toBe(401);
    expect((await a.get('/api/plataforma/eu')).status).toBe(200);
    const hist = ok(await a.get('/api/plataforma/historico'));
    expect(hist.items.map((i: J) => i.action)).toContain('platform.password_changed');
  });
});

describe('Empresas e cobrança', () => {
  it('cadastra uma empresa com senha provisória, edita e o cliente entra', async () => {
    const painel = await loginPlatform(app);
    const r = ok(
      await painel.post('/api/v1/platform/companies', {
        tradeName: 'Tapeçaria Modelo',
        ownerName: 'Marcos Souza',
        email: 'marcos@modelo.local',
        phone: '12 99999-0000',
        plan: 'gestao',
        cycle: 'MENSAL',
        trialDays: 7,
        billingPriceCents: 34900,
      }),
    );
    expect(r.company).toMatchObject({
      tradeName: 'Tapeçaria Modelo',
      status: 'TESTE',
      priceCents: 34900,
      ownerName: 'Marcos Souza',
    });
    expect(r.company.chargeWhatsappUrl).toContain('wa.me/5512999990000');
    const c = new Client(app);
    ok(await c.post('/api/auth/login', { email: 'marcos@modelo.local', password: r.password }));
    expect(ok(await c.get('/api/auth/me')).company.tradeName).toBe('Tapeçaria Modelo');

    const e = ok(
      await painel.put(`/api/v1/platform/companies/${r.company.id}`, {
        tradeName: 'Tapeçaria Modelo Ltda',
        billingPriceCents: null,
        note: 'Indicado pelo João',
      }),
    );
    expect(e).toMatchObject({ tradeName: 'Tapeçaria Modelo Ltda', priceCents: 39900 });
    expect(e.note).toBe('Indicado pelo João');
    // Mesmo e-mail de novo: recusa.
    expect(
      (
        await painel.post('/api/v1/platform/companies', {
          tradeName: 'Outra',
          ownerName: 'Outro Nome',
          email: 'marcos@modelo.local',
          plan: 'gestao',
          cycle: 'MENSAL',
          trialDays: 7,
        })
      ).status,
    ).toBe(409);
  });

  it('"Recebi o pagamento" empurra o pago até um ciclo a partir do vencimento e dá para desfazer', async () => {
    const { companyId } = await criarConta();
    const painel = await loginPlatform(app);
    const venc = daysFromNow(-2);
    await db().companySettings.update({
      where: { id: companyId },
      data: { trialEndsAt: daysFromNow(-40), paidUntil: venc },
    });
    const r = ok(
      await painel.post(`/api/v1/platform/companies/${companyId}/payments`, {
        amountCents: 39900,
        receivedOn: ymd(new Date()),
      }),
    );
    // Pagou atrasado: o dia do vencimento não muda (um mês depois do vencimento anterior).
    const esperado = new Date(venc);
    esperado.setUTCMonth(esperado.getUTCMonth() + 1);
    expect(r.company.status).toBe('ATIVA');
    expect(r.company.paidUntil.slice(0, 7)).toBe(esperado.toISOString().slice(0, 7));
    const pagamentos = ok(await painel.get('/api/v1/platform/payments'));
    expect(pagamentos.items).toHaveLength(1);
    expect(pagamentos.items[0]).toMatchObject({ amountCents: 39900, provider: 'MANUAL' });
    // O cliente vê o pagamento na Assinatura dele.
    const dash = ok(await painel.get('/api/v1/platform/dashboard'));
    expect(dash.receivedThisMonthCents).toBe(39900);
    expect(dash.paying).toBe(1);

    ok(await painel.del(`/api/v1/platform/payments/${pagamentos.items[0].id}`));
    const depois = await db().companySettings.findUniqueOrThrow({ where: { id: companyId } });
    expect(depois.paidUntil).toBeNull();
    expect(ok(await painel.get('/api/v1/platform/payments')).items).toHaveLength(0);
  });

  it('bloquear e liberar ficam no histórico do painel', async () => {
    const { companyId, c } = await criarConta();
    const painel = await loginPlatform(app);
    ok(await painel.post(`/api/v1/platform/companies/${companyId}/block`, { reason: 'Calote' }));
    expect((await c.get('/api/auth/me')).status).toBe(401);
    ok(await painel.post(`/api/v1/platform/companies/${companyId}/unblock`));
    const hist = ok(await painel.get('/api/plataforma/historico'));
    expect(hist.items.map((i: J) => i.summary).join(' | ')).toContain('bloqueada: Calote');
  });
});

describe('Planos, preços e como eu recebo', () => {
  it('os preços e o PIX do painel aparecem na assinatura do cliente', async () => {
    const { c } = await criarConta();
    const painel = await loginPlatform(app);
    const s = ok(
      await painel.put('/api/v1/platform/settings', {
        priceGestaoCents: 44900,
        annualDiscountPct: 20,
        pixKey: '12.345.678/0001-90',
        pixName: 'Cenário Gestão',
        whatsapp: '(12) 99652-0615',
        paymentMessage: 'Mande o comprovante pelo WhatsApp.',
      }),
    );
    expect(s).toMatchObject({
      priceGestaoCents: 44900,
      annualDiscountPct: 20,
      whatsapp: '12996520615',
    });
    const sub = ok(await c.get('/api/v1/subscription'));
    expect(sub.plans.find((p: J) => p.key === 'gestao')).toMatchObject({
      monthlyCents: 44900,
      annualCents: Math.round(44900 * 12 * 0.8),
    });
    expect(sub.annualDiscountPct).toBe(20);
    expect(sub.manual).toMatchObject({
      pixKey: '12.345.678/0001-90',
      pixName: 'Cenário Gestão',
      amountCents: 44900,
    });
    expect(sub.manual.whatsappUrl).toContain('https://wa.me/5512996520615?text=');
    // Conta nova depois da mudança: teste com os dias do painel.
    ok(await painel.put('/api/v1/platform/settings', { trialDays: 14 }));
    const { companyId } = await criarConta('outra@tapecaria.local');
    const nova = await db().companySettings.findUniqueOrThrow({ where: { id: companyId } });
    const dias = (nova.trialEndsAt!.getTime() - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(13.9);
    expect(dias).toBeLessThan(14.1);
  });

  it('com o bloqueio automático, o teste vencido bloqueia; "Recebi" libera na hora', async () => {
    const { c, companyId } = await criarConta();
    await db().companySettings.update({
      where: { id: companyId },
      data: { trialEndsAt: daysFromNow(-1) },
    });
    // Desligado (padrão): nada bloqueia.
    expect((await c.get('/api/v1/customers')).status).toBe(200);
    const painel = await loginPlatform(app);
    const antes = ok(await painel.get('/api/v1/platform/settings'));
    expect(antes.wouldBlockNow.map((x: J) => x.id)).toEqual([companyId]);
    ok(
      await painel.put('/api/v1/platform/settings', {
        autoBlock: true,
        pixKey: 'pix@cenario.local',
      }),
    );
    const bloqueado = await c.get('/api/v1/customers');
    expect(bloqueado.status).toBe(402);
    // A tela de assinatura abre, com o PIX para pagar.
    const sub = ok(await c.get('/api/v1/subscription'));
    expect(sub).toMatchObject({ status: 'VENCIDA', billingEnabled: true });
    expect(sub.manual.pixKey).toBe('pix@cenario.local');
    // A Cenário Estofados nunca bloqueia.
    const estofados = await loginAdmin(app);
    expect((await estofados.get('/api/v1/customers')).status).toBe(200);

    ok(
      await painel.post(`/api/v1/platform/companies/${companyId}/payments`, {
        amountCents: 39900,
        receivedOn: ymd(new Date()),
      }),
    );
    expect((await c.get('/api/v1/customers')).status).toBe(200);
  });
});

describe('Aviso antes do vencimento', () => {
  it('manda um e-mail por vencimento para o dono da plataforma', async () => {
    const { companyId } = await criarConta();
    await loginPlatform(app);
    await db().companySettings.update({
      where: { id: companyId },
      data: { trialEndsAt: daysFromNow(-30), paidUntil: daysFromNow(2) },
    });
    expect(await sendDueNotices(app.ctx.system, 'https://painel.teste')).toBe(1);
    expect(await sendDueNotices(app.ctx.system, 'https://painel.teste')).toBe(0);
    const mail = await db().outboundEmail.findFirstOrThrow({
      where: { kind: 'plataforma-vencimento' },
    });
    expect(mail.to).toBe(PLATFORM_ADMIN.email);
    expect(mail.subject).toContain('vence em 2 dias');
    expect(mail.text).toContain('https://painel.teste/plataforma/cobranca');
    // Longe do vencimento: nada.
    await db().companySettings.update({
      where: { id: companyId },
      data: { paidUntil: daysFromNow(20), dueNoticeFor: null },
    });
    expect(await sendDueNotices(app.ctx.system, 'https://painel.teste')).toBe(0);
  });
});
