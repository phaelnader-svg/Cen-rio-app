/**
 * Primeiro dia de uma empresa nova (lista de 53 melhorias, 26/11/2026): perguntas do primeiro
 * acesso (item 2), começo guiado (1), convite do funcionário (4), explicação das telas (5),
 * pedido de ajuda (6), passo de cada empresa no painel da plataforma (42) e os e-mails do teste.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { sendOnboardingEmails } from '../src/modules/onboarding/emails';
import { roadKm } from '../src/modules/onboarding/city-coords';
import {
  Client,
  EMPRESA_NOVA,
  createTestApp,
  db,
  idemKey,
  loginAdmin,
  loginPlatform,
  rawDb,
  resetDatabase,
} from './helpers';

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  setClock();
});

async function criarConta() {
  const c = new Client(app);
  const r = await c.post('/api/auth/signup', {
    ...EMPRESA_NOVA,
    email: 'dona@tapecaria.local',
    password: 'senha1234',
    passwordConfirm: 'senha1234',
  });
  expect(r.status).toBe(201);
  const user = await db().user.findUniqueOrThrow({ where: { email: 'dona@tapecaria.local' } });
  return { c, companyId: user.companyId };
}

const RESPOSTAS = {
  pieces: ['SOFA', 'POLTRONA'],
  fabrics: [
    { name: 'Suede', priceCents: 2500 },
    { name: 'Linho', priceCents: 3600 },
  ],
  foams: [
    { name: 'D28', priceCents: 110_000 },
    { name: 'D33', priceCents: null },
  ],
  logistics: { mode: 'KM', valueCents: 250 },
  onSite: false,
  city: 'São José dos Campos - SP',
  servedCities: ['Jacareí - SP', 'Taubaté - SP'],
  maxInstallments: 3,
  taxRegime: 'SIMPLES',
  workingDays: [1, 2, 3, 4, 5, 6],
  workdayStart: '07:30',
  workdayEnd: '17:30',
  leadDays: 20,
  teamSize: 4,
  logoDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  monthlyGoalCents: 3_000_000,
};

describe('Perguntas do primeiro acesso e começo guiado', () => {
  it('a empresa nova responde as perguntas e o sistema monta a base do orçamento sozinho', async () => {
    const { c, companyId } = await criarConta();
    const antes = await c.get('/api/onboarding');
    expect(antes.body).toMatchObject({ show: true, askSetup: true });
    expect(antes.body.steps.map((s: { key: string }) => s.key)).toEqual([
      'perguntas',
      'precos',
      'equipe',
      'tablet',
      'orcamento',
      'celular',
    ]);
    expect(antes.body.steps.every((s: { done: boolean }) => !s.done)).toBe(true);

    const r = await c.post('/api/onboarding/setup', RESPOSTAS);
    expect(r.status).toBe(200);

    const itens = await db().quoteCatalogItem.findMany({ where: { companyId } });
    const de = (kind: string) => itens.filter((i) => i.kind === kind);
    // Mão de obra: só as peças marcadas, sem preço (decisão do dono).
    expect(de('MAO_TAPECEIRO').map((i) => i.name)).toEqual([
      'Sofá reto - 2 lugares',
      'Sofá reto - 3 lugares',
      'Sofá retrátil',
      'Sofá de canto',
      'Poltrona',
    ]);
    expect(de('MAO_TAPECEIRO').every((i) => i.priceCents === null)).toBe(true);
    expect(de('MAO_AJUDANTE')).toHaveLength(5);
    expect(de('MAO_AJUDANTE').every((i) => i.linkedItemId)).toBe(true);
    const suede = itens.find((i) => i.name === 'Suede')!;
    expect(suede).toMatchObject({ category: 'Tecidos', priceCents: 2500, unit: 'm' });
    expect(itens.find((i) => i.name === 'D28')).toMatchObject({ unit: 'm³', priceCents: 110_000 });
    expect(itens.find((i) => i.name === 'Cola')).toMatchObject({ category: 'Insumos' });
    // Frete calculado pela distância: a cidade da oficina com 10 km, as outras pelo mapa.
    const frete = de('LOGISTICA');
    expect(frete.map((i) => i.name)).toEqual(['São José dos Campos', 'Jacareí', 'Taubaté']);
    expect(frete[0]).toMatchObject({ priceCents: 5000 });
    expect(Number(frete[1]!.km)).toBeGreaterThan(5);
    expect(Number(frete[1]!.km)).toBeLessThan(40);
    expect(frete[1]!.priceCents).toBe(Math.round(Number(frete[1]!.km) * 2 * 250));
    // Maquininha até 3 vezes.
    expect(de('TAXA_MAQUINA').map((i) => [i.name, i.rateBps])).toEqual([
      ['À vista', 320],
      ['2X', 450],
      ['3X', 580],
    ]);

    const company = await db().companySettings.findUniqueOrThrow({ where: { id: companyId } });
    expect(company).toMatchObject({
      workingDays: [1, 2, 3, 4, 5, 6],
      workdayStart: '07:30',
      workdayEnd: '17:30',
      teamSize: 4,
      monthlyGoalCents: 3_000_000,
      servesOnSite: false,
      taxRateBps: 600,
    });
    expect(company.setupDoneAt).not.toBeNull();
    const qs = await db().quoteSettings.findUniqueOrThrow({ where: { companyId } });
    expect(qs).toMatchObject({ taxRateBps: 600, defaultDeliveryDays: 20 });
    expect(qs.logoDataUrl).toContain('data:image/png');
    expect((await c.get('/api/auth/me')).body.company.servesOnSite).toBe(false);

    // Não responde duas vezes.
    expect((await c.post('/api/onboarding/setup', RESPOSTAS)).status).toBe(422);

    const depois = await c.get('/api/onboarding');
    expect(depois.body.askSetup).toBe(false);
    const passo = (k: string) => depois.body.steps.find((s: { key: string }) => s.key === k);
    expect(passo('perguntas').done).toBe(true);
    expect(passo('precos')).toMatchObject({ done: false, hint: '0 de 5 peças com preço.' });

    // Preços colocados: o passo se marca sozinho.
    for (const i of de('MAO_TAPECEIRO'))
      await c.req('PATCH', `/api/v1/quotes/catalog/${i.id}`, { priceCents: 30_000 });
    const comPreco = await c.get('/api/onboarding');
    expect(comPreco.body.steps.find((s: { key: string }) => s.key === 'precos').done).toBe(true);
  });

  it('quem não faz retirada nem entrega fica sem a logística; a Cenário Estofados não vê o começo', async () => {
    const { c } = await criarConta();
    const r = await c.post('/api/onboarding/setup', {
      ...RESPOSTAS,
      logistics: { mode: 'NAO', valueCents: null },
      servedCities: [],
    });
    expect(r.status).toBe(200);
    expect((await c.get('/api/v1/modules')).body.logistica).toBe(false);

    const admin = await loginAdmin(app);
    const cenario = await admin.get('/api/onboarding');
    expect(cenario.body).toMatchObject({ show: false, askSetup: false });
  });

  it('"Já sei usar" esconde o cartão; pedido de ajuda aparece no painel da plataforma', async () => {
    const { c, companyId } = await criarConta();
    await loginPlatform(app);
    const quando = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const ajuda = await c.post('/api/onboarding/help', { preferredAt: quando, note: 'De manhã' });
    expect(ajuda.status).toBe(200);
    expect((await c.get('/api/onboarding')).body.helpRequestedFor).toBe(quando);
    const mail = await rawDb().outboundEmail.findFirst({ where: { kind: 'plataforma-ajuda' } });
    expect(mail?.subject).toContain('quer ajuda para começar');

    const painel = await loginPlatform(app);
    const lista = await painel.get('/api/v1/platform/companies');
    const nova = lista.body.items.find((x: { id: number }) => x.id === companyId);
    expect(nova.helpRequestedFor).toBe(quando);
    expect(nova.gettingStarted).toMatchObject({
      done: 0,
      total: 6,
      nextLabel: 'Responder as perguntas do começo',
    });
    expect(decodeURIComponent(nova.contactWhatsappUrl)).toContain(
      'ainda não fez o passo "Responder as perguntas do começo"',
    );
    const feito = await painel.post(`/api/v1/platform/companies/${companyId}/help-done`, {});
    expect(feito.body.helpRequestedFor).toBeNull();

    expect((await c.post('/api/onboarding/hide', {})).status).toBe(200);
    expect((await c.get('/api/onboarding')).body.show).toBe(false);
  });

  it('a explicação de cada tela some para sempre depois do X', async () => {
    const { c } = await criarConta();
    expect((await c.get('/api/me/tips')).body.seen).toEqual([]);
    expect((await c.post('/api/me/tips/orcamentos', {})).status).toBe(200);
    expect((await c.post('/api/me/tips/orcamentos', {})).status).toBe(200);
    expect((await c.get('/api/me/tips')).body.seen).toEqual(['orcamentos']);
    expect((await c.post('/api/me/tips/Nada%20Disso', {})).status).toBe(400);
  });
});

describe('Funcionário termina o cadastro pelo link (item 4)', () => {
  it('o gestor manda o link; a pessoa cria o PIN e o link não vale de novo', async () => {
    const { c } = await criarConta();
    const roles = (await c.get('/api/roles')).body as { id: string; key: string }[];
    const tapeceiro = roles.find((r) => r.key === 'tapeceiro')!;
    const novo = await c.post(
      '/api/employees',
      {
        fullName: 'Bruno Lima',
        displayName: 'Bruno',
        jobTitle: 'Tapeceiro',
        phone: '(12) 99876-5432',
        color: '#1d4ed8',
        roleIds: [tapeceiro.id],
        extraPermissions: [],
      },
      { 'idempotency-key': idemKey() },
    );
    expect(novo.status).toBe(201);
    const convite = await c.post(`/api/employees/${novo.body.id}/invite`, {});
    expect(convite.status).toBe(200);
    expect(decodeURIComponent(convite.body.whatsappUrl)).toContain('crie o PIN');
    expect(convite.body.whatsappUrl).toContain('wa.me/5512998765432');
    const token = decodeURIComponent(convite.body.url.split('/convite/')[1]);
    // O token não fica guardado em claro.
    expect(JSON.stringify(await db().employeeInvite.findMany())).not.toContain(token);

    const pub = new Client(app);
    const info = await pub.get(`/api/public/convite/${encodeURIComponent(token)}`);
    expect(info.body).toMatchObject({
      companyName: 'Tapeçaria Teste',
      employeeName: 'Bruno',
      valid: true,
      hasPhoto: false,
    });
    expect(
      (await pub.post(`/api/public/convite/${encodeURIComponent(token)}`, { pin: '123456' }))
        .status,
    ).toBe(400);
    const ok = await pub.post(`/api/public/convite/${encodeURIComponent(token)}`, {
      pin: '402917',
    });
    expect(ok.status).toBe(200);
    const user = await db().employee.findUniqueOrThrow({
      where: { id: novo.body.id },
      include: { user: true },
    });
    expect(user.user.pinHash).toBeTruthy();
    expect((await pub.get(`/api/public/convite/${encodeURIComponent(token)}`)).body.valid).toBe(
      false,
    );
    expect(
      (await pub.post(`/api/public/convite/${encodeURIComponent(token)}`, { pin: '402917' }))
        .status,
    ).toBe(422);
    // Com um funcionário a mais, o passo "equipe" se marca.
    const passos = (await c.get('/api/onboarding')).body.steps;
    expect(passos.find((s: { key: string }) => s.key === 'equipe').done).toBe(true);
  });
});

describe('E-mails do teste grátis', () => {
  it('boas-vindas no cadastro, aviso de empresa nova, dia 2, faltando 2 dias e fim do teste', async () => {
    await loginPlatform(app);
    const { companyId } = await criarConta();
    const boas = await rawDb().outboundEmail.findFirstOrThrow({ where: { kind: 'boas-vindas' } });
    expect(boas.text).toContain('Responda as perguntas do começo');
    expect(boas.text).toContain('/entrar/confirmar?token=');

    const web = 'https://cenariogestao.com.br';
    // Já tem telefone (veio no cadastro de teste): o dono da plataforma é avisado.
    await sendOnboardingEmails(rawDb(), web);
    const nova = await rawDb().outboundEmail.findFirstOrThrow({
      where: { kind: 'plataforma-empresa-nova' },
    });
    expect(nova.subject).toBe('Empresa nova: Tapeçaria Teste');
    expect(nova.text).toContain('Telefone: (11) 98765-4321');
    await sendOnboardingEmails(rawDb(), web);
    expect(await rawDb().outboundEmail.count({ where: { kind: 'plataforma-empresa-nova' } })).toBe(
      1,
    );

    const criada = (await rawDb().companySettings.findUniqueOrThrow({ where: { id: companyId } }))
      .createdAt;
    const dia = (n: number) => new Date(criada.getTime() + n * 86_400_000 + 60_000);
    setClock(() => dia(2));
    await sendOnboardingEmails(rawDb(), web);
    const dois = await rawDb().outboundEmail.findFirstOrThrow({ where: { kind: 'teste-dia-2' } });
    expect(dois.subject).toBe('Faça o seu primeiro orçamento em 2 minutos');
    setClock(() => dia(5));
    await sendOnboardingEmails(rawDb(), web);
    const cinco = await rawDb().outboundEmail.findFirstOrThrow({ where: { kind: 'teste-dia-5' } });
    expect(cinco.text).toContain('Faltam 2 dias');
    expect(cinco.text).toContain('R$');
    setClock(() => dia(7.1));
    await sendOnboardingEmails(rawDb(), web);
    const fim = await rawDb().outboundEmail.findFirstOrThrow({
      where: { kind: 'teste-fim-teste' },
    });
    expect(fim.text).toContain('nada foi apagado');
    // Um de cada, nunca repetido.
    await sendOnboardingEmails(rawDb(), web);
    const teste = await rawDb().outboundEmail.findMany({
      where: { kind: { startsWith: 'teste-' } },
    });
    expect(teste).toHaveLength(3);
    // Só para quem é da empresa (nunca o gestor da Cenário Estofados).
    expect(teste.every((m) => m.to === 'dona@tapecaria.local')).toBe(true);
  });
});

describe('Distância entre cidades', () => {
  it('calcula a estrada aproximada e aceita nome sem acento', () => {
    const km = roadKm('São Paulo - SP', 'Campinas - SP')!;
    expect(km).toBeGreaterThan(80);
    expect(km).toBeLessThan(120);
    expect(roadKm('sao paulo - sp', 'CAMPINAS - SP')).toBe(km);
    expect(roadKm('Cidade Que Não Existe - XX', 'Campinas - SP')).toBeNull();
  });
});
