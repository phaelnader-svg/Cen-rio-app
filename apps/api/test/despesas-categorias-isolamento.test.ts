import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { Client, createTestApp, idemKey, loginAdmin, ownerDb, resetDatabase } from './helpers';
import { day } from './production-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/**
 * Multi-empresa: categorias de despesa (expense_categories) ficam isoladas por empresa.
 * A empresa B nasce pelo "Criar conta" e não enxerga, não usa e não altera as categorias da A.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

const post = (c: Client, path: string, body: unknown = {}) =>
  c.post(path, body, { 'idempotency-key': idemKey() });

async function criarEmpresaB() {
  const client = new Client(app);
  const r = await client.post('/api/auth/signup', {
    email: 'gestor@empresa-b.local',
    password: 'SenhaDaEmpresaB1',
    passwordConfirm: 'SenhaDaEmpresaB1',
  });
  if (r.status !== 201) throw new Error(`signup: ${JSON.stringify(r.body)}`);
  return client;
}

const expense = (category: string) => ({
  category,
  description: 'Conserto',
  amountCents: 5000,
  competence: day(0).slice(0, 7),
  dueDate: day(10),
  beneficiary: 'Oficina',
});

describe('categorias de despesa entre empresas', () => {
  it('a empresa B não vê, não usa e não altera a categoria da A; cada uma tem a sua', async () => {
    const a = await loginAdmin(app);
    const created = await post(a, '/api/v1/finance/expense-categories', { name: 'Manutenção' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const idA = created.body.id as string;

    const b = await criarEmpresaB();
    const listB = (await b.get('/api/v1/finance/expense-categories')).body as J[];
    expect(listB.map((c) => c.label)).not.toContain('Manutenção');
    expect(JSON.stringify(listB)).not.toContain(idA);

    // B não lança despesa com a categoria da A.
    expect((await post(b, '/api/v1/finance/expenses', expense('Manutenção'))).status).toBe(400);
    // B não esconde a categoria da A pelo id.
    const hide = await b.put(`/api/v1/finance/expense-categories/${idA}`, { active: false });
    expect(hide.status).toBe(404);

    // B cria a própria "Manutenção" (mesmo nome, outra empresa) e usa.
    const own = await post(b, '/api/v1/finance/expense-categories', { name: 'Manutenção' });
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    expect(own.body.id).not.toBe(idA);
    const eB = await post(b, '/api/v1/finance/expenses', expense('Manutenção'));
    expect(eB.status, JSON.stringify(eB.body)).toBe(201);

    // A continua com a sua, ativa, e só a sua.
    const listA = (await a.get('/api/v1/finance/expense-categories')).body as J[];
    const customA = listA.filter((c) => c.custom);
    expect(customA.map((c) => c.id)).toEqual([idA]);
    expect(customA[0].active).toBe(true);

    // No banco: uma linha por empresa.
    const rows = await ownerDb().expenseCategory.findMany({ select: { companyId: true } });
    expect(new Set(rows.map((r) => r.companyId)).size).toBe(2);
  });
});
