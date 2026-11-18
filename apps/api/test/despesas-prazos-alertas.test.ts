import { addBusinessDays } from '@cenario/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { refreshOperationalAlerts } from '../src/modules/management/today';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, naEmpresa1, resetDatabase } from './helpers';
import { address } from './commercial-helpers';
import { day } from './production-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/**
 * Despesas, prazos e alertas (2026-11-18, pedido do Raphael):
 *  A. Categorias de despesa cadastradas pela empresa (além das fixas).
 *  B. Contas a pagar em atraso e a vencer no Resumo; aviso no sininho 1 dia antes.
 *  C. Prazo de entrega em dias úteis, contado do dia da retirada (e acompanha a remarcação).
 *  D. Agendar a retirada no "Novo serviço" exige data e horário.
 *  E. Início: serviços com entrega em até uma semana, e aviso no sininho.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
});

const post = (c: Client, path: string, body: unknown = {}) =>
  c.post(path, body, { 'idempotency-key': idemKey() });
const refresh = () => naEmpresa1(() => refreshOperationalAlerts(app.ctx.prisma));
const workingDays = async () =>
  (await db().companySettings.findUniqueOrThrow({ where: { id: 1 } })).workingDays;
const activeAlerts = (kind: string) =>
  db().notification.findMany({ where: { kind, resolvedAt: null } });

const expense = (category: string) => ({
  category,
  description: 'Conserto da máquina de costura',
  amountCents: 12000,
  competence: day(0).slice(0, 7),
  dueDate: day(10),
  beneficiary: 'Oficina do Zé',
});

describe('A. categorias de despesa da empresa', () => {
  it('cadastra, usa na despesa e na recorrente, esconde sem mexer no que já foi lançado', async () => {
    const admin = await loginAdmin(app);
    const created = await post(admin, '/api/v1/finance/expense-categories', {
      name: 'Manutenção',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ value: 'Manutenção', custom: true, active: true });

    const list = (await admin.get('/api/v1/finance/expense-categories')).body as J[];
    expect(list.map((c) => c.label)).toContain('Manutenção');
    expect(list.at(-1).value).toBe('OUTRAS');

    // Mesmo nome sem acento/maiúscula: reaproveita a mesma categoria.
    const again = await post(admin, '/api/v1/finance/expense-categories', { name: 'manutencao' });
    expect(again.body.id).toBe(created.body.id);
    expect(await db().expenseCategory.count()).toBe(1);

    // Nome de uma categoria fixa não é aceito.
    const clash = await post(admin, '/api/v1/finance/expense-categories', { name: 'aluguel' });
    expect(clash.status).toBe(422);

    const e = await post(admin, '/api/v1/finance/expenses', expense('Manutenção'));
    expect(e.status, JSON.stringify(e.body)).toBe(201);
    expect(e.body.category).toBe('Manutenção');
    const payable = await db().accountPayable.findUniqueOrThrow({
      where: { id: e.body.payable.id },
    });
    expect(payable.category).toBe('Manutenção');

    const rec = await post(admin, '/api/v1/finance/recurring-expenses', {
      category: 'Manutenção',
      description: 'Revisão mensal',
      amountCents: 5000,
      dayOfMonth: 10,
      beneficiary: 'Oficina do Zé',
      startMonth: day(0).slice(0, 7),
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);

    // Categoria inventada (não cadastrada) é recusada.
    const bad = await post(admin, '/api/v1/finance/expenses', expense('Qualquer coisa'));
    expect(bad.status).toBe(400);

    // Escondida: sai do menu de lançamentos novos, mas o que já existe continua igual.
    const hide = await admin.put(`/api/v1/finance/expense-categories/${created.body.id}`, {
      active: false,
    });
    expect(hide.status, JSON.stringify(hide.body)).toBe(200);
    expect((await post(admin, '/api/v1/finance/expenses', expense('Manutenção'))).status).toBe(400);
    const edit = await admin.put(`/api/v1/finance/recurring-expenses/${rec.body.id}`, {
      ...rec.body,
      amountCents: 6000,
      startMonth: rec.body.startMonth,
      version: rec.body.version,
    });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body.category).toBe('Manutenção');

    // Conta a pagar avulsa aceita as fixas de fornecedor/logística também.
    const p = await post(admin, '/api/v1/finance/payables', {
      beneficiary: 'Fornecedor de espuma',
      category: 'MATERIAL',
      description: 'Espuma D33',
      amountCents: 30000,
      dueDate: day(3),
    });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
  });
});

describe('B. contas a vencer e em atraso', () => {
  it('Resumo lista atrasadas e as dos próximos 7 dias; o sininho avisa 1 dia antes e resolve ao pagar', async () => {
    const admin = await loginAdmin(app);
    const mk = async (offset: number, name: string) => {
      const r = await post(admin, '/api/v1/finance/payables', {
        beneficiary: name,
        category: 'ALUGUEL',
        description: `Conta ${name}`,
        amountCents: 10000,
        dueDate: day(offset),
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return r.body as J;
    };
    const late = await mk(-2, 'Atrasada');
    await mk(1, 'Amanhã');
    await mk(5, 'Semana');
    await mk(20, 'Longe');

    const dash = (await admin.get('/api/v1/finance/dashboard')).body as J;
    expect(dash.bills.overdue.map((b: J) => b.beneficiary)).toEqual(['Atrasada']);
    expect(dash.bills.overdue[0].days).toBe(-2);
    expect(dash.bills.upcoming.map((b: J) => b.beneficiary)).toEqual(['Amanhã', 'Semana']);

    await refresh();
    await refresh();
    expect((await activeAlerts('CONTA_VENCIDA')).map((n) => n.body)).toEqual([
      expect.stringContaining('Atrasada'),
    ]);
    const soon = await activeAlerts('CONTA_A_VENCER');
    expect(soon).toHaveLength(1);
    expect(soon[0]!.body).toContain('vence amanhã');

    const pay = await post(admin, `/api/v1/finance/payables/${late.id}/payments`, {
      amountCents: 10000,
      paidAt: day(0),
      method: 'PIX',
      version: late.version,
    });
    expect(pay.status, JSON.stringify(pay.body)).toBe(200);
    await refresh();
    expect(await activeAlerts('CONTA_VENCIDA')).toHaveLength(0);
  });
});

async function closeService(
  admin: Client,
  opts: {
    days?: number;
    pickup?: Record<string, unknown> | null;
    name?: string;
    phone?: string;
  } = {},
) {
  const pickup =
    opts.pickup === undefined ? { scheduledDate: day(2), windowStart: '09:00' } : opts.pickup;
  return post(admin, '/api/v1/services', {
    customer: {
      mode: 'NOVO',
      kind: 'PF',
      name: opts.name ?? 'Cliente do Prazo',
      phone: opts.phone ?? '(11) 97777-4321',
      address: { ...address, isPrimary: true },
    },
    service: {
      contractedService: 'Reforma de sofá',
      promisedDate: day(60),
      deliveryBusinessDays: opts.days ?? 15,
      items: [
        {
          pieceType: 'SOFA',
          description: 'Sofá 2 lugares',
          quantity: 1,
          serviceType: 'REFORMA_COMPLETA',
        },
      ],
    },
    ...(pickup ? { pickup: { team: 'LOGISTICA_TERCEIRIZADA', ...pickup } } : {}),
  });
}

const promisedOf = async (orderId: string) => {
  const o = await db().commercialOrder.findUniqueOrThrow({ where: { id: orderId } });
  return { date: o.promisedDate!.toISOString().slice(0, 10), days: o.deliveryBusinessDays };
};

describe('C. prazo em dias úteis', () => {
  it('conta a partir do dia da retirada e acompanha a remarcação', async () => {
    const admin = await loginAdmin(app);
    const wd = await workingDays();
    const r = await closeService(admin, { days: 15 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await promisedOf(r.body.order.id)).toEqual({
      date: addBusinessDays(day(2), 15, wd),
      days: 15,
    });

    const p = (await admin.get(`/api/v1/pickups/${r.body.pickup.id}`)).body as J;
    const moved = await admin.put(`/api/v1/pickups/${p.id}`, {
      scheduledDate: day(6),
      windowStart: '14:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      items: p.items.map((i: J) => ({ orderItemId: i.orderItemId, quantity: i.quantity })),
      version: p.version,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await promisedOf(r.body.order.id)).date).toBe(addBusinessDays(day(6), 15, wd));
  });

  it('cliente que traz as peças: conta a partir de hoje', async () => {
    const admin = await loginAdmin(app);
    const r = await closeService(admin, { days: 10, pickup: null });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await promisedOf(r.body.order.id)).date).toBe(
      addBusinessDays(day(0), 10, await workingDays()),
    );
  });

  it('feriado nacional não conta como dia útil', () => {
    // 2026-12-24 (qui) + 1 dia útil = 2026-12-28 (seg): 25/12 é Natal.
    expect(addBusinessDays('2026-12-24', 1, [1, 2, 3, 4, 5])).toBe('2026-12-28');
    // Sexta + 1 dia útil = segunda.
    expect(addBusinessDays('2026-11-20', 1, [1, 2, 3, 4, 5])).toBe('2026-11-23');
  });
});

describe('D. agendar a retirada exige data e horário', () => {
  it('sem data ou sem horário, o serviço não é fechado', async () => {
    const admin = await loginAdmin(app);
    const noDate = await closeService(admin, {
      pickup: { scheduledDate: null, windowStart: '09:00' },
    });
    expect(noDate.status).toBe(400);
    expect(JSON.stringify(noDate.body)).toMatch(/data da retirada/);
    const noTime = await closeService(admin, {
      pickup: { scheduledDate: day(2), windowStart: null },
    });
    expect(noTime.status).toBe(400);
    expect(JSON.stringify(noTime.body)).toMatch(/horário de chegada/);
  });
});

describe('E. Início: entregas da próxima semana', () => {
  it('pedido com entrega em até uma semana aparece no Início e avisa no sininho', async () => {
    const admin = await loginAdmin(app);
    const near = await closeService(admin, {
      days: 1,
      pickup: { scheduledDate: day(1), windowStart: '10:00' },
    });
    expect(near.status, JSON.stringify(near.body)).toBe(201);
    const far = await closeService(admin, {
      days: 40,
      name: 'Outra Cliente Longe',
      phone: '(21) 98888-1111',
    });
    expect(far.status).toBe(201);

    const t = (await admin.get('/api/v1/management/today')).body as J;
    const ids = (t.deadlines as J[]).map((d) => d.id);
    expect(ids).toContain(near.body.order.id);
    expect(ids).not.toContain(far.body.order.id);
    const row = (t.deadlines as J[]).find((d) => d.id === near.body.order.id);
    expect(row).toMatchObject({ kind: 'PEDIDO', state: 'PRAZO_PROXIMO' });
    expect(row.reasons).toEqual(['Peças ainda não chegaram na oficina']);

    await refresh();
    const alerts = await activeAlerts('PRAZO_PROXIMO');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.body).toContain('Cliente do Prazo');
  });
});
