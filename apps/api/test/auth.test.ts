import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { ADMIN, Client, createTestApp, db, loginAdmin, resetDatabase } from './helpers';

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

describe('Autenticação do painel', () => {
  it('gestor autentica e recebe cookie de sessão httpOnly + SameSite', async () => {
    const c = new Client(app);
    const res = await c.post('/api/auth/login', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(ADMIN.email);
    expect(res.body.permissions).toContain('funcionarios.gerenciar');
    const cookie = res.cookies.find((k) => k.name === 'cen_sid')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    // O token bruto nunca é gravado no banco (apenas o HMAC).
    const session = await db().session.findFirstOrThrow({ where: { kind: 'WEB' } });
    expect(session.tokenHash).not.toBe(cookie.value);
    expect(session.tokenHash).toHaveLength(64);

    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.session.kind).toBe('WEB');
  });

  it('senha incorreta e e-mail inexistente recebem a mesma resposta genérica', async () => {
    const a = await new Client(app).post('/api/auth/login', { ...ADMIN, password: 'errada12345' });
    const b = await new Client(app).post('/api/auth/login', {
      email: 'nao@existe.local',
      password: 'x',
    });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
    expect(a.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('bloqueia a conta após 5 tentativas erradas (proteção contra força bruta)', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await new Client(app).post('/api/auth/login', {
        ...ADMIN,
        password: 'errada12345',
      });
      expect(r.status).toBe(401);
    }
    const locked = await new Client(app).post('/api/auth/login', ADMIN);
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('logout revoga a sessão no servidor (cookie antigo deixa de valer)', async () => {
    const c = await loginAdmin(app);
    const stolen = c.cookieHeader;
    expect((await c.post('/api/auth/logout')).status).toBe(204);
    const replay = await app.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: stolen },
    });
    expect(replay.statusCode).toBe(401);
  });

  it('funcionário de produção não acessa o painel mesmo com credenciais válidas', async () => {
    const admin = await loginAdmin(app);
    const joao = await db().employee.findFirstOrThrow({ where: { displayName: 'João' } });
    const r = await admin.put(`/api/employees/${joao.id}/admin-access`, {
      email: 'joao@teste.local',
      password: 'SenhaDoJoao123',
    });
    expect(r.status).toBe(200);
    const login = await new Client(app).post('/api/auth/login', {
      email: 'joao@teste.local',
      password: 'SenhaDoJoao123',
    });
    expect(login.status).toBe(403);
  });

  it('funcionário desativado não consegue entrar e perde sessões abertas', async () => {
    const admin = await loginAdmin(app);
    // cria segundo gestor para poder desativá-lo
    const roles = (await admin.get('/api/roles')).body as { id: string; key: string }[];
    const gestorRole = roles.find((r) => r.key === 'gestor')!;
    const created = await admin.post(
      '/api/employees',
      {
        fullName: 'Segundo Gestor',
        displayName: 'Segundo',
        jobTitle: 'Gestor',
        color: '#123456',
        roleIds: [gestorRole.id],
        email: 'segundo@teste.local',
        password: 'SenhaSegura123',
      },
      { 'idempotency-key': 'k'.repeat(20) },
    );
    expect(created.status).toBe(201);
    const second = await loginAdmin(app, {
      email: 'segundo@teste.local',
      password: 'SenhaSegura123',
    });
    expect((await second.get('/api/auth/me')).status).toBe(200);

    const off = await admin.post(`/api/employees/${created.body.id}/status`, {
      active: false,
      version: created.body.version,
    });
    expect(off.status).toBe(200);
    expect((await second.get('/api/auth/me')).status).toBe(401);
    const again = await new Client(app).post('/api/auth/login', {
      email: 'segundo@teste.local',
      password: 'SenhaSegura123',
    });
    expect(again.status).toBe(401);
  });

  it('troca de senha encerra as outras sessões do usuário, mantendo a atual', async () => {
    const a = await loginAdmin(app);
    const b = await loginAdmin(app);
    const r = await a.post('/api/auth/password', {
      currentPassword: ADMIN.password,
      newPassword: 'NovaSenhaForte9',
    });
    expect(r.status).toBe(204);
    expect((await a.get('/api/auth/me')).status).toBe(200);
    expect((await b.get('/api/auth/me')).status).toBe(401);
    expect(
      (await new Client(app).post('/api/auth/login', { ...ADMIN, password: 'NovaSenhaForte9' }))
        .status,
    ).toBe(200);
  });

  it('rejeita requisições que alteram estado sem Origin permitido (CSRF)', async () => {
    const noOrigin = await new Client(app, null).post('/api/auth/login', ADMIN);
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    const evil = await new Client(app, 'https://site-malicioso.example').post(
      '/api/auth/login',
      ADMIN,
    );
    expect(evil.status).toBe(403);
  });

  it('registra login e logout na auditoria', async () => {
    const c = await loginAdmin(app);
    await c.post('/api/auth/logout');
    const actions = (await db().auditLog.findMany()).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.login', 'auth.logout']));
  });
});
