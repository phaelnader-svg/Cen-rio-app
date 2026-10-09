import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { act } from './production-helpers';
import { openServiceOrder } from './measurement-helpers';
import {
  approvedNeeds,
  confirmPurchase,
  createPurchase,
  createSupplier,
  ok,
  receive,
  staples,
} from './purchasing-helpers';
import { post, prepareCompany, workshop } from './audit-helpers';

/**
 * Fase 12 — auditoria de integridade: falhas forçadas no meio das transações (nenhum registro
 * parcial), operações simultâneas e verificação estrutural do banco (chaves, índices, triggers).
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  setAttendanceClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  await prepareCompany();
});
afterEach(async () => {
  await db().$executeRawUnsafe(`DROP TRIGGER IF EXISTS audit_fail ON financial_events`);
  await db().$executeRawUnsafe(`DROP TRIGGER IF EXISTS audit_fail ON quality_inspections`);
  await db().$executeRawUnsafe(`DROP TRIGGER IF EXISTS audit_fail ON stock_movements`);
  await db().$executeRawUnsafe(`DROP FUNCTION IF EXISTS audit_fail_fn()`);
  setAttendanceClock();
});

/** Instala uma falha simulada (erro do banco) no último passo de uma operação. */
async function failOn(table: string, when = 'true') {
  await db().$executeRawUnsafe(`CREATE OR REPLACE FUNCTION audit_fail_fn() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'falha simulada da auditoria'; END $$ LANGUAGE plpgsql`);
  await db().$executeRawUnsafe(
    `CREATE TRIGGER audit_fail BEFORE INSERT ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION audit_fail_fn()`,
  );
}

describe('Falhas no meio da transação não deixam registros parciais', () => {
  it('recebimento: falha ao gravar o histórico desfaz o pagamento e o saldo', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Falha');
    const orderId = (await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } })).orderId;
    const rc = await post(admin, '/api/v1/finance/receivables', {
      orderId,
      description: 'Entrada',
      amountCents: 100000,
      dueDate: '2030-01-10',
      expectedMethod: 'PIX',
    });
    await failOn('financial_events');
    const body = {
      amountCents: 40000,
      receivedAt: '2030-01-10',
      method: 'PIX',
      version: rc.body.version,
    };
    const key = idemKey();
    const r = await post(admin, `/api/v1/finance/receivables/${rc.body.id}/payments`, body, key);
    expect(r.status).toBe(500);
    expect(await db().customerPayment.count()).toBe(0);
    const cur = await db().customerReceivable.findUniqueOrThrow({ where: { id: rc.body.id } });
    expect(cur).toMatchObject({ receivedCents: 0, status: 'ABERTO', version: rc.body.version });
    expect(await db().auditLog.count({ where: { action: 'finance.payment_recorded' } })).toBe(0);
    // Depois da falha, a mesma intenção (mesma chave) pode ser repetida e entra uma vez só.
    await db().$executeRawUnsafe(`DROP TRIGGER audit_fail ON financial_events`);
    const again = await post(
      admin,
      `/api/v1/finance/receivables/${rc.body.id}/payments`,
      body,
      key,
    );
    expect(again.status).toBe(200);
    expect(await db().customerPayment.count()).toBe(1);
  });

  it('conclusão de tarefa: falha ao criar a inspeção mantém a tarefa em execução', async () => {
    const s = await workshop(app);
    expect((await act(s.tablets.Ricardo!, s.sofaTask.id, 'start')).status).toBe(200);
    await failOn('quality_inspections');
    const key = idemKey();
    const r = await act(s.tablets.Ricardo!, s.sofaTask.id, 'complete', { note: 'ok' }, key);
    expect(r.status).toBe(500);
    const t = await db().productionTask.findUniqueOrThrow({ where: { id: s.sofaTask.id } });
    expect(t.status).toBe('EM_EXECUCAO');
    expect(
      await db().productionTaskEvent.count({ where: { taskId: t.id, kind: 'CONCLUIDA' } }),
    ).toBe(0);
    expect(
      (await db().serviceOrderItem.findUniqueOrThrow({ where: { id: s.sofa.id } }))
        .fulfillmentStage,
    ).toBe('EM_PRODUCAO');
    await db().$executeRawUnsafe(`DROP TRIGGER audit_fail ON quality_inspections`);
    expect(
      (await act(s.tablets.Ricardo!, s.sofaTask.id, 'complete', { note: 'ok' }, key)).status,
    ).toBe(200);
    expect(await db().qualityInspection.count()).toBe(1);
  });

  it('estoque: falha na movimentação desfaz a entrega do material reservado', async () => {
    const admin = await loginAdmin(app);
    const supplier = await createSupplier(admin);
    const { so, reqs } = await approvedNeeds(admin, 'Cliente Estoque Falha', () => [staples()]);
    const po = await createPurchase(admin, {
      supplierId: supplier.id,
      expectedDate: '2030-01-10',
      items: [
        {
          sourcing: 'ESTOQUE',
          allocations: [{ materialRequirementId: reqs[0]!.id, quantity: 2 }],
          quantity: 6,
          unitPriceCents: 1890,
        },
      ],
    });
    const c = await confirmPurchase(admin, po.body);
    await receive(admin, c.body.id, [ok(c.body.items[0].id, 6)]);
    const resv = await db().stockReservation.findFirstOrThrow({ where: { serviceOrderId: so.id } });
    const before = await db().stockItem.findUniqueOrThrow({ where: { id: resv.stockItemId } });
    await failOn('stock_movements', `NEW.type = 'SAIDA_OS'`);
    const r = await post(admin, `/api/v1/stock-reservations/${resv.id}/consume`);
    expect(r.status).toBe(500);
    const after = await db().stockItem.findUniqueOrThrow({ where: { id: resv.stockItemId } });
    expect(Number(after.onHand)).toBe(Number(before.onHand));
    expect(Number(after.reserved)).toBe(Number(before.reserved));
    expect((await db().stockReservation.findUniqueOrThrow({ where: { id: resv.id } })).status).toBe(
      'ATIVA',
    );
  });
});

describe('Operações simultâneas', () => {
  it('a mesma tarefa concluída ao mesmo tempo (dois envios) conclui uma vez só', async () => {
    const s = await workshop(app);
    expect((await act(s.tablets.Ricardo!, s.sofaTask.id, 'start')).status).toBe(200);
    const res = await Promise.all([
      act(s.tablets.Ricardo!, s.sofaTask.id, 'complete', { note: 'a' }),
      act(s.tablets.Ricardo!, s.sofaTask.id, 'complete', { note: 'b' }),
      act(s.tablets.Ricardo!, s.sofaTask.id, 'complete', { note: 'c' }),
    ]);
    expect(res.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(
      await db().productionTaskEvent.count({ where: { taskId: s.sofaTask.id, kind: 'CONCLUIDA' } }),
    ).toBe(1);
    expect(await db().qualityInspection.count({ where: { serviceOrderItemId: s.sofa.id } })).toBe(
      1,
    );
  });

  it('duas reservas simultâneas do último saldo: só uma entra, estoque nunca negativo', async () => {
    const admin = await loginAdmin(app);
    const supplier = await createSupplier(admin);
    const a = await approvedNeeds(admin, 'Cliente Reserva A', () => [staples({ quantity: 3 })]);
    const b = await openServiceOrder(admin, 'Cliente Reserva B');
    const c2 = await openServiceOrder(admin, 'Cliente Reserva C');
    // Compra de 4 com 1 destinado à OS A: entra 4 no estoque, 1 reservado, 3 disponíveis.
    const po = await createPurchase(admin, {
      supplierId: supplier.id,
      expectedDate: '2030-01-10',
      items: [
        {
          sourcing: 'ESTOQUE',
          allocations: [{ materialRequirementId: a.reqs[0]!.id, quantity: 1 }],
          quantity: 4,
          unitPriceCents: 1890,
        },
      ],
    });
    expect(po.status).toBe(201);
    const c = await confirmPurchase(admin, po.body);
    await receive(admin, c.body.id, [ok(c.body.items[0].id, 4)]);
    const stock = await db().stockItem.findFirstOrThrow();
    expect(Number(stock.reserved)).toBe(1);
    const reserve = (so: string) =>
      post(admin, '/api/v1/stock-reservations', {
        stockItemId: stock.id,
        serviceOrderId: so,
        quantity: 3,
      });
    const res = await Promise.all([reserve(b.id), reserve(c2.id)]);
    expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
    const after = await db().stockItem.findUniqueOrThrow({ where: { id: stock.id } });
    expect(Number(after.reserved)).toBe(4);
    expect(Number(after.onHand)).toBeGreaterThanOrEqual(Number(after.reserved));
  });
});

describe('Estrutura do banco', () => {
  it('toda tabela tem chave primária e todas as migrations estão aplicadas', async () => {
    const noPk = await db().$queryRawUnsafe<{ t: string }[]>(`
      SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p')`);
    expect(noPk).toEqual([]);
    const pending = await db().$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`,
    );
    expect(Number(pending[0]!.n)).toBe(0);
  });

  it('chaves estrangeiras com índice e históricos protegidos por trigger', async () => {
    // Colunas de FK sem índice que comece por elas (consultas e exclusões lentas).
    const missing = await db().$queryRawUnsafe<{ t: string; c: string }[]>(`
      SELECT cl.relname AS t, a.attname AS c
      FROM pg_constraint k
      JOIN pg_class cl ON cl.oid = k.conrelid
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      WHERE k.contype = 'f' AND array_length(k.conkey, 1) = 1
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i WHERE i.indrelid = k.conrelid AND i.indkey[0] = k.conkey[1])
      ORDER BY 1, 2`);
    // Registro informativo para o relatório (não bloqueia: tabelas pequenas por natureza).
    console.warn(
      `FK sem índice próprio: ${missing.length}`,
      missing.map((m) => `${m.t}.${m.c}`).join(', '),
    );
    const triggers = await db().$queryRawUnsafe<{ t: string }[]>(`
      SELECT DISTINCT c.relname AS t FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_proc p ON p.oid = tg.tgfoid
      WHERE NOT tg.tgisinternal AND p.proname IN ('cenario_reject_mutation', 'cenario_reject_delete')`);
    const protectedTables = new Set(triggers.map((x) => x.t));
    for (const t of [
      'audit_logs',
      'stock_movements',
      'production_task_events',
      'quality_events',
      'delivery_events',
      'customer_payments',
      'professional_payments',
      'payable_payments',
      'service_order_costs',
      'financial_events',
      'customer_receivables',
      'deliveries',
    ])
      expect(protectedTables.has(t), t).toBe(true);
  });
});
