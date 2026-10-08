import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import {
  Client,
  createTestApp,
  db,
  idemKey,
  loginAdmin,
  resetDatabase,
  setupTablet,
} from './helpers';

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

/** Cria um usuário de painel com uma função personalizada contendo apenas as permissões dadas. */
async function panelUser(admin: Client, permissions: string[], tag: string) {
  const role = await admin.post(
    '/api/roles',
    { name: `Função ${tag}`, permissions: ['painel.acessar', ...permissions] },
    { 'idempotency-key': idemKey() },
  );
  expect(role.status).toBe(201);
  const email = `${tag}@teste.local`;
  const emp = await admin.post(
    '/api/employees',
    {
      fullName: `Pessoa ${tag}`,
      displayName: tag,
      jobTitle: 'Escritório',
      color: '#334455',
      roleIds: [role.body.id],
      email,
      password: 'SenhaSegura123',
    },
    { 'idempotency-key': idemKey() },
  );
  expect(emp.status).toBe(201);
  return loginAdmin(app, { email, password: 'SenhaSegura123' });
}

describe('Proteção de rotas', () => {
  it('toda rota /api declara regra de acesso e rotas protegidas exigem sessão', async () => {
    const routes = app.app.printRoutes({ commonPrefix: false });
    expect(routes).toContain('/api/employees');
    const anon = new Client(app);
    for (const url of [
      '/api/auth/me',
      '/api/employees',
      '/api/roles',
      '/api/permissions',
      '/api/devices',
      '/api/sessions',
      '/api/company/settings',
      '/api/audit',
      '/api/sync/status',
      '/api/sync/events',
    ]) {
      const r = await anon.get(url);
      expect(r.status, url).toBe(401);
      expect(r.body.error.code).toBe('UNAUTHENTICATED');
    }
    for (const [method, url] of [
      ['POST', '/api/employees'],
      ['POST', '/api/devices'],
      ['PUT', '/api/company/settings'],
      ['POST', '/api/sync/signal'],
    ] as const) {
      const r = await anon.req(method, url, {});
      expect(r.status, url).toBe(401);
    }
  });

  it('a aplicação se recusa a registrar rota /api sem regra de acesso', async () => {
    const extra = await createTestApp();
    expect(() => extra.app.get('/api/sem-regra', async () => ({ ok: true }))).toThrow(
      /sem regra de acesso/,
    );
    await extra.close();
  });

  it('rotas públicas permanecem acessíveis', async () => {
    const anon = new Client(app);
    expect((await anon.get('/api/health')).status).toBe(200);
    expect((await anon.get('/api/ready')).status).toBe(200);
    expect((await anon.get('/api/tablet/status')).body).toEqual({ paired: false });
  });
});

describe('Permissões administrativas', () => {
  it('permissão de leitura não autoriza escrita', async () => {
    const admin = await loginAdmin(app);
    const viewer = await panelUser(admin, ['funcionarios.ver'], 'leitor');
    expect((await viewer.get('/api/employees')).status).toBe(200);
    const write = await viewer.post(
      '/api/employees',
      { fullName: 'X Y', displayName: 'XY', jobTitle: 'T', color: '#111111', roleIds: [] },
      { 'idempotency-key': idemKey() },
    );
    expect(write.status).toBe(403);
    expect((await viewer.get('/api/devices')).status).toBe(403);
    expect((await viewer.get('/api/audit')).status).toBe(403);
  });

  it('impede escalonamento: ninguém concede permissão que não possui', async () => {
    const admin = await loginAdmin(app);
    const manager = await panelUser(admin, ['funcoes.ver', 'funcoes.gerenciar'], 'rh');
    const r = await manager.post(
      '/api/roles',
      { name: 'Superpoderes', permissions: ['sessoes.revogar'] },
      { 'idempotency-key': idemKey() },
    );
    expect(r.status).toBe(403);
    const ok = await manager.post(
      '/api/roles',
      { name: 'Somente leitura', permissions: ['funcoes.ver'] },
      { 'idempotency-key': idemKey() },
    );
    expect(ok.status).toBe(201);
  });

  it('revogar uma permissão tem efeito imediato na sessão já aberta', async () => {
    const admin = await loginAdmin(app);
    const viewer = await panelUser(admin, ['funcionarios.ver'], 'temp');
    expect((await viewer.get('/api/employees')).status).toBe(200);
    const role = await db().role.findFirstOrThrow({ where: { name: 'Função temp' } });
    const upd = await admin.put(`/api/roles/${role.id}`, {
      name: role.name,
      permissions: ['painel.acessar'],
      version: role.version,
    });
    expect(upd.status).toBe(200);
    expect((await viewer.get('/api/employees')).status).toBe(403);
  });

  it('a função Gestor é protegida e o último gestor não pode ser removido', async () => {
    const admin = await loginAdmin(app);
    const gestor = await db().role.findUniqueOrThrow({ where: { key: 'gestor' } });
    const r = await admin.put(`/api/roles/${gestor.id}`, {
      name: 'Gestor',
      permissions: ['painel.acessar'],
      version: gestor.version,
    });
    expect(r.status).toBe(422);
    expect((await admin.del(`/api/roles/${gestor.id}`)).status).toBe(422);

    const me = await db().employee.findFirstOrThrow({
      where: { user: { email: 'gestor@teste.local' } },
    });
    const tapeceiro = await db().role.findUniqueOrThrow({ where: { key: 'tapeceiro' } });
    const demote = await admin.put(`/api/employees/${me.id}`, {
      fullName: me.fullName,
      displayName: me.displayName,
      jobTitle: me.jobTitle,
      color: me.color,
      roleIds: [tapeceiro.id],
      extraPermissions: [],
      version: me.version,
    });
    expect(demote.status).toBe(422);
    const self = await admin.post(`/api/employees/${me.id}/status`, {
      active: false,
      version: me.version,
    });
    expect(self.status).toBe(422);
  });
});

describe('Permissões operacionais (tablet)', () => {
  it('sessão de tablet não acessa rotas do painel', async () => {
    const admin = await loginAdmin(app);
    const { tablet } = await setupTablet(app, admin, {
      name: 'Tablet R',
      employee: 'Ricardo',
      pin: '482915',
    });
    expect((await tablet.get('/api/auth/me')).status).toBe(200);
    expect((await tablet.get('/api/employees')).status).toBe(403);
    expect((await tablet.get('/api/devices')).status).toBe(403);
    expect((await tablet.get('/api/company/settings')).status).toBe(403);
    // ... mas pode usar o diagnóstico de sincronização (permissão da função Tapeceiro)
    const signal = await tablet.post(
      '/api/sync/signal',
      { message: 'oi' },
      { 'idempotency-key': idemKey() },
    );
    expect(signal.status).toBe(201);
  });

  it('sem permissão de produção, a sessão aberta perde acesso e novo login é negado', async () => {
    const admin = await loginAdmin(app);
    const { tablet, employee } = await setupTablet(app, admin, {
      name: 'Tablet compartilhado',
      employee: 'Márcio',
      pin: '193846',
      restrict: false,
    });
    expect((await tablet.get('/api/sync/status')).status).toBe(200);
    const tapeceiro = await db().role.findUniqueOrThrow({ where: { key: 'tapeceiro' } });
    const upd = await admin.put(`/api/roles/${tapeceiro.id}`, {
      name: tapeceiro.name,
      permissions: [],
      version: tapeceiro.version,
    });
    expect(upd.status).toBe(200);
    expect((await tablet.get('/api/sync/status')).status).toBe(403);
    const relogin = await tablet.post('/api/tablet/login', {
      employeeId: employee.id,
      pin: '193846',
    });
    expect(relogin.status).toBe(403);
  });
});
