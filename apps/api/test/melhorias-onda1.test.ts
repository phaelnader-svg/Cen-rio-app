/**
 * Melhorias (onda 1): boas-vindas da empresa criada pelo Criar conta e exportação de clientes,
 * pedidos e OS para planilha, sempre só com os dados da própria empresa.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { createCustomer } from './commercial-helpers';
import { Client, createTestApp, db, loginAdmin, resetDatabase } from './helpers';

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

async function criarConta() {
  const c = new Client(app);
  const r = await c.post('/api/auth/signup', {
    email: 'boasvindas@tapecaria.local',
    password: 'senha123',
    passwordConfirm: 'senha123',
  });
  expect(r.status).toBe(201);
  return c;
}

describe('Boas-vindas da empresa nova', () => {
  it('pede o nome da empresa e da pessoa uma vez só, e grava os dois', async () => {
    const c = await criarConta();
    const me = await c.get('/api/auth/me');
    expect(me.body.company.tradeName).toBe('Minha empresa');
    expect(me.body.company.needsWelcome).toBe(true);
    expect(me.body.user.displayName).toBe('boasvindas');

    const provisorio = await c.post('/api/company/welcome', {
      tradeName: 'Minha empresa',
      displayName: 'Ana',
    });
    expect(provisorio.status).toBe(400);

    const ok = await c.post('/api/company/welcome', {
      tradeName: 'Tapeçaria Silva',
      displayName: 'Ana Silva',
    });
    expect(ok.status).toBe(200);
    const depois = await c.get('/api/auth/me');
    expect(depois.body.company.tradeName).toBe('Tapeçaria Silva');
    expect(depois.body.company.needsWelcome).toBe(false);
    expect(depois.body.user.displayName).toBe('Ana Silva');
    const emp = await db().employee.findFirstOrThrow({
      where: { user: { email: 'boasvindas@tapecaria.local' } },
    });
    expect(emp.displayName).toBe('Ana Silva');

    // Depois de concluídas, as boas-vindas não alteram mais nada (o nome muda pela tela Empresa).
    const denovo = await c.post('/api/company/welcome', {
      tradeName: 'Outro nome',
      displayName: 'Ana',
    });
    expect(denovo.status).toBe(422);
  });

  it('a Cenário Estofados nunca vê as boas-vindas nem consegue usá-las', async () => {
    const admin = await loginAdmin(app);
    const me = await admin.get('/api/auth/me');
    expect(me.body.company.needsWelcome).toBe(false);
    const r = await admin.post('/api/company/welcome', {
      tradeName: 'Outra',
      displayName: 'Fulano',
    });
    expect(r.status).toBe(422);
    const empresa = await db().companySettings.findUniqueOrThrow({ where: { id: 1 } });
    expect(empresa.tradeName).not.toBe('Outra');
  });
});

describe('Exportar para planilha', () => {
  it('clientes, pedidos e OS saem em CSV e só com os dados da própria empresa', async () => {
    const admin = await loginAdmin(app);
    await createCustomer(admin, { name: 'Cliente Só da Cenário' });
    const nova = await criarConta();
    await createCustomer(nova, { name: 'Cliente Da Nova' });

    const csv = await nova.req('GET', '/api/v1/export/clientes.csv');
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    expect(String(csv.headers['content-disposition'])).toContain('clientes-');
    const text = String(csv.body);
    expect(text).toContain('Cliente Da Nova');
    expect(text).not.toContain('Cliente Só da Cenário');

    const daCenario = String((await admin.get('/api/v1/export/clientes.csv')).body);
    expect(daCenario).toContain('Cliente Só da Cenário');
    expect(daCenario).not.toContain('Cliente Da Nova');

    for (const path of ['/api/v1/export/pedidos.csv', '/api/v1/export/os.csv']) {
      const r = await nova.get(path);
      expect(r.status).toBe(200);
      expect(String(r.headers['content-type'])).toContain('text/csv');
    }
  });

  it('sem sessão não exporta', async () => {
    const anon = new Client(app);
    expect((await anon.get('/api/v1/export/clientes.csv')).status).toBe(401);
  });
});
