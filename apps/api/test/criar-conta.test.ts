/**
 * Criar conta pela tela de entrar: a conta entra direto, só com a função de consulta
 * (decisão do proprietário, 16/11/2026).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { Client, createTestApp, db, resetDatabase } from './helpers';

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

const NOVA = { email: 'Nova@Tapecaria.local', password: 'senha123', passwordConfirm: 'senha123' };

describe('Criar conta', () => {
  it('a conta entra direto no painel, só com a função de consulta', async () => {
    const r = await new Client(app).post('/api/auth/signup', NOVA);
    expect(r.status).toBe(201);
    const user = await db().user.findUniqueOrThrow({
      where: { email: 'nova@tapecaria.local' },
      include: { roles: { include: { role: { include: { permissions: true } } } }, employee: true },
    });
    expect(user.passwordHash).not.toContain('senha123');
    expect(user.employee?.jobTitle).toBe('Conta do site');
    expect(user.roles.map((x) => x.role.key)).toEqual(['consulta_site']);
    const perms = user.roles[0]!.role.permissions.map((p) => p.permission);
    expect(perms).toContain('painel.acessar');
    expect(perms).toContain('pedidos.ver');
    for (const p of perms) expect(p === 'painel.acessar' || p.endsWith('.ver')).toBe(true);
    expect(perms).not.toContain('sessoes.ver');
    expect(perms).not.toContain('auditoria.ver');

    const c = new Client(app);
    const login = await c.post('/api/auth/login', { email: NOVA.email, password: NOVA.password });
    expect(login.status).toBe(200);
    expect((await c.get('/api/employees')).status).toBe(200);
    // Não altera nada: nem funcionários (senhas), nem funções.
    const gestor = await db().employee.findFirstOrThrow({
      where: { user: { email: { not: null }, roles: { some: { role: { key: 'gestor' } } } } },
    });
    const troca = await c.put(`/api/employees/${gestor.id}/admin-access`, {
      email: 'invasor@x.local',
      password: 'Senha12345678',
    });
    expect(troca.status).toBe(403);
  });

  it('a segunda conta reaproveita a mesma função', async () => {
    await new Client(app).post('/api/auth/signup', NOVA);
    await new Client(app).post('/api/auth/signup', {
      email: 'outra@tapecaria.local',
      password: 'senha1234',
      passwordConfirm: 'senha1234',
    });
    expect(await db().role.count({ where: { key: 'consulta_site' } })).toBe(1);
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

  it('e-mail já cadastrado é recusado e não altera a conta existente', async () => {
    const existente = await db().user.findFirstOrThrow({ where: { email: { not: null } } });
    const r = await new Client(app).post('/api/auth/signup', {
      email: existente.email,
      password: 'outrasenha',
      passwordConfirm: 'outrasenha',
    });
    expect(r.status).toBe(409);
    const depois = await db().user.findUniqueOrThrow({ where: { id: existente.id } });
    expect(depois.passwordHash).toBe(existente.passwordHash);
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
