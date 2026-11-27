/**
 * Etapa 2 da lista de 53 melhorias (2026-11-27): PIX com QR Code (40), comprovante pela tela (41),
 * avisos no celular (43), demonstrações do site (44), origem (45), linha do tempo (46), mensagens
 * editáveis (47), preço de lançamento (48), telas usadas (49), sugestões agrupadas (50), encerrar
 * empresa (51) e os e-mails da mensalidade, do resumo da semana e de segurança.
 */
import { pixCrc16, screenKeyFor, signupSourceFrom } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { resetPlatformConfigCache } from '../src/core/platform-config';
import { sendBillingEmails, sendWeeklySummaries } from '../src/modules/platform/billing-emails';
import { pushSender } from '../src/modules/push/push';
import {
  Client,
  EMPRESA_NOVA,
  createTestApp,
  db,
  loginPlatform,
  rawDb,
  resetDatabase,
} from './helpers';

let app: App;
const pushes: { endpoint: string; title: string; body: string }[] = [];
const originalPush = pushSender.send;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
  pushSender.send = async (target, message) => {
    pushes.push({ endpoint: target.endpoint, title: message.title, body: message.body });
  };
});
afterAll(async () => {
  pushSender.send = originalPush;
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  resetPlatformConfigCache();
  setClock();
  pushes.length = 0;
});
afterEach(() => setClock());

// JPEG mínimo (só o começo do arquivo importa para a conferência do tipo).
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]).toString(
  'base64',
);

async function criarConta(email = 'dona@tapecaria.local', origem?: string) {
  const c = new Client(app);
  const r = await c.post('/api/auth/signup', {
    ...EMPRESA_NOVA,
    email,
    password: 'senha1234',
    passwordConfirm: 'senha1234',
    ...(origem ? { origem } : {}),
  });
  expect(r.status).toBe(201);
  const user = await db().user.findUniqueOrThrow({ where: { email } });
  return { c, companyId: user.companyId };
}

async function configurarPix(painel: Client) {
  const r = await painel.put('/api/v1/platform/settings', {
    pixKey: '(12) 99652-0615',
    pixName: 'Raphael Teste',
    pixCity: 'São José dos Campos',
    whatsapp: '12996520615',
  });
  expect(r.status).toBe(200);
}

describe('PIX com QR Code e comprovante pela tela (40 e 41)', () => {
  it('a assinatura traz o PIX copia e cola com o valor certo e o CRC válido', async () => {
    const painel = await loginPlatform(app);
    await configurarPix(painel);
    const { c } = await criarConta();
    const s = await c.get('/api/v1/subscription');
    expect(s.status).toBe(200);
    const code: string = s.body.manual.pixCode;
    expect(code).toContain('br.gov.bcb.pix');
    expect(code).toContain('+5512996520615');
    expect(code).toContain('5406399.00');
    expect(code).toContain('RAPHAEL TESTE');
    expect(code).toContain('SAO JOSE DOS CA');
    expect(code.slice(-4)).toBe(pixCrc16(code.slice(0, -4)));
    expect(s.body.proofs).toEqual([]);
  });

  it('o cliente manda o comprovante, o dono confirma com 1 clique e o sistema libera', async () => {
    const painel = await loginPlatform(app);
    await configurarPix(painel);
    await painel.put('/api/v1/platform/push', {
      endpoint: 'https://push.exemplo/painel-1',
      keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) },
    });
    const { c, companyId } = await criarConta();
    // Arquivo que não é foto nem PDF: recusado.
    const ruim = await c.post('/api/v1/subscription/proofs', {
      amountCents: 39900,
      paidOn: '2026-11-27',
      mime: 'image/jpeg',
      data: Buffer.alloc(200, 7).toString('base64'),
    });
    expect(ruim.status).toBe(400);
    const r = await c.post('/api/v1/subscription/proofs', {
      amountCents: 39900,
      paidOn: '2026-11-27',
      mime: 'image/jpeg',
      data: JPEG,
    });
    expect(r.status).toBe(201);
    // O dono da plataforma é avisado por e-mail e no celular.
    expect(await rawDb().outboundEmail.count({ where: { kind: 'plataforma-comprovante' } })).toBe(
      1,
    );
    expect(pushes.map((p) => p.title)).toContain('Comprovante de Tapeçaria Teste');

    const list = await painel.get('/api/v1/platform/proofs');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      companyId,
      amountCents: 39900,
      expectedCents: 39900,
      status: 'PENDENTE',
    });
    expect(list.body.items[0].data).toBeUndefined();
    const file = await painel.get(`/api/v1/platform/proofs/${list.body.items[0].id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/jpeg');

    // A empresa nunca vê o comprovante de outra.
    const outra = await criarConta('outra@tapecaria.local');
    const sub2 = await outra.c.get('/api/v1/subscription');
    expect(sub2.body.proofs).toEqual([]);

    const ok = await painel.post(`/api/v1/platform/proofs/${list.body.items[0].id}/confirm`, {});
    expect(ok.status).toBe(200);
    const company = await rawDb().companySettings.findUniqueOrThrow({ where: { id: companyId } });
    expect(company.paidUntil).not.toBeNull();
    const inv = await rawDb().subscriptionInvoice.findFirstOrThrow({ where: { companyId } });
    expect(inv).toMatchObject({ status: 'PAGA', amountCents: 39900, provider: 'MANUAL' });
    const proof = await rawDb().paymentProof.findFirstOrThrow({ where: { companyId } });
    expect(proof).toMatchObject({ status: 'CONFIRMADO', invoiceId: inv.id });
    expect(
      await rawDb().outboundEmail.count({ where: { kind: 'assinatura-paga', companyId } }),
    ).toBe(1);
    // Duas vezes não paga duas vezes.
    const de_novo = await painel.post(`/api/v1/platform/proofs/${proof.id}/confirm`, {});
    expect(de_novo.status).toBe(422);
    const s = await c.get('/api/v1/subscription');
    expect(s.body.proofs[0]).toMatchObject({ status: 'CONFIRMADO' });
  });

  it('recusar avisa a empresa com o motivo', async () => {
    const painel = await loginPlatform(app);
    const { c, companyId } = await criarConta();
    await c.post('/api/v1/subscription/proofs', {
      amountCents: 10000,
      paidOn: '2026-11-27',
      mime: 'image/jpeg',
      data: JPEG,
    });
    const p = await rawDb().paymentProof.findFirstOrThrow({ where: { companyId } });
    const r = await painel.post(`/api/v1/platform/proofs/${p.id}/reject`, {
      reason: 'Valor diferente da mensalidade',
    });
    expect(r.status).toBe(200);
    const mail = await rawDb().outboundEmail.findFirstOrThrow({
      where: { kind: 'assinatura-comprovante-recusado', companyId },
    });
    expect(mail.text).toContain('Valor diferente da mensalidade');
    const s = await c.get('/api/v1/subscription');
    expect(s.body.proofs[0]).toMatchObject({
      status: 'RECUSADO',
      rejectReason: 'Valor diferente da mensalidade',
    });
  });

  it('sem login do painel não dá para ver nem confirmar comprovantes', async () => {
    const { c } = await criarConta();
    expect((await c.get('/api/v1/platform/proofs')).status).toBe(401);
    expect((await new Client(app).get('/api/v1/platform/screens')).status).toBe(401);
  });
});

describe('Demonstração pelo site (44) e origem (45)', () => {
  it('a pessoa marca a demonstração no site e ela aparece no painel', async () => {
    const painel = await loginPlatform(app);
    const visitante = new Client(app);
    const when = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const r = await visitante.post('/api/public/demonstracao', {
      name: 'Carlos Silva',
      businessName: 'Estofados Silva',
      city: 'Taubaté',
      phone: '(12) 98888-7777',
      preferredAt: when,
      origem: 'blog:Como cobrar reforma',
    });
    expect(r.status).toBe(201);
    // Campo-isca preenchido = robô.
    const robo = await visitante.post('/api/public/demonstracao', {
      name: 'Robô',
      phone: '12988887777',
      preferredAt: when,
      website: 'http://spam',
    });
    expect(robo.status).not.toBe(201);
    const list = await painel.get('/api/v1/platform/demos');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      name: 'Carlos Silva',
      businessName: 'Estofados Silva',
      status: 'PENDENTE',
    });
    expect(list.body.items[0].whatsappUrl).toContain('wa.me/5512988887777');
    expect(await rawDb().outboundEmail.count({ where: { kind: 'plataforma-demonstracao' } })).toBe(
      1,
    );
    const dash = await painel.get('/api/v1/platform/dashboard');
    expect(dash.body.demosPending).toBe(1);
    const done = await painel.post(`/api/v1/platform/demos/${list.body.items[0].id}/feita`, {});
    expect(done.status).toBe(200);
    expect((await painel.get('/api/v1/platform/dashboard')).body.demosPending).toBe(0);
  });

  it('o cadastro guarda de onde a empresa veio e o painel conta por origem', async () => {
    const painel = await loginPlatform(app);
    const { companyId } = await criarConta('blog@tapecaria.local', 'blog:Artigo do sofá');
    await criarConta('site@tapecaria.local');
    const c = await rawDb().companySettings.findUniqueOrThrow({ where: { id: companyId } });
    expect(c).toMatchObject({ signupSource: 'BLOG', signupSourceDetail: 'Artigo do sofá' });
    const dash = await painel.get('/api/v1/platform/dashboard');
    const by = Object.fromEntries(
      dash.body.bySource.map((b: { source: string; companies: number }) => [b.source, b.companies]),
    );
    expect(by).toMatchObject({ BLOG: 1, SITE: 1 });
    // O dono da plataforma corrige a origem (ex.: veio por indicação).
    const r = await painel.put(`/api/v1/platform/companies/${companyId}`, {
      signupSource: 'INDICACAO',
      signupSourceDetail: 'Tapeçaria do João',
    });
    expect(r.body).toMatchObject({
      signupSource: 'INDICACAO',
      signupSourceDetail: 'Tapeçaria do João',
    });
  });

  it('lê a origem guardada pelo site', () => {
    expect(signupSourceFrom(undefined)).toEqual({ source: 'SITE', detail: null });
    expect(signupSourceFrom('indicacao:Maria')).toEqual({ source: 'INDICACAO', detail: 'Maria' });
    expect(signupSourceFrom('google')).toEqual({ source: 'ANUNCIO', detail: 'google' });
    expect(signupSourceFrom('demonstracao')).toEqual({ source: 'DEMONSTRACAO', detail: null });
  });
});

describe('Linha do tempo (46), mensagens prontas (47) e preço de lançamento (48)', () => {
  it('a linha do tempo junta cadastro, conversas e pagamentos em ordem', async () => {
    const painel = await loginPlatform(app);
    const { companyId } = await criarConta();
    expect(
      (
        await painel.post(`/api/v1/platform/companies/${companyId}/timeline`, {
          text: 'Liguei e expliquei o orçamento.',
        })
      ).status,
    ).toBe(200);
    await painel.post(`/api/v1/platform/companies/${companyId}/payments`, {
      amountCents: 39900,
      receivedOn: '2026-11-27',
    });
    const t = await painel.get(`/api/v1/platform/companies/${companyId}/timeline`);
    expect(t.status).toBe(200);
    const kinds = t.body.items.map((i: { kind: string }) => i.kind);
    expect(kinds).toContain('cadastro');
    expect(kinds).toContain('conversa');
    expect(kinds).toContain('pagamento');
    expect(t.body.items.at(-1).kind).toBe('cadastro');
    expect(t.body.items.find((i: { kind: string }) => i.kind === 'conversa').text).toBe(
      'Liguei e expliquei o orçamento.',
    );
  });

  it('o texto do botão de WhatsApp sai como o dono escreveu, com os dados da empresa', async () => {
    const painel = await loginPlatform(app);
    const { companyId } = await criarConta();
    const r = await painel.put('/api/v1/platform/settings', {
      messageTemplates: { contatoPasso: 'Fala, {nome}! A {empresa} parou em "{passo}".' },
    });
    expect(r.body.messageTemplates.contatoPasso).toContain('{empresa}');
    const list = await painel.get('/api/v1/platform/companies');
    const row = list.body.items.find((x: { id: number }) => x.id === companyId);
    expect(decodeURIComponent(row.contactWhatsappUrl)).toContain(
      'Fala, Ana! A Tapeçaria Teste parou em "Responder as perguntas do começo".',
    );
    // Apagar o texto volta ao padrão.
    const back = await painel.put('/api/v1/platform/settings', {
      messageTemplates: { contatoPasso: '' },
    });
    expect(back.body.messageTemplates.contatoPasso).toBeUndefined();
  });

  it('valor combinado com prazo volta sozinho ao preço da tabela', async () => {
    const painel = await loginPlatform(app);
    const { companyId } = await criarConta();
    const r = await painel.put(`/api/v1/platform/companies/${companyId}`, {
      billingPriceCents: 29900,
      billingPriceUntil: '2027-02-27',
    });
    expect(r.body).toMatchObject({ priceCents: 29900 });
    expect(r.body.billingPriceUntil).toMatch(/^2027-02-28T02:59:59/);
    setClock(() => new Date('2027-03-01T12:00:00Z'));
    const list = await painel.get('/api/v1/platform/companies');
    expect(list.body.items.find((x: { id: number }) => x.id === companyId).priceCents).toBe(39900);
  });
});

describe('Telas usadas (49), sugestões agrupadas (50) e encerrar empresa (51)', () => {
  it('conta as telas abertas por empresa e mostra as que ninguém usa', async () => {
    const painel = await loginPlatform(app);
    const a = await criarConta('a@tapecaria.local');
    const b = await criarConta('b@tapecaria.local');
    for (const s of ['painel/orcamentos', 'painel/orcamentos', 'painel/clientes'])
      expect((await a.c.post('/api/v1/usage/screen', { screen: s })).status).toBe(204);
    await b.c.post('/api/v1/usage/screen', { screen: 'painel/orcamentos' });
    expect((await a.c.post('/api/v1/usage/screen', { screen: '../x' })).status).toBe(400);
    const r = await painel.get('/api/v1/platform/screens');
    expect(r.body.companies).toBe(2);
    expect(r.body.items[0]).toMatchObject({
      screen: 'painel/orcamentos',
      label: 'Orçamentos',
      companies: 2,
      views: 3,
    });
    expect(r.body.unused.map((u: { screen: string }) => u.screen)).toContain('painel/qualidade');
    expect(r.body.unused.map((u: { screen: string }) => u.screen)).not.toContain(
      'painel/orcamentos',
    );
    // As contagens são de cada empresa (trava do banco).
    expect(await db().screenView.count({ where: { companyId: b.companyId } })).toBe(1);
  });

  it('a chave da tela ignora números e códigos', () => {
    expect(screenKeyFor('/painel/os/123')).toBe('painel/os');
    expect(screenKeyFor('/painel/producao/hoje')).toBe('painel/producao/hoje');
    expect(screenKeyFor('/painel/pedidos/1b2c3d4e-0000-4000-8000-000000000000')).toBe(
      'painel/pedidos',
    );
    expect(screenKeyFor('/plataforma')).toBeNull();
  });

  it('junta sugestões parecidas de empresas diferentes', async () => {
    const painel = await loginPlatform(app);
    const a = await criarConta('a@tapecaria.local');
    const b = await criarConta('b@tapecaria.local');
    await a.c.post('/api/v1/feedback', {
      kind: 'SUGESTAO',
      message: 'Queria mandar o orçamento em PDF pelo WhatsApp',
    });
    await b.c.post('/api/v1/feedback', {
      kind: 'SUGESTAO',
      message: 'Mandar orçamento PDF no WhatsApp direto',
    });
    await b.c.post('/api/v1/feedback', { kind: 'SUGESTAO', message: 'Tema escuro na tela' });
    const r = await painel.get('/api/v1/platform/feedback/groups');
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({ companies: 2, count: 2 });
    expect(r.body.items).toHaveLength(2);
  });

  it('encerrar bloqueia na hora, guarda os dados 90 dias e dá para reabrir', async () => {
    const painel = await loginPlatform(app);
    const { c, companyId } = await criarConta();
    const errado = await painel.post(`/api/v1/platform/companies/${companyId}/close`, {
      reason: 'Fechou a oficina',
      confirmName: 'Outra',
    });
    expect(errado.status).toBe(400);
    const r = await painel.post(`/api/v1/platform/companies/${companyId}/close`, {
      reason: 'Fechou a oficina',
      confirmName: 'Tapeçaria Teste',
    });
    expect(r.status).toBe(200);
    const days = (Date.parse(r.body.purgeAfter) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(90);
    // A sessão da empresa caiu.
    expect((await c.get('/api/v1/subscription')).status).toBe(401);
    // Nada foi apagado.
    expect(await rawDb().user.count({ where: { companyId } })).toBe(1);
    const zip = await painel.get(`/api/v1/platform/companies/${companyId}/export.zip`);
    expect(zip.status).toBe(200);
    expect(zip.headers['content-type']).toBe('application/zip');
    const list = await painel.get('/api/v1/platform/companies');
    expect(list.body.items.find((x: { id: number }) => x.id === companyId)).toMatchObject({
      closeReason: 'Fechou a oficina',
    });
    const re = await painel.post(`/api/v1/platform/companies/${companyId}/reopen`, {});
    expect(re.status).toBe(200);
    const after = await rawDb().companySettings.findUniqueOrThrow({ where: { id: companyId } });
    expect(after).toMatchObject({ closedAt: null, blockedAt: null, purgeAfter: null });
  });
});

describe('Avisos no celular (43) e e-mails', () => {
  it('empresa nova chega no celular do dono da plataforma', async () => {
    const painel = await loginPlatform(app);
    await painel.put('/api/v1/platform/push', {
      endpoint: 'https://push.exemplo/painel-2',
      keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(10) },
    });
    const s = await painel.get('/api/v1/platform/settings');
    expect(s.body.pushDevices).toBe(1);
    expect(s.body.pushPublicKey.length).toBeGreaterThan(20);
    await criarConta();
    const { sendOnboardingEmails } = await import('../src/modules/onboarding/emails');
    await sendOnboardingEmails(app.ctx.system, 'https://teste.local');
    expect(pushes.map((p) => p.title)).toContain('Empresa nova: Tapeçaria Teste');
  });

  it('mensalidade: 3 dias antes, no dia, atrasada para o dono da plataforma', async () => {
    await loginPlatform(app);
    const { companyId } = await criarConta();
    await rawDb().companySettings.update({
      where: { id: companyId },
      data: {
        trialEndsAt: new Date('2026-11-01T00:00:00Z'),
        paidUntil: new Date('2026-12-10T02:59:59Z'),
      },
    });
    setClock(() => new Date('2026-12-07T13:00:00Z'));
    await sendBillingEmails(app.ctx.system, 'https://teste.local');
    await sendBillingEmails(app.ctx.system, 'https://teste.local');
    expect(await rawDb().outboundEmail.count({ where: { kind: 'mensalidade-antes' } })).toBe(1);
    setClock(() => new Date('2026-12-09T13:00:00Z'));
    await sendBillingEmails(app.ctx.system, 'https://teste.local');
    expect(await rawDb().outboundEmail.count({ where: { kind: 'mensalidade-no-dia' } })).toBe(1);
    setClock(() => new Date('2026-12-12T13:00:00Z'));
    await sendBillingEmails(app.ctx.system, 'https://teste.local');
    await sendBillingEmails(app.ctx.system, 'https://teste.local');
    expect(await rawDb().outboundEmail.count({ where: { kind: 'plataforma-atrasada' } })).toBe(1);
    const mail = await rawDb().outboundEmail.findFirstOrThrow({
      where: { kind: 'mensalidade-no-dia' },
    });
    expect(mail.text).toContain('R$');
    expect(mail.text).toContain('/painel/assinatura');
  });

  it('resumo da semana sai na segunda de manhã, uma vez, só com movimento', async () => {
    const { companyId } = await criarConta();
    await rawDb().companySettings.update({
      where: { id: companyId },
      data: { trialEndsAt: new Date('2027-01-30T00:00:00Z') },
    });
    // Domingo: não manda.
    setClock(() => new Date('2026-12-06T12:00:00Z'));
    expect(await sendWeeklySummaries(app.ctx.system, 'https://teste.local')).toBe(0);
    // Segunda, antes das 7h: não manda.
    setClock(() => new Date('2026-12-07T09:00:00Z'));
    expect(await sendWeeklySummaries(app.ctx.system, 'https://teste.local')).toBe(0);
    await rawDb().manualRevenue.create({
      data: {
        companyId,
        receivedAt: new Date('2026-12-03T00:00:00Z'),
        description: 'Reforma de poltrona',
        category: 'SERVICO',
        amountCents: 85000,
        method: 'PIX',
      },
    });
    setClock(() => new Date('2026-12-07T11:00:00Z'));
    expect(await sendWeeklySummaries(app.ctx.system, 'https://teste.local')).toBe(1);
    expect(await sendWeeklySummaries(app.ctx.system, 'https://teste.local')).toBe(0);
    const mail = await rawDb().outboundEmail.findFirstOrThrow({ where: { kind: 'resumo-semana' } });
    expect(mail.text).toMatch(/R\$\s850,00/);
    // Semana seguinte sem movimento: não manda.
    setClock(() => new Date('2026-12-14T11:00:00Z'));
    expect(await sendWeeklySummaries(app.ctx.system, 'https://teste.local')).toBe(0);
  });

  it('senha trocada e entrada num aparelho novo viram e-mail de segurança', async () => {
    const { c } = await criarConta();
    const r = await c.post('/api/auth/password', {
      currentPassword: 'senha1234',
      newPassword: 'senhanova123',
      newPasswordConfirm: 'senhanova123',
    });
    expect(r.status).toBe(204);
    expect(await rawDb().outboundEmail.count({ where: { kind: 'seguranca-senha' } })).toBe(1);
    // Mesmo navegador (o do teste): sem aviso.
    const mesmo = new Client(app);
    await mesmo.post('/api/auth/login', {
      email: 'dona@tapecaria.local',
      password: 'senhanova123',
    });
    expect(await rawDb().outboundEmail.count({ where: { kind: 'seguranca-aparelho' } })).toBe(0);
    const outro = new Client(app);
    const login = await outro.req(
      'POST',
      '/api/auth/login',
      { email: 'dona@tapecaria.local', password: 'senhanova123' },
      { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile' },
    );
    expect(login.status).toBe(200);
    const mail = await rawDb().outboundEmail.findFirstOrThrow({
      where: { kind: 'seguranca-aparelho' },
    });
    expect(mail.subject).toContain('Chrome no Android');
  });
});
