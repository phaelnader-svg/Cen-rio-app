/**
 * Multi-empresa — etapa 4: "Criar conta" cria uma EMPRESA NOVA, com dados separados, e entra
 * direto (decisão do dono, 16/11/2026). Nunca entra na Cenário Estofados (empresa 1).
 * Também cobre o painel do dono da plataforma (lista de empresas, bloquear/liberar).
 */
import { DEFAULT_ROLES, GESTOR_ROLE_KEY } from '@cenario/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { createCustomer } from './commercial-helpers';
import {
  Client,
  loginPlatform,
  createTestApp,
  db,
  idemKey,
  loginAdmin,
  resetDatabase,
  EMPRESA_NOVA,
} from './helpers';

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

const NOVA = {
  ...EMPRESA_NOVA,
  email: 'Nova@Tapecaria.local',
  password: 'senha123',
  passwordConfirm: 'senha123',
};

async function criarConta(dados = NOVA) {
  const c = new Client(app);
  const r = await c.post('/api/auth/signup', dados);
  return { c, r };
}

describe('Criar conta (empresa nova)', () => {
  it('cria uma empresa nova, entra direto como gestor dela e não vê nada da Cenário Estofados', async () => {
    const admin = await loginAdmin(app);
    const daCenario = await createCustomer(admin, { name: 'Cliente da Cenário' });

    const { c, r } = await criarConta();
    expect(r.status).toBe(201);
    const user = await db().user.findUniqueOrThrow({
      where: { email: 'nova@tapecaria.local' },
      include: { roles: { include: { role: true } }, employee: true },
    });
    expect(user.companyId).not.toBe(1);
    expect(user.passwordHash).not.toContain('senha123');
    expect(user.roles.map((x) => x.role.key)).toEqual([GESTOR_ROLE_KEY]);
    expect(user.roles[0]!.role.companyId).toBe(user.companyId);
    expect(user.employee?.companyId).toBe(user.companyId);

    // Já entrou: o cookie de sessão veio na resposta.
    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.permissions).toContain('empresa.configurar');

    // Nada da empresa 1 aparece.
    const lista = await c.get('/api/v1/customers');
    expect(lista.status).toBe(200);
    expect(JSON.stringify(lista.body)).not.toContain(daCenario.id);
    expect((await c.get(`/api/v1/customers/${daCenario.id}`)).status).toBe(404);
    const funcionarios = await c.get('/api/employees');
    expect(JSON.stringify(funcionarios.body)).not.toContain('Ricardo');

    // E pode trabalhar na própria empresa.
    const proprio = await createCustomer(c, { name: 'Cliente da nova' });
    const row = await db().customer.findUniqueOrThrow({ where: { id: proprio.id } });
    expect(row.companyId).toBe(user.companyId);
    // A Cenário Estofados continua sem ver o cliente da empresa nova.
    const daAdmin = await admin.get('/api/v1/customers');
    expect(JSON.stringify(daAdmin.body)).not.toContain(proprio.id);
  });

  it('a empresa nova recebe o conteúdo inicial próprio (funções, modelos, locais), sem copiar preços', async () => {
    await criarConta();
    const { companyId } = await db().user.findUniqueOrThrow({
      where: { email: 'nova@tapecaria.local' },
    });
    const roles = await db().role.findMany({ where: { companyId } });
    expect(roles.map((r) => r.key).sort()).toEqual(DEFAULT_ROLES.map((r) => r.key).sort());
    expect(await db().productionTemplate.count({ where: { companyId } })).toBeGreaterThan(0);
    expect(await db().qualityTemplate.count({ where: { companyId } })).toBeGreaterThan(0);
    expect(await db().itemLocation.count({ where: { companyId } })).toBeGreaterThan(0);
    expect(await db().quoteCatalogItem.count({ where: { companyId } })).toBe(0);
    // O conteúdo da empresa 1 ficou como estava.
    expect(await db().role.count({ where: { companyId: 1 } })).toBe(DEFAULT_ROLES.length);
  });

  it('duas contas criam duas empresas diferentes, cada uma com a própria numeração', async () => {
    const a = await criarConta();
    const b = await criarConta({
      ...EMPRESA_NOVA,
      email: 'outra@tapecaria.local',
      password: 'senha1234',
      passwordConfirm: 'senha1234',
    });
    expect(a.r.status).toBe(201);
    expect(b.r.status).toBe(201);
    const users = await db().user.findMany({
      where: { email: { in: ['nova@tapecaria.local', 'outra@tapecaria.local'] } },
    });
    expect(new Set(users.map((u) => u.companyId)).size).toBe(2);
    const ca = await createCustomer(a.c, { name: 'Cliente A' });
    const cb = await createCustomer(b.c, { name: 'Cliente B' });
    expect(JSON.stringify((await a.c.get('/api/v1/customers')).body)).not.toContain(cb.id);
    expect(JSON.stringify((await b.c.get('/api/v1/customers')).body)).not.toContain(ca.id);
  });

  it('cada empresa liga e desliga os próprios módulos', async () => {
    const admin = await loginAdmin(app);
    const { c } = await criarConta();
    const modulos = (await admin.get('/api/company/modules')).body as {
      key: string;
      configurable: boolean;
      enabled: boolean;
    }[];
    const m = modulos.find((x) => x.configurable)!;
    expect(m).toBeTruthy();
    const trocar = (cl: Client) =>
      cl.req(
        'PUT',
        `/api/company/modules/${m.key}`,
        { enabled: !m.enabled, version: 0 },
        {
          'idempotency-key': idemKey(),
        },
      );
    expect((await trocar(admin)).status).toBe(200);
    expect((await trocar(c)).status).toBe(200);
    expect(await db().moduleSetting.count({ where: { key: m.key } })).toBe(2);
    // A troca de uma não muda a outra.
    const daNova = (await c.get('/api/company/modules')).body as { key: string; version: number }[];
    expect(daNova.find((x) => x.key === m.key)!.version).toBe(1);
  });

  it('jogo: cada empresa ganha os próprios ambientes, com as mesmas chaves', async () => {
    const admin = await loginAdmin(app);
    const { c } = await criarConta();
    const daCenario = await admin.get('/api/v1/game/spaces');
    const daNova = await c.get('/api/v1/game/spaces');
    expect(daCenario.status).toBe(200);
    expect(daNova.status).toBe(200);
    const ids = (r: { body: unknown }) => (r.body as { id: string }[]).map((x) => x.id);
    const chaves = (r: { body: unknown }) => (r.body as { key: string }[]).map((x) => x.key);
    expect(chaves(daNova).sort()).toEqual(chaves(daCenario).sort());
    for (const id of ids(daNova)) expect(ids(daCenario)).not.toContain(id);
  });

  it('conexões externas (chaves do servidor) ficam só na Cenário Estofados por enquanto', async () => {
    const { c } = await criarConta();
    const r = await c.post('/api/v1/connections/ASAAS/connect', { apiKey: 'chave-qualquer-123' });
    expect(r.status).toBe(422);
    expect(await db().integrationConnection.count({ where: { companyId: { not: 1 } } })).toBe(0);
  });

  it('valida senha de no mínimo 8 caracteres e a confirmação', async () => {
    // 26/11/2026: sem WhatsApp (ou sem DDD), sem nome da empresa ou sem nome, não cria.
    for (const falta of [
      { whatsapp: '' },
      { whatsapp: '98765-4321' },
      { companyName: '' },
      { companyName: 'Minha empresa' },
      { ownerName: '' },
    ])
      expect((await criarConta({ ...NOVA, ...falta })).r.status).toBe(400);
    const curta = await criarConta({ ...NOVA, password: 'abc1234', passwordConfirm: 'abc1234' });
    expect(curta.r.status).toBe(400);
    const diferente = await criarConta({ ...NOVA, passwordConfirm: 'senha124' });
    expect(diferente.r.status).toBe(400);
    expect(await db().user.count({ where: { email: 'nova@tapecaria.local' } })).toBe(0);
    expect(await db().companySettings.count({ where: { isPlatform: false } })).toBe(1);
  });

  it('e-mail já cadastrado é recusado, não cria empresa e não altera a conta existente', async () => {
    const existente = await db().user.findFirstOrThrow({ where: { email: { not: null } } });
    const { r } = await criarConta({
      ...EMPRESA_NOVA,
      email: existente.email!,
      password: 'outrasenha1',
      passwordConfirm: 'outrasenha1',
    });
    expect(r.status).toBe(409);
    const depois = await db().user.findUniqueOrThrow({ where: { id: existente.id } });
    expect(depois.passwordHash).toBe(existente.passwordHash);
    expect(depois.companyId).toBe(1);
    expect(await db().companySettings.count({ where: { isPlatform: false } })).toBe(1);
  });

  it('limita a quantidade de contas criadas', async () => {
    let ultimo = 0;
    for (let i = 0; i < 45; i++) {
      const { r } = await criarConta({
        ...EMPRESA_NOVA,
        email: `conta${i}@teste.local`,
        password: 'senha12345',
        passwordConfirm: 'senha12345',
      });
      ultimo = r.status;
      if (r.status === 429) break;
    }
    expect(ultimo).toBe(429);
  });
});

describe('Painel do dono da plataforma', () => {
  it('o painel da plataforma vê as empresas e bloqueia/libera uma delas', async () => {
    const admin = await loginPlatform(app);
    const estofados = await loginAdmin(app);
    const { c } = await criarConta();
    const { companyId } = await db().user.findUniqueOrThrow({
      where: { email: 'nova@tapecaria.local' },
    });

    const lista = await admin.get('/api/v1/platform/companies');
    expect(lista.status).toBe(200);
    const nova = lista.body.items.find((e: { id: number }) => e.id === companyId);
    expect(nova).toMatchObject({ ownerEmail: 'nova@tapecaria.local', users: 1, blockedAt: null });
    expect(lista.body.items.map((e: { id: number }) => e.id)).not.toContain(0);
    expect(lista.body.items.find((e: { id: number }) => e.id === 1)).toMatchObject({
      serverConnections: true,
    });

    const bloqueio = await admin.post(`/api/v1/platform/companies/${companyId}/block`, {
      reason: 'Teste',
    });
    expect(bloqueio.status).toBe(200);
    // A sessão aberta da empresa bloqueada deixa de valer, e o login é recusado.
    expect((await c.get('/api/auth/me')).status).toBe(401);
    const login = await new Client(app).post('/api/auth/login', {
      email: NOVA.email,
      password: NOVA.password,
    });
    expect(login.status).toBe(403);
    // A Cenário Estofados segue normal.
    expect((await estofados.get('/api/auth/me')).status).toBe(200);

    expect((await admin.post(`/api/v1/platform/companies/${companyId}/unblock`, {})).status).toBe(
      200,
    );
    const volta = await new Client(app).post('/api/auth/login', {
      email: NOVA.email,
      password: NOVA.password,
    });
    expect(volta.status).toBe(200);
  });

  it('o registro da plataforma (nº 0) não é empresa: não se bloqueia nem se edita', async () => {
    const admin = await loginPlatform(app);
    expect((await admin.post('/api/v1/platform/companies/0/block', {})).status).toBe(404);
    expect((await admin.put('/api/v1/platform/companies/0', { note: 'x' })).status).toBe(404);
    expect(await db().companySettings.count({ where: { blockedAt: { not: null } } })).toBe(0);
  });

  it('nenhum login de empresa (nem o da Cenário Estofados) enxerga o painel da plataforma', async () => {
    const { c } = await criarConta();
    expect((await c.get('/api/v1/platform/companies')).status).toBe(401);
    expect((await c.post('/api/v1/platform/companies/1/block', {})).status).toBe(401);
    const estofados = await loginAdmin(app);
    expect((await estofados.get('/api/v1/platform/companies')).status).toBe(401);
    expect(await db().companySettings.count({ where: { blockedAt: { not: null } } })).toBe(0);
  });
});
