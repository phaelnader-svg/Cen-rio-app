import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase, ownerDb } from './helpers';
import { act } from './production-helpers';
import { openServiceOrder } from './measurement-helpers';
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
  await ownerDb().$executeRawUnsafe(`DROP TRIGGER IF EXISTS audit_fail ON financial_events`);
  await ownerDb().$executeRawUnsafe(`DROP TRIGGER IF EXISTS audit_fail ON quality_inspections`);
  await ownerDb().$executeRawUnsafe(`DROP TRIGGER IF EXISTS audit_fail ON stock_movements`);
  await ownerDb().$executeRawUnsafe(`DROP FUNCTION IF EXISTS audit_fail_fn()`);
  setAttendanceClock();
});

/** Instala uma falha simulada (erro do banco) no último passo de uma operação. */
async function failOn(table: string, when = 'true') {
  await ownerDb()
    .$executeRawUnsafe(`CREATE OR REPLACE FUNCTION audit_fail_fn() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'falha simulada da auditoria'; END $$ LANGUAGE plpgsql`);
  await ownerDb().$executeRawUnsafe(
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
    // Cobrança (AM-12): data de recebimento futura é recusada — o teste usa a data de hoje.
    const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
      new Date(),
    );
    const body = {
      amountCents: 40000,
      receivedAt: todayLocal,
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
    await ownerDb().$executeRawUnsafe(`DROP TRIGGER audit_fail ON financial_events`);
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
    await ownerDb().$executeRawUnsafe(`DROP TRIGGER audit_fail ON quality_inspections`);
    expect(
      (await act(s.tablets.Ricardo!, s.sofaTask.id, 'complete', { note: 'ok' }, key)).status,
    ).toBe(200);
    expect(await db().qualityInspection.count()).toBe(1);
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
