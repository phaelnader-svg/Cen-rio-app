/**
 * Criar conta pela tela de entrar: a conta nasce sem acesso e só entra no painel depois que o
 * gestor libera (Funcionários → Contas aguardando liberação).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { Client, createTestApp, db, loginAdmin, resetDatabase } from './helpers';

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

const NOVA = { email: 'Nova@Tapecaria.local', password: 'senha123', passwordConfirm: 'senha123' };

async function gestorRoleId(c: Client) {
  const roles = await c.get('/api/roles');
  const role = roles.body.find((r: { permissions: string[] }) =>
    r.permissions.includes('painel.acessar'),
  );
  return role.id as string;
}

describe('Criar conta', () => {
  it('cria a conta sem acesso: o login avisa que aguarda liberação', async () => {
    const r = await new Client(app).post('/api/auth/signup', NOVA);
    expect(r.status).toBe(202);
    const user = await db().user.findUniqueOrThrow({
      where: { email: 'nova@tapecaria.local' },
      include: { roles: true, permissions: true, employee: true },
    });
    expect(user.roles).toHaveLength(0);
    expect(user.permissions).toHaveLength(0);
    expect(user.employee).toBeNull();
    expect(user.passwordHash).not.toContain('senha123');

    const login = await new Client(app).post('/api/auth/login', {
      email: NOVA.email,
      password: NOVA.password,
    });
    expect(login.status).toBe(403);
    expect(login.body.error.message).toMatch(/aguarda a liberação do gestor/);
  });

  it('valida senha de no mínimo 8 caracteres e a confirmação', async () => {
    const curta = await new Client(app).post('/api/auth/signup', {
      ...NOVA,
      password: 'abc1234',
      passwordConfirm: 'abc1234',
    });
    expect(curta.status).toBe(400);
    const diferente = await new Client(app).post('/api/auth/signup', {
      ...NOVA,
      passwordConfirm: 'senha124',
    });
    expect(diferente.status).toBe(400);
    expect(await db().user.count({ where: { email: 'nova@tapecaria.local' } })).toBe(0);
  });

  it('e-mail já cadastrado recebe a mesma resposta e não altera a conta existente', async () => {
    const existente = await db().user.findFirstOrThrow({ where: { email: { not: null } } });
    const r = await new Client(app).post('/api/auth/signup', {
      email: existente.email,
      password: 'outrasenha',
      passwordConfirm: 'outrasenha',
    });
    expect(r.status).toBe(202);
    const depois = await db().user.findUniqueOrThrow({ where: { id: existente.id } });
    expect(depois.passwordHash).toBe(existente.passwordHash);
  });

  it('o gestor vê o pedido, libera com uma função e a conta passa a entrar no painel', async () => {
    await new Client(app).post('/api/auth/signup', NOVA);
    const gestor = await loginAdmin(app);
    const lista = await gestor.get('/api/account-requests');
    expect(lista.status).toBe(200);
    expect(lista.body).toHaveLength(1);
    expect(lista.body[0].email).toBe('nova@tapecaria.local');

    const ok = await gestor.post(`/api/account-requests/${lista.body[0].userId}/approve`, {
      fullName: 'Maria Nova',
      displayName: 'Maria',
      jobTitle: 'Escritório',
      color: '#1F5F5B',
      roleIds: [await gestorRoleId(gestor)],
    });
    expect(ok.status).toBe(201);
    expect(ok.body.adminEmail).toBe('nova@tapecaria.local');
    expect((await gestor.get('/api/account-requests')).body).toHaveLength(0);

    const login = await new Client(app).post('/api/auth/login', {
      email: NOVA.email,
      password: NOVA.password,
    });
    expect(login.status).toBe(200);
  });

  it('o gestor pode recusar: a conta é apagada', async () => {
    await new Client(app).post('/api/auth/signup', NOVA);
    const gestor = await loginAdmin(app);
    const [pedido] = (await gestor.get('/api/account-requests')).body;
    const r = await gestor.post(`/api/account-requests/${pedido.userId}/reject`);
    expect(r.status).toBe(200);
    expect(await db().user.count({ where: { email: 'nova@tapecaria.local' } })).toBe(0);
  });

  it('funcionários existentes nunca aparecem como pedido nem podem ser apagados por aqui', async () => {
    const gestor = await loginAdmin(app);
    expect((await gestor.get('/api/account-requests')).body).toHaveLength(0);
    const func = await db().employee.findFirstOrThrow();
    const r = await gestor.post(`/api/account-requests/${func.userId}/reject`);
    expect(r.status).toBe(404);
  });

  it('sem sessão de gestor não lista nem libera', async () => {
    expect((await new Client(app).get('/api/account-requests')).status).toBe(401);
  });

  it('limita a quantidade de contas criadas', async () => {
    let ultimo = 0;
    for (let i = 0; i < 45; i++) {
      const r = await new Client(app).post('/api/auth/signup', {
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
