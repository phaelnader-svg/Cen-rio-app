import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDaysIso, spDate, spInstant, weekFigures, weekStartOf } from '@cenario/shared';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { type Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { openServiceOrder } from './measurement-helpers';
import { userIdOf } from './production-helpers';

/**
 * Quadro de Metas: caixa a partir do saldo informado + registros oficiais (recebimentos,
 * pagamentos de contas e de mão de obra), sem contar o mesmo dinheiro duas vezes.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  setClock();
});
const post = (c: Client, url: string, body: unknown) =>
  c.post(url, body, { 'idempotency-key': idemKey() });
type Board = {
  balanceCents: number;
  goals: {
    id: string;
    name: string;
    targetCents: number;
    missingCents: number;
    pctOfGoal: number;
    achieved: { at: string } | null;
    belowAfterAchieved: boolean;
    version: number;
  }[];
  nextGoalId: string | null;
  weeks: {
    weekStart: string;
    openingCents: number;
    closingCents: number;
    inCents: number;
    outCents: number;
    deltaCents: number;
    pct: number | null;
    partial: boolean;
    moveIds: string[];
    corrections: { id: string; afterCents: number | null }[];
  }[];
  obligations: {
    totals: { confirmedInCents: number; conditionalInCents: number; outCents: number };
  };
  projection: { premises: string[] };
};
const board = async (c: Client) => (await c.get('/api/v1/office/cash')).body as Board;

const today = spDate(new Date());
const thisWeek = weekStartOf(today);
const lastWeek = addDaysIso(thisWeek, -7);

async function setup(admin: Client) {
  const acc = (
    await post(admin, '/api/v1/office/cash/accounts', { label: 'Conta PJ', bank: 'Banco Teste' })
  ).body as { id: string };
  expect(
    (
      await post(admin, '/api/v1/office/cash/snapshots', {
        accountId: acc.id,
        amountCents: 5_000_000,
        takenAt: spInstant(lastWeek, '08:00').toISOString(),
        note: 'Saldo de abertura',
      })
    ).status,
  ).toBe(200);
  const so = (await openServiceOrder(admin, 'Cliente Caixa')) as {
    id: string;
    items: { id: string }[];
  };
  const row = await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } });
  await db().commercialOrder.update({
    where: { id: row.orderId },
    data: { agreedValueCents: 3_000_000 },
  });
  return { acc, so, orderId: row.orderId };
}

describe('regras da semana (puras)', () => {
  it('50 mil → 55 mil = +R$ 5.000 (+10%); 50 mil → 47,5 mil = −R$ 2.500 (−5%); abertura zero não tem %', () => {
    const w = weekFigures('2026-11-09', 5_000_000, [
      { amountCents: 1_200_000, kind: 'OPERACAO' },
      { amountCents: -400_000, kind: 'OPERACAO' },
      { amountCents: -300_000, kind: 'OPERACAO' },
    ]);
    expect(w).toMatchObject({
      closingCents: 5_500_000,
      deltaCents: 500_000,
      pct: 10,
      inCents: 1_200_000,
      outCents: 700_000,
    });
    expect(
      weekFigures('2026-11-16', 5_000_000, [{ amountCents: -250_000, kind: 'OPERACAO' }]),
    ).toMatchObject({ closingCents: 4_750_000, deltaCents: -250_000, pct: -5 });
    expect(
      weekFigures('2026-11-16', 0, [{ amountCents: 100_000, kind: 'OPERACAO' }]).pct,
    ).toBeNull();
    const t = weekFigures('2026-11-16', 5_000_000, [
      { amountCents: -1_000_000, kind: 'TRANSFERENCIA' },
      { amountCents: 1_000_000, kind: 'TRANSFERENCIA' },
      { amountCents: 2_000_000, kind: 'APORTE' },
    ]);
    expect(t).toMatchObject({
      deltaCents: 2_000_000,
      operationalDeltaCents: 0,
      inCents: 2_000_000,
      outCents: 0,
    });
  });
});

describe('caixa a partir dos registros oficiais', () => {
  it('exemplo do pedido: R$ 50 mil, recebe 12 mil, paga 4 mil de material e 3 mil de mão de obra → fecha R$ 55 mil', async () => {
    const admin = await loginAdmin(app);
    const { so, orderId } = await setup(admin);
    // Recebimento (conta a receber oficial + recebimento).
    const rec = (
      await post(admin, '/api/v1/finance/receivables', {
        orderId,
        serviceOrderId: so.id,
        description: 'Entrada',
        amountCents: 1_200_000,
        dueTrigger: 'DATA',
        dueDate: addDaysIso(lastWeek, 1),
        expectedMethod: 'PIX',
      })
    ).body as { id: string; version: number };
    expect(
      (
        await post(admin, `/api/v1/finance/receivables/${rec.id}/payments`, {
          amountCents: 1_200_000,
          receivedAt: addDaysIso(lastWeek, 1),
          method: 'PIX',
          version: rec.version,
        })
      ).status,
    ).toBe(200);
    // Material a prazo e pago.
    const pay = (
      await post(admin, '/api/v1/finance/payables', {
        beneficiary: 'Espumas Vale',
        category: 'MATERIAL',
        description: 'Espuma D28',
        amountCents: 400_000,
        dueDate: addDaysIso(lastWeek, 2),
      })
    ).body as { id: string; version: number };
    expect(
      (
        await post(admin, `/api/v1/finance/payables/${pay.id}/payments`, {
          amountCents: 400_000,
          paidAt: addDaysIso(lastWeek, 2),
          method: 'PIX',
          version: pay.version,
        })
      ).status,
    ).toBe(200);
    // Mão de obra por produção (vinculada à OS) paga.
    const lab = (
      await post(admin, '/api/v1/finance/labor', {
        professionalUserId: await userIdOf('Márcio'),
        serviceOrderId: so.id,
        serviceOrderItemId: so.items[0]!.id,
        service: 'Reforma do sofá',
        agreedCents: 300_000,
      })
    ).body as { id: string; version: number };
    // Pagamento antes da confirmação semanal do profissional: exceção administrativa oficial.
    const ex = await post(admin, `/api/v1/finance/weekly-closings/${lastWeek}/exceptions`, {
      beneficiaryUserId: await userIdOf('Márcio'),
      reason: 'Adiantamento combinado',
      itemIds: [lab.id],
    });
    expect(ex.status, JSON.stringify(ex.body)).toBe(201);
    const lp = await post(admin, `/api/v1/finance/labor/${lab.id}/payments`, {
      amountCents: 300_000,
      paidAt: addDaysIso(lastWeek, 3),
      method: 'PIX',
      earlyReason: 'Adiantamento combinado',
      version: lab.version,
    });
    expect(lp.status, JSON.stringify(lp.body)).toBe(200);

    const b = await board(admin);
    const w = b.weeks.find((x) => x.weekStart === lastWeek)!;
    expect(w).toMatchObject({
      openingCents: 5_000_000,
      closingCents: 5_500_000,
      deltaCents: 500_000,
      pct: 10,
      inCents: 1_200_000,
      outCents: 700_000,
    });
    expect(b.balanceCents).toBe(5_500_000);
    const g100 = b.goals.find((g) => g.targetCents === 10_000_000)!;
    expect(g100).toMatchObject({ missingCents: 4_500_000, pctOfGoal: 55 });
    expect(b.nextGoalId).toBe(g100.id);
    // Drill-down: os lançamentos da semana com vínculo à OS/conta.
    const moves = (await admin.get(`/api/v1/office/cash/moves?week=${lastWeek}`)).body as {
      moves: { source: string; amountCents: number; links: { type: string }[] }[];
      totalCents: number;
    };
    expect(moves.totalCents).toBe(500_000);
    expect(moves.moves.map((m) => m.source).sort()).toEqual([
      'MAO_DE_OBRA',
      'PAGAMENTO_CONTA',
      'RECEBIMENTO',
    ]);
    expect(moves.moves.find((m) => m.source === 'MAO_DE_OBRA')!.links.map((l) => l.type)).toContain(
      'OS',
    );

    // Correção depois do fechamento: pagamento lançado agora com data da semana fechada.
    const pay2 = (
      await post(admin, '/api/v1/finance/payables', {
        beneficiary: 'Tecidos',
        category: 'MATERIAL',
        description: 'Linho',
        amountCents: 50_000,
        dueDate: addDaysIso(lastWeek, 4),
      })
    ).body as { id: string; version: number };
    await post(admin, `/api/v1/finance/payables/${pay2.id}/payments`, {
      amountCents: 50_000,
      paidAt: addDaysIso(lastWeek, 4),
      method: 'PIX',
      version: pay2.version,
    });
    const after = (await board(admin)).weeks.find((x) => x.weekStart === lastWeek)!;
    expect(after.closingCents).toBe(5_450_000);
    expect(after.corrections).toHaveLength(1);
    expect(after.corrections[0]!.afterCents).toBe(-50_000);
  });

  it('confirmação de pagamento reenviada muda o saldo uma única vez', async () => {
    const admin = await loginAdmin(app);
    const { orderId } = await setup(admin);
    await post(admin, '/api/v1/connections/COBRANCAS/test-mode', {});
    const plan = (
      await post(admin, `/api/v1/office/orders/${orderId}/charges`, {
        mode: 'ENTRADA_SALDO',
        entradaPercent: 50,
      })
    ).body as { lines: { charge: { id: string } | null }[] };
    const chargeId = plan.lines[0]!.charge!.id;
    const before = (await board(admin)).balanceCents;
    await post(admin, `/api/v1/office/charges/${chargeId}/simulate`, {
      event: 'PAYMENT_RECEIVED',
      eventId: 'evt_caixa_1',
    });
    const once = (await board(admin)).balanceCents;
    await post(admin, `/api/v1/office/charges/${chargeId}/simulate`, {
      event: 'PAYMENT_RECEIVED',
      eventId: 'evt_caixa_1',
    });
    await post(admin, `/api/v1/office/charges/${chargeId}/simulate`, {
      event: 'PAYMENT_CONFIRMED',
      eventId: 'evt_caixa_2',
    });
    expect(once - before).toBe(1_500_000);
    expect((await board(admin)).balanceCents).toBe(once);
  });

  it('transferência mantém o total; aporte/retirada separados; extrato + manual iguais contam uma vez', async () => {
    const admin = await loginAdmin(app);
    const { acc } = await setup(admin);
    const reserve = (
      await post(admin, '/api/v1/office/cash/accounts', { label: 'Reserva', bank: 'Banco Teste 2' })
    ).body as { id: string };
    await post(admin, '/api/v1/office/cash/snapshots', {
      accountId: reserve.id,
      amountCents: 0,
      takenAt: spInstant(lastWeek, '08:00').toISOString(),
    });
    const total0 = (await board(admin)).balanceCents;
    const tr = await post(admin, '/api/v1/office/cash/entries', {
      accountId: acc.id,
      kind: 'TRANSFERENCIA',
      toAccountId: reserve.id,
      amountCents: 1_000_000,
      description: 'Para a reserva',
    });
    expect(tr.status, JSON.stringify(tr.body)).toBe(200);
    expect((await board(admin)).balanceCents).toBe(total0);
    // Manual numa conta que depois recebe extrato com a mesma linha: conta uma vez.
    const fee = (
      (
        await post(admin, '/api/v1/office/cash/entries', {
          accountId: reserve.id,
          kind: 'DESPESA',
          amountCents: 1_200,
          description: 'Tarifa bancária',
        })
      ).body as { id: string }[]
    )[0]!;
    const b1 = (await board(admin)).balanceCents;
    const d = today.split('-').reverse().join('/');
    await post(admin, `/api/v1/office/bank/accounts/${reserve.id}/import`, {
      format: 'CSV',
      content: `data;descricao;valor\n${d};TARIFA;-12,00\n${d};TRANSF RECEBIDA;10.000,00\n`,
    });
    const b2 = await board(admin);
    expect(b2.balanceCents).toBe(b1); // tarifa e transferência já estavam no caixa
    // Correção: estorno do manual fica no histórico.
    const tx = (await admin.get('/api/v1/office/bank/transactions')).body as {
      id: string;
      amountCents: number;
      suggestions: { refType: string; refId: string }[];
    }[];
    const tarifa = tx.find((t) => t.amountCents === -1200)!;
    expect(tarifa.suggestions.some((s) => s.refType === 'cash_entry' && s.refId === fee.id)).toBe(
      true,
    );
    expect(
      (
        await post(admin, `/api/v1/office/bank/transactions/${tarifa.id}/reconcile`, {
          refType: 'cash_entry',
          refId: fee.id,
        })
      ).status,
    ).toBe(200);
    const transf = tx.find((t) => t.amountCents === 1_000_000)!;
    expect(
      (
        await post(admin, `/api/v1/office/bank/transactions/${transf.id}/reconcile`, {
          refType: 'transferencia',
        })
      ).status,
    ).toBe(200);
    expect((await board(admin)).balanceCents).toBe(b1);
  });

  it('meta atingida fica no histórico; queda depois mostra o saldo verdadeiro e quanto falta', async () => {
    const admin = await loginAdmin(app);
    const { acc } = await setup(admin);
    const g = (
      await post(admin, '/api/v1/office/cash/goals', {
        name: 'Reserva de R$ 52 mil',
        targetCents: 5_200_000,
        deadline: addDaysIso(today, 30),
        accountIds: [],
      })
    ).body as { id: string };
    await post(admin, '/api/v1/office/cash/entries', {
      accountId: acc.id,
      kind: 'APORTE',
      amountCents: 300_000,
      description: 'Aporte',
      occurredAt: spInstant(lastWeek, '10:00').toISOString(),
    });
    let goal = (await board(admin)).goals.find((x) => x.id === g.id)!;
    expect(goal.achieved).not.toBeNull();
    expect(goal.belowAfterAchieved).toBe(false);
    await post(admin, '/api/v1/office/cash/entries', {
      accountId: acc.id,
      kind: 'RETIRADA',
      amountCents: 500_000,
      description: 'Retirada',
    });
    goal = (await board(admin)).goals.find((x) => x.id === g.id)!;
    expect(goal).toMatchObject({ belowAfterAchieved: true, missingCents: 400_000 });
    expect(goal.achieved).not.toBeNull();
  });
});
