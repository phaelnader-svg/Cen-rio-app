import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { address, createCustomer, FAKE_CNPJ, FAKE_CPF, panelUserWith } from './commercial-helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

describe('Clientes — cadastro, edição e consulta', () => {
  it('cadastra pessoa física e jurídica com endereços e valida CPF/CNPJ', async () => {
    const admin = await loginAdmin(app);
    const pf = await createCustomer(admin, {
      name: 'Maria Teste da Silva',
      document: '529.982.247-25',
    });
    expect(pf.document).toBe(FAKE_CPF[0]);
    expect(pf.phone).toBe('11900000001');
    expect(pf.addresses).toHaveLength(1);
    expect(pf.addresses[0].isPrimary).toBe(true);
    expect(pf.addresses[0].postalCode).toBe('01000000');

    const pj = await createCustomer(admin, {
      kind: 'PJ',
      name: 'Hotel Fictício Ltda',
      tradeName: 'Hotel Teste',
      document: FAKE_CNPJ,
      phone: null,
      email: 'Compras@Hotel.Example',
    });
    expect(pj.email).toBe('compras@hotel.example');

    const badCpf = await admin.post(
      '/api/v1/customers',
      { kind: 'PF', name: 'CPF Errado', document: '123.456.789-00' },
      { 'idempotency-key': idemKey() },
    );
    expect(badCpf.status).toBe(400);
    expect(badCpf.body.error.details[0].path).toBe('document');
    const cnpjOnPf = await admin.post(
      '/api/v1/customers',
      { kind: 'PF', name: 'Tipo Errado', document: FAKE_CNPJ },
      { 'idempotency-key': idemKey() },
    );
    expect(cnpjOnPf.status).toBe(400);
  });

  it('bloqueia CPF repetido e alerta sobre semelhança sem impedir cadastro legítimo', async () => {
    const admin = await loginAdmin(app);
    await createCustomer(admin, { name: 'José Exemplo', document: FAKE_CPF[1] });

    const sameDoc = await admin.post(
      '/api/v1/customers',
      { kind: 'PF', name: 'Outro Nome', document: FAKE_CPF[1], allowSimilar: true },
      { 'idempotency-key': idemKey() },
    );
    expect(sameDoc.status).toBe(409);
    expect(sameDoc.body.error.code).toBe('CONFLICT');

    // Mesmo telefone (ex.: cônjuge): alerta com candidatos...
    const similar = await admin.post(
      '/api/v1/customers',
      { kind: 'PF', name: 'Ana Exemplo', phone: '11 90000-0001' },
      { 'idempotency-key': idemKey() },
    );
    expect(similar.status).toBe(409);
    expect(similar.body.error.code).toBe('POSSIBLE_DUPLICATE');
    expect(similar.body.error.details.candidates[0].reasons).toContain('telefone');
    // ...mas o gestor pode confirmar que é outra pessoa.
    const confirmed = await createCustomer(admin, { name: 'Ana Exemplo', allowSimilar: true });
    expect(confirmed.id).toBeTruthy();
    expect(await db().customer.count()).toBe(2);
  });

  it('pesquisa sem acentos, por telefone e por cidade', async () => {
    const admin = await loginAdmin(app);
    await createCustomer(admin, { name: 'João Conceição', phone: '1133334444' });
    await createCustomer(admin, {
      name: 'Empresa Beta',
      kind: 'PJ',
      phone: '1155556666',
      addresses: [{ ...address, city: 'Outra Cidade' }],
    });
    const byName = await admin.get('/api/v1/customers?q=joao%20conceicao');
    expect(byName.body.items.map((c: { name: string }) => c.name)).toEqual(['João Conceição']);
    const byPhone = await admin.get('/api/v1/customers?q=5555');
    expect(byPhone.body.items.map((c: { name: string }) => c.name)).toEqual(['Empresa Beta']);
    const byCity = await admin.get('/api/v1/customers?city=outra');
    expect(byCity.body.total).toBe(1);
    const byKind = await admin.get('/api/v1/customers?kind=PJ');
    expect(byKind.body.total).toBe(1);
  });

  it('edição com controle de versão, auditoria e histórico; endereços preservados em pedidos', async () => {
    const admin = await loginAdmin(app);
    const c = await createCustomer(admin, { name: 'Cliente Original', document: FAKE_CPF[2] });
    const body = {
      kind: 'PF',
      name: 'Cliente Renomeado',
      document: FAKE_CPF[2],
      phone: '11900000001',
      version: c.version,
    };
    const r = await admin.put(`/api/v1/customers/${c.id}`, body);
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(c.version + 1);
    const stale = await admin.put(`/api/v1/customers/${c.id}`, { ...body, name: 'Outro' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');

    const addr = await admin.post(`/api/v1/customers/${c.id}/addresses`, {
      ...address,
      label: 'Casa de praia',
      isPrimary: true,
    });
    expect(addr.status).toBe(201);
    expect(addr.body.addresses.find((a: { isPrimary: boolean }) => a.isPrimary).label).toBe(
      'Casa de praia',
    );
    const removed = await admin.del(`/api/v1/customers/${c.id}/addresses/${c.addresses[0].id}`);
    expect(removed.body.addresses).toHaveLength(1);

    const history = await admin.get(`/api/v1/customers/${c.id}/history`);
    const actions = history.body.changes.map((x: { action: string }) => x.action);
    expect(actions).toEqual(
      expect.arrayContaining(['customer.created', 'customer.updated', 'customer.address_changed']),
    );
    const upd = history.body.changes.find(
      (x: { action: string }) => x.action === 'customer.updated',
    );
    expect(upd.changes.name).toEqual({ from: 'Cliente Original', to: 'Cliente Renomeado' });
    expect(JSON.stringify(history.body)).not.toContain(FAKE_CPF[2]);
  });

  it('dados pessoais restritos: sem "clientes.ver" não há acesso; seleção mostra só o resumo', async () => {
    const admin = await loginAdmin(app);
    await createCustomer(admin, { name: 'Pessoa Privada', document: FAKE_CPF[0] });
    const vendedor = await panelUserWith(app, admin, 'vendedor', [
      'pedidos.ver',
      'pedidos.gerenciar',
    ]);
    expect((await vendedor.get('/api/v1/customers')).status).toBe(403);
    const lookup = await vendedor.get('/api/v1/customers/lookup?q=privada');
    expect(lookup.status).toBe(200);
    expect(lookup.body[0]).toEqual({
      id: expect.any(String),
      kind: 'PF',
      name: 'Pessoa Privada',
      tradeName: null,
    });
    const leitor = await panelUserWith(app, admin, 'leitor', ['clientes.ver']);
    expect((await leitor.get('/api/v1/customers')).body.items[0].document).toBe(FAKE_CPF[0]);
    expect(
      (
        await leitor.post(
          '/api/v1/customers',
          { kind: 'PF', name: 'X Y' },
          { 'idempotency-key': idemKey() },
        )
      ).status,
    ).toBe(403);
  });
});
