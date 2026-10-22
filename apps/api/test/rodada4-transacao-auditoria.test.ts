/**
 * Remediação pós-auditoria, Rodada 4 — PROVA (não funcionalidade) para:
 *  - F1-06: histórico/auditoria na mesma transação — cada ação nova grava a sua auditoria
 *    (`service.created`, `finance.value_request_created/approved/rejected/obsolete`,
 *    `finance.week_confirmed`, `material_arrival.registered`, `production.plan_created`,
 *    `production.service_rescheduled`) e uma falha REAL no INSERT da auditoria desfaz a ação.
 *  - F2-07: CA2-02 — Novo serviço com falha INJETADA (erro do banco) em cada passo gravado
 *    (cliente, endereço, pedido, itens, cobrança, retirada, custo, auditoria, outbox...): nada
 *    parcial; a mesma chave de idempotência não fica presa e a nova tentativa cria uma vez.
 *  - F3-20b: a auditoria `material_arrival.registered` lida pela rota real de auditoria.
 *
 * Falhas são injetadas com triggers temporários `BEFORE INSERT ... RAISE EXCEPTION` (removidos
 * no afterEach). Todas as ações passam pelas rotas reais.
 */
import { EVENT_TYPES, closingWeekStart, mondayOf } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase, setupTablet } from './helpers';
import { address, createCustomer, createOrder, receiptBody } from './commercial-helpers';
import { F, PINS, adjust, finish, labor, prepareCompany, row, scenario } from './labor-helpers';
import {
  approvedNeeds,
  confirmPurchase,
  createPurchase,
  createSupplier,
  linen,
} from './purchasing-helpers';
import { day, today, userIdOf } from './production-helpers';

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
  await clearFailures();
  setAttendanceClock();
});

const post = (c: Client, path: string, body: unknown = {}, key = idemKey()) =>
  c.post(path, body, { 'idempotency-key': key });
const put = (c: Client, path: string, body: unknown, key = idemKey()) =>
  c.req('PUT', path, body, { 'idempotency-key': key });

// ─────────────────────────── Injeção de falha ───────────────────────────

const installed = new Set<string>();

/**
 * Falha real do banco no k-ésimo INSERT da tabela dentro da MESMA transação (contador local à
 * transação via `set_config(..., true)`), opcionalmente só quando `when` vale para a linha.
 */
async function failOn(table: string, opts: { nth?: number; when?: string } = {}) {
  await db().$executeRawUnsafe(`CREATE OR REPLACE FUNCTION r4a_fail_fn() RETURNS trigger AS $$
    DECLARE n int := coalesce(nullif(current_setting('r4a.n_' || TG_TABLE_NAME, true), ''), '0')::int + 1;
    BEGIN
      PERFORM set_config('r4a.n_' || TG_TABLE_NAME, n::text, true);
      IF n = TG_ARGV[0]::int THEN
        RAISE EXCEPTION 'falha simulada R4 em % (insert #%)', TG_TABLE_NAME, n;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await db().$executeRawUnsafe(
    `CREATE TRIGGER r4a_fail BEFORE INSERT ON "${table}" FOR EACH ROW WHEN (${opts.when ?? 'true'}) EXECUTE FUNCTION r4a_fail_fn('${opts.nth ?? 1}')`,
  );
  installed.add(table);
}
async function clearFailures() {
  for (const t of installed)
    await db().$executeRawUnsafe(`DROP TRIGGER IF EXISTS r4a_fail ON "${t}"`);
  installed.clear();
  await db().$executeRawUnsafe(`DROP FUNCTION IF EXISTS r4a_fail_fn()`);
}
/** Falha no INSERT da auditoria de UMA ação. */
const failAudit = (action: string) =>
  failOn('audit_logs', { when: `NEW.action = '${action.replace(/'/g, "''")}'` });

/** Contagem de TODAS as tabelas do banco (exceto o controle de migrations). */
async function allCounts(): Promise<Record<string, number>> {
  const tables = (
    await db().$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
      ORDER BY tablename`
  ).map((t) => t.tablename);
  const rows = await db().$queryRawUnsafe<{ t: string; n: number }[]>(
    tables.map((t) => `SELECT '${t}' AS t, count(*)::int AS n FROM "${t}"`).join(' UNION ALL '),
  );
  return Object.fromEntries(rows.map((r) => [r.t, r.n]));
}
const diff = (a: Record<string, number>, b: Record<string, number>) =>
  Object.fromEntries(
    Object.keys(b)
      .filter((t) => b[t] !== a[t])
      .map((t) => [t, b[t]! - (a[t] ?? 0)]),
  );

const auditOf = (action: string, entityId?: string) =>
  db().auditLog.findMany({
    where: { action, ...(entityId ? { entityId } : {}) },
    orderBy: { createdAt: 'asc' },
  });
const sessionOf = async (userId: string) =>
  (
    await db().session.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    })
  ).map((s) => s.id);

// ─────────────────────────── Novo serviço ───────────────────────────

const ITEMS = [
  {
    pieceType: 'SOFA',
    description: 'Sofá 3 lugares',
    quantity: 1,
    serviceType: 'REFORMA_COMPLETA',
  },
  { pieceType: 'POLTRONA', description: 'Poltronas', quantity: 2, serviceType: 'TROCA_DE_TECIDO' },
];
async function logisticsSetup(admin: Client) {
  const andre = await userIdOf('André');
  const izaias = await userIdOf('Izaías');
  const r = await put(admin, '/api/v1/finance/logistics-defaults', {
    defaultPickupCostCents: 8000,
    defaultDeliveryCostCents: 12000,
    logisticsPayeeUserId: andre,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { andre, izaias };
}
/** Cliente NOVO + endereço + valor com cobrança estruturada + retirada terceirizada com custo. */
function servicePayload(name: string, izaias: string, customer?: unknown) {
  return {
    customer: customer ?? {
      mode: 'NOVO',
      kind: 'PF',
      name,
      phone: null,
      email: null,
      allowSimilar: true,
      address: { ...address, complement: 'Casa 2', isPrimary: true },
    },
    service: {
      contractedService: 'Reforma completa',
      agreedValueCents: 300000,
      payment: { model: 'ENTRADA_ENTREGA' },
      promisedDate: day(30),
      items: ITEMS,
    },
    pickup: {
      scheduledDate: day(2),
      windowStart: '09:30',
      team: 'LOGISTICA_TERCEIRIZADA',
      participantUserIds: [izaias],
      amountCents: 10000,
    },
  };
}

describe('F2-07 — Novo serviço: falha injetada em cada passo não deixa registro parcial (CA2-02)', () => {
  it('cada INSERT da operação (primeiro e último de cada tabela) falhando: tudo desfeito; a mesma chave depois cria uma vez', async () => {
    const admin = await loginAdmin(app);
    const { izaias } = await logisticsSetup(admin);

    // Referência sem falha: quais tabelas o Novo serviço grava e quantas linhas em cada uma.
    const ref0 = await allCounts();
    const ok = await post(admin, '/api/v1/services', servicePayload('Cliente Referência', izaias));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const delta = diff(ref0, await allCounts());
    // A operação toca, no mínimo, todos os passos citados na lacuna da auditoria.
    for (const t of [
      'customers',
      'customer_addresses',
      'commercial_orders',
      'commercial_order_items',
      'pickup_requests',
      'customer_receivables',
      'logistics_costs',
      'audit_logs',
      'domain_events',
      'idempotency_keys',
    ])
      expect(delta[t], `tabela ${t} deveria ser gravada pelo Novo serviço`).toBeGreaterThan(0);
    expect(delta.customer_receivables).toBe(2);
    expect(delta.logistics_costs).toBe(1);

    // Cada passo: falha no primeiro e no último INSERT de cada tabela gravada.
    const steps = Object.entries(delta)
      .filter(([t]) => t !== 'idempotency_keys')
      .flatMap(([t, n]) => (n > 1 ? [[t, 1] as const, [t, n] as const] : [[t, 1] as const]));
    expect(steps.length).toBeGreaterThanOrEqual(12);
    let i = 0;
    for (const [table, nth] of steps) {
      i++;
      const name = `Cliente Falha ${i}`;
      const payload = servicePayload(name, izaias);
      const key = idemKey();
      const before = await allCounts();
      await failOn(table, { nth });
      const bad = await post(admin, '/api/v1/services', payload, key);
      expect(bad.status, `${table}#${nth}: ${JSON.stringify(bad.body)}`).toBeGreaterThanOrEqual(
        500,
      );
      // Nada parcial em NENHUMA tabela (inclusive a chave de idempotência, liberada).
      expect(diff(before, await allCounts()), `${table}#${nth}`).toEqual({});
      expect(await db().customer.count({ where: { name } })).toBe(0);
      await clearFailures();
      // Sem a falha, a MESMA chave não está presa: cria tudo, exatamente uma vez.
      const retry = await post(admin, '/api/v1/services', payload, key);
      expect(retry.status, `${table}#${nth} retry: ${JSON.stringify(retry.body)}`).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBeUndefined();
      const after = await allCounts();
      expect(diff(before, after), `${table}#${nth} retry`).toEqual(delta);
      // Repetir de novo devolve o mesmo resultado sem gravar nada.
      const replay = await post(admin, '/api/v1/services', payload, key);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(retry.body);
      expect(diff(after, await allCounts())).toEqual({});
      expect(await db().customer.count({ where: { name } })).toBe(1);
    }
  });

  it('cliente existente + endereço novo: falha após o endereço, na cobrança, no custo, na auditoria final e no outbox desfaz tudo', async () => {
    const admin = await loginAdmin(app);
    const { izaias } = await logisticsSetup(admin);
    const existing = await createCustomer(admin, { name: 'Cliente Existente R4', phone: null });
    const customer = {
      mode: 'EXISTENTE',
      customerId: existing.id,
      newAddress: { ...address, label: 'Casa de praia', street: 'Rua do Mar' },
    };
    const cases: [string, { nth?: number; when?: string }][] = [
      // Logo após `addCustomerAddress`: a auditoria do endereço.
      ['audit_logs', { when: `NEW.action = 'customer.address_added'` }],
      // Pedido criado, cobrança é o passo seguinte: 1ª e 2ª cobrança da condição.
      ['customer_receivables', { nth: 1 }],
      ['customer_receivables', { nth: 2 }],
      ['logistics_costs', {}],
      ['audit_logs', { when: `NEW.action = 'service.created'` }],
      ['domain_events', { when: `NEW.payload ? 'newService'` }],
    ];
    for (const [table, opts] of cases) {
      const before = await allCounts();
      const key = idemKey();
      const payload = servicePayload('', izaias, customer);
      await failOn(table, opts);
      const bad = await post(admin, '/api/v1/services', payload, key);
      expect(bad.status, `${table} ${JSON.stringify(opts)}`).toBeGreaterThanOrEqual(500);
      expect(diff(before, await allCounts()), `${table} ${JSON.stringify(opts)}`).toEqual({});
      expect(
        await db().customerAddress.count({
          where: { customerId: existing.id, label: 'Casa de praia' },
        }),
      ).toBe(0);
      expect(await db().commercialOrder.count({ where: { customerId: existing.id } })).toBe(0);
      await clearFailures();
    }
    // Sem falha: um endereço, um pedido, duas cobranças, um custo — uma única vez.
    const key = idemKey();
    const payload = servicePayload('', izaias, customer);
    const okRes = await post(admin, '/api/v1/services', payload, key);
    expect(okRes.status, JSON.stringify(okRes.body)).toBe(201);
    expect(
      await db().customerAddress.count({
        where: { customerId: existing.id, label: 'Casa de praia' },
      }),
    ).toBe(1);
    const orderId = okRes.body.order.id as string;
    expect(await db().customerReceivable.count({ where: { orderId } })).toBe(2);
    expect(
      await db().logisticsCost.count({ where: { pickupId: okRes.body.pickup.id as string } }),
    ).toBe(1);
  });
});

// ─────────────────────────── F1-06 ───────────────────────────

describe('F1-06 — auditoria das ações novas, na mesma transação', () => {
  it('service.created: ator, entidade, resumo e detalhes; falha no INSERT da auditoria desfaz o Novo serviço', async () => {
    const admin = await loginAdmin(app);
    const { izaias, andre } = await logisticsSetup(admin);
    const adminId = (await db().user.findFirstOrThrow({ where: { email: 'gestor@teste.local' } }))
      .id;
    const payload = servicePayload('Cliente Auditado', izaias);
    const before = await allCounts();
    await failAudit('service.created');
    const bad = await post(admin, '/api/v1/services', payload);
    expect(bad.status).toBeGreaterThanOrEqual(500);
    expect(diff(before, await allCounts())).toEqual({});
    await clearFailures();

    const r = await post(admin, '/api/v1/services', payload);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const [a, ...more] = await auditOf('service.created');
    expect(more).toHaveLength(0);
    expect(a).toMatchObject({
      actorUserId: adminId,
      entityType: 'commercial_order',
      entityId: r.body.order.id,
    });
    expect(await sessionOf(adminId)).toContain(a!.sessionId);
    expect(a!.requestId).toBeTruthy();
    expect(a!.summary).toContain('Cliente Auditado');
    expect(a!.summary).toContain(r.body.order.code);
    expect(a!.summary).toContain(r.body.pickup.code);
    expect(a!.summary).toContain('(cliente novo)');
    const cost = await db().logisticsCost.findFirstOrThrow({
      where: { pickupId: r.body.pickup.id },
    });
    expect(a!.changes).toEqual({
      customerId: r.body.customer.id,
      customerCreated: true,
      orderId: r.body.order.id,
      pickupId: r.body.pickup.id,
      team: 'LOGISTICA_TERCEIRIZADA',
      customerDropOff: false,
      responsible: andre,
      tripCostId: cost.id,
    });
  });

  /** Ricardo com R$ 1.000 liberado (sofá concluído) — como em negociacao-confirmacao. */
  async function laborBase() {
    const s = await scenario(app);
    const ric = await labor(s.admin, {
      professionalUserId: s.ids.ricardo,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.sofa.id,
      agreedCents: 100000,
      eligibility: 'PRODUCAO_CONCLUIDA',
    });
    await finish(s.tablets.Ricardo!, s.sofaTask.id);
    const R = s.tablets.Ricardo!;
    const u = await post(R, F('/my-earnings/unlock'), { pin: PINS.Ricardo });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    const token = u.body.unlockToken as string;
    const H = { 'x-earnings-unlock': token };
    const ask = (body: Record<string, unknown>) =>
      R.req('POST', F('/my-earnings/requests'), body, { ...H, 'idempotency-key': idemKey() });
    const decide = async (id: string, action: 'approve' | 'reject', note?: string) => {
      const v = await db().valueChangeRequest.findUniqueOrThrow({ where: { id } });
      return post(s.admin, F(`/value-requests/${id}/${action}`), {
        version: v.version,
        ...(note !== undefined ? { note } : {}),
      });
    };
    const adminId = (await db().user.findFirstOrThrow({ where: { email: 'gestor@teste.local' } }))
      .id;
    return { s, ric, R, token, H, ask, decide, adminId };
  }

  it('finance.value_request_created / rejected / approved / obsolete: auditadas; falha na auditoria desfaz cada uma', async () => {
    const { s, ric, ask, decide, adminId } = await laborBase();
    const req = {
      targetKind: 'PRODUCAO',
      targetId: ric.id,
      requestedCents: 120000,
      reason: 'Tecido grosso exigiu costura dupla',
    };
    const finEvents = (kind: string) => db().financialEvent.count({ where: { kind } });

    // created — falha: nenhum pedido, evento financeiro ou aviso ao gestor.
    await failAudit('finance.value_request_created');
    const bad1 = await ask(req);
    expect(bad1.status).toBeGreaterThanOrEqual(500);
    expect(await db().valueChangeRequest.count()).toBe(0);
    expect(await finEvents('PEDIDO_ALTERACAO')).toBe(0);
    expect(await db().notification.count({ where: { kind: 'VALOR_SOLICITADO' } })).toBe(0);
    await clearFailures();
    const r1 = await ask(req);
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const [c1] = await auditOf('finance.value_request_created', r1.body.id);
    expect(c1).toMatchObject({
      actorUserId: s.ids.ricardo,
      entityType: 'value_change_request',
    });
    expect(await sessionOf(s.ids.ricardo)).toContain(c1!.sessionId);
    expect(c1!.summary).toContain(r1.body.code);
    expect(c1!.summary).toContain('mão de obra');
    expect(await finEvents('PEDIDO_ALTERACAO')).toBe(1);

    // rejected — falha: o pedido continua pendente, mesma versão, sem evento de recusa.
    const v1 = (await db().valueChangeRequest.findUniqueOrThrow({ where: { id: r1.body.id } }))
      .version;
    await failAudit('finance.value_request_rejected');
    const bad2 = await decide(r1.body.id, 'reject', 'Valor já combinado no orçamento');
    expect(bad2.status).toBeGreaterThanOrEqual(500);
    expect(
      await db().valueChangeRequest.findUniqueOrThrow({ where: { id: r1.body.id } }),
    ).toMatchObject({ status: 'PENDENTE', version: v1, decidedAt: null, decisionNote: null });
    expect(await finEvents('RECUSADA')).toBe(0);
    await clearFailures();
    expect((await decide(r1.body.id, 'reject', 'Valor já combinado no orçamento')).status).toBe(
      200,
    );
    const [rj] = await auditOf('finance.value_request_rejected', r1.body.id);
    expect(rj).toMatchObject({ actorUserId: adminId, entityType: 'value_change_request' });
    expect(rj!.summary).toContain(r1.body.code);
    expect(rj!.changes).toEqual({
      status: { from: 'PENDENTE', to: 'RECUSADA' },
      reason: 'Valor já combinado no orçamento',
    });

    // approved — falha: nenhum ajuste aplicado na mão de obra, pedido segue pendente.
    const r2 = await ask({ ...req, reason: 'Segundo pedido' });
    expect(r2.status).toBe(201);
    await failAudit('finance.value_request_approved');
    const bad3 = await decide(r2.body.id, 'approve', 'Combinado');
    expect(bad3.status).toBeGreaterThanOrEqual(500);
    expect(await row(ric.id)).toMatchObject({ agreedCents: 100000, adjustmentsCents: 0 });
    expect(await db().financialAdjustment.count()).toBe(0);
    expect(
      (await db().valueChangeRequest.findUniqueOrThrow({ where: { id: r2.body.id } })).status,
    ).toBe('PENDENTE');
    expect(await finEvents('APROVADA')).toBe(0);
    await clearFailures();
    const ok3 = await decide(r2.body.id, 'approve', 'Combinado');
    expect(ok3.status, JSON.stringify(ok3.body)).toBe(200);
    expect((await row(ric.id)).adjustmentsCents).toBe(20000);
    const [ap] = await auditOf('finance.value_request_approved', r2.body.id);
    expect(ap).toMatchObject({ actorUserId: adminId, entityType: 'value_change_request' });
    expect(ap!.summary).toContain(r2.body.code);
    expect(ap!.changes).toEqual({
      status: { from: 'PENDENTE', to: 'APROVADA' },
      appliedAs: 'AJUSTE',
      deltaCents: 20000,
    });

    // obsolete — o alvo mudou (ajuste do gestor); a falha na auditoria desfaz a marcação.
    const r3 = await ask({ ...req, requestedCents: 150000, reason: 'Terceiro pedido' });
    expect(r3.status).toBe(201);
    expect((await adjust(s.admin, ric.id, 5000, 'Ajuste do gestor')).status).toBe(200);
    const v3 = (await db().valueChangeRequest.findUniqueOrThrow({ where: { id: r3.body.id } }))
      .version;
    await failAudit('finance.value_request_obsolete');
    const bad4 = await decide(r3.body.id, 'approve');
    expect(bad4.status).toBeGreaterThanOrEqual(500);
    expect(
      await db().valueChangeRequest.findUniqueOrThrow({ where: { id: r3.body.id } }),
    ).toMatchObject({ status: 'PENDENTE', version: v3, decidedAt: null });
    await clearFailures();
    const late = await decide(r3.body.id, 'approve');
    expect(late.status).toBe(422);
    expect(late.body.error.message).toMatch(/obsoleto/i);
    const [ob] = await auditOf('finance.value_request_obsolete', r3.body.id);
    expect(ob).toMatchObject({ actorUserId: adminId, entityType: 'value_change_request' });
    expect(ob!.summary).toContain(r3.body.code);
    expect(ob!.summary).toContain('obsoleta');
    expect(ob!.changes).toMatchObject({ status: { from: 'PENDENTE', to: 'OBSOLETA' } });
    expect((ob!.changes as { reason: string }).reason).toBeTruthy();
    // Nada aplicado pelo pedido obsoleto: só o ajuste manual do gestor somou.
    expect((await row(ric.id)).adjustmentsCents).toBe(25000);
  });

  it('finance.week_confirmed: auditada sem PIN/token; falha na auditoria desfaz a confirmação', async () => {
    const { s, R, token, H } = await laborBase();
    const week = closingWeekStart(today());
    const e = (await R.req('GET', F('/my-earnings'), undefined, H)).body;
    const hash = e.confirmation.currentHash as string;
    const confirm = () =>
      R.req(
        'POST',
        F('/my-earnings/confirm'),
        { week, hash, confirm: true },
        { ...H, 'idempotency-key': idemKey() },
      );
    await failAudit('finance.week_confirmed');
    const bad = await confirm();
    expect(bad.status).toBeGreaterThanOrEqual(500);
    expect(await db().weeklyClosingConfirmation.count()).toBe(0);
    expect(await db().financialEvent.count({ where: { kind: 'CONFIRMADA' } })).toBe(0);
    await clearFailures();
    const ok = await confirm();
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const conf = await db().weeklyClosingConfirmation.findFirstOrThrow();
    const [a, ...more] = await auditOf('finance.week_confirmed');
    expect(more).toHaveLength(0);
    expect(a).toMatchObject({
      actorUserId: s.ids.ricardo,
      entityType: 'weekly_closing_confirmation',
      entityId: conf.id,
    });
    expect(await sessionOf(s.ids.ricardo)).toContain(a!.sessionId);
    expect(a!.summary).toContain(ok.body.code);
    expect(a!.summary).toContain(week);
    const ch = a!.changes as Record<string, unknown>;
    expect(ch).toMatchObject({
      before: null,
      after: { kind: 'PROFISSIONAL', code: ok.body.code, hash },
      verification: { method: 'PIN_D12' },
      sessionId: a!.sessionId,
      deviceId: conf.deviceId,
    });
    // Conteúdo seguro: nem o PIN nem o token de desbloqueio vão para a auditoria.
    const json = JSON.stringify(a);
    expect(json).not.toContain(PINS.Ricardo!);
    expect(json).not.toContain(token);
  });

  /** OS com o sofá recebido, pronta para o pré-planejamento (como em pre-planejamento). */
  async function sofaOs(admin: Client, name: string) {
    const customer = await createCustomer(admin, { name, phone: null, allowSimilar: true });
    const order = await createOrder(admin, customer, [
      { pieceType: 'SOFA', description: 'Sofá', quantity: 1 },
    ]);
    const rec = await post(
      admin,
      '/api/v1/receipts',
      receiptBody(
        order.id,
        order.items.map((i: { id: string }) => ({ orderItemId: i.id, quantity: 1 })),
      ),
    );
    expect(rec.status).toBe(201);
    const so = await post(admin, '/api/v1/service-orders', {
      orderId: order.id,
      items: order.items.map((i: { id: string }) => ({
        orderItemId: i.id,
        quantity: 1,
        description: 'Sofá',
        serviceType: 'REFORMA_COMPLETA',
      })),
    });
    expect(so.status, JSON.stringify(so.body)).toBe(201);
    return so.body as { id: string; code: string; items: { id: string }[] };
  }

  it('production.plan_created e production.service_rescheduled: auditadas; falha na auditoria desfaz o planejamento e a reprogramação', async () => {
    const admin = await loginAdmin(app);
    const adminId = (await db().user.findFirstOrThrow({ where: { email: 'gestor@teste.local' } }))
      .id;
    const ricardo = await userIdOf('Ricardo');
    const so = await sofaOs(admin, 'Cliente Plano R4');
    const entries = [
      {
        serviceOrderId: so.id,
        startDate: today(),
        pieces: [{ serviceOrderItemId: so.items[0]!.id, upholstererUserId: ricardo }],
      },
    ];
    const plansBefore = await db().productionPlan.count();
    const tasksBefore = await db().productionTask.count();
    await failAudit('production.plan_created');
    const bad = await post(admin, '/api/v1/production/plan-services', { entries });
    expect(bad.status).toBeGreaterThanOrEqual(500);
    expect(await db().productionPlan.count()).toBe(plansBefore);
    expect(await db().productionPlanItem.count({ where: { serviceOrderId: so.id } })).toBe(0);
    expect(await db().productionTask.count()).toBe(tasksBefore);
    expect(await db().auditLog.count({ where: { action: 'production.service_planned' } })).toBe(0);
    await clearFailures();
    const ok = await post(admin, '/api/v1/production/plan-services', { entries });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const planId = ok.body.planned[0].planId as string;
    const [pc] = await auditOf('production.plan_created', planId);
    expect(pc).toMatchObject({ actorUserId: adminId, entityType: 'production_plan' });
    expect(pc!.summary).toContain(mondayOf(today()));
    expect(pc!.summary).toMatch(/pré-planejamento/);

    // Reprogramação para outra semana (cria o plano de destino): falha na auditoria → nada muda.
    const item0 = await db().productionPlanItem.findFirstOrThrow({
      where: { serviceOrderId: so.id },
    });
    const tasks0 = await db().productionTask.findMany({
      where: { serviceOrderId: so.id },
      orderBy: { id: 'asc' },
    });
    const weekAhead = mondayOf(day(14));
    const target = new Date(Date.parse(`${weekAhead}T12:00:00Z`) + 2 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const plans1 = await db().productionPlan.count();
    await failAudit('production.service_rescheduled');
    const badMv = await put(admin, `/api/v1/production/planned/${item0.id}`, {
      version: item0.version,
      startDate: target,
    });
    expect(badMv.status).toBeGreaterThanOrEqual(500);
    expect(await db().productionPlanItem.findMany({ where: { serviceOrderId: so.id } })).toEqual([
      item0,
    ]);
    expect(
      await db().productionTask.findMany({
        where: { serviceOrderId: so.id },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(tasks0);
    // O plano da semana de destino (criado no meio da transação) também foi desfeito.
    expect(await db().productionPlan.count()).toBe(plans1);
    expect(await db().auditLog.count({ where: { action: 'production.plan_created' } })).toBe(1);
    await clearFailures();
    const mv = await put(admin, `/api/v1/production/planned/${item0.id}`, {
      version: item0.version,
      startDate: target,
    });
    expect(mv.status, JSON.stringify(mv.body)).toBe(200);
    const [rs, ...more] = await auditOf('production.service_rescheduled', so.id);
    expect(more).toHaveLength(0);
    expect(rs).toMatchObject({ actorUserId: adminId, entityType: 'service_order' });
    expect(rs!.summary).toContain(so.code);
    expect(rs!.summary).toContain(`semana ${mondayOf(today())} → ${weekAhead}`);
    expect(rs!.changes).toMatchObject({
      from: { week: mondayOf(today()), startDate: today() },
      input: { version: item0.version, startDate: target },
    });
    // O plano de destino foi criado pelo pré-planejamento e auditado também.
    const dest = await db().productionPlan.findFirstOrThrow({
      where: { weekStart: new Date(`${weekAhead}T00:00:00Z`) },
    });
    expect(await auditOf('production.plan_created', dest.id)).toHaveLength(1);
  });
});

// ─────────────────────────── F1-06 + F3-20b ───────────────────────────

describe('F3-20b / F1-06 — auditoria da chegada física de materiais', () => {
  async function fabricPurchase(admin: Client) {
    const { reqs } = await approvedNeeds(admin, 'Cliente Material R4', (s) => [
      linen(s.items[0].id, 15),
    ]);
    const supplier = await createSupplier(admin);
    const po = await createPurchase(admin, {
      supplierId: supplier.id,
      expectedDate: today(),
      items: [
        {
          sourcing: 'EXCLUSIVO_OS',
          allocations: [{ materialRequirementId: reqs[0]!.id, quantity: 15 }],
          quantity: 15,
          unitPriceCents: 4500,
        },
      ],
    });
    expect(po.status, JSON.stringify(po.body)).toBe(201);
    const c = await confirmPurchase(admin, po.body);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const item = await db().purchaseOrderItem.findFirstOrThrow({
      where: { purchaseOrderId: po.body.id },
    });
    return { po: c.body as { id: string; code: string }, item };
  }

  it('material_arrival.registered lida pela rota de auditoria: ator, entidade e conteúdo seguro; falha nela desfaz a chegada', async () => {
    const admin = await loginAdmin(app);
    const { po, item } = await fabricPurchase(admin);
    const { tablet: joao, employee } = await setupTablet(app, admin, {
      name: 'Tablet João',
      employee: 'João',
      pin: '111222',
    });
    const joaoId = employee.userId;
    const card = async () =>
      (
        (await joao.get('/api/v1/arrivals')).body.materials as {
          purchaseOrderId: string;
          version: number;
        }[]
      ).find((m) => m.purchaseOrderId === po.id)!;
    const c0 = await card();
    expect(c0).toBeTruthy();
    const body = {
      version: c0.version,
      lines: [{ purchaseOrderItemId: item.id, quantity: 3, physicalUnit: 'ROLO' }],
    };
    const poVersion = (await db().purchaseOrder.findUniqueOrThrow({ where: { id: po.id } }))
      .version;

    // Falha na auditoria: nenhuma chegada, versão do pedido intacta, nenhum evento no outbox.
    await failAudit('material_arrival.registered');
    const bad = await post(joao, `/api/v1/arrivals/purchase-orders/${po.id}/confirm`, body);
    expect(bad.status).toBeGreaterThanOrEqual(500);
    expect(await db().materialArrival.count()).toBe(0);
    expect((await db().purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).version).toBe(
      poVersion,
    );
    expect(
      await db().domainEvent.count({ where: { type: EVENT_TYPES.MATERIAL_ARRIVAL_REGISTERED } }),
    ).toBe(0);
    expect(await auditOf('material_arrival.registered')).toHaveLength(0);
    await clearFailures();

    const r = await post(joao, `/api/v1/arrivals/purchase-orders/${po.id}/confirm`, body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const arrivalId = r.body.arrival.id as string;

    // Leitura pela rota real de auditoria (gestor com auditoria.ver).
    const list = await admin.get(`/api/audit?entityType=material_arrival&entityId=${arrivalId}`);
    expect(list.status).toBe(200);
    const items = list.body.items as {
      action: string;
      entityType: string;
      entityId: string;
      actor: { id: string; displayName: string } | null;
      summary: string;
      changes: unknown;
      ipAddress: string | null;
    }[];
    expect(items).toHaveLength(1);
    const a = items[0]!;
    expect(a).toMatchObject({
      action: 'material_arrival.registered',
      entityType: 'material_arrival',
      entityId: arrivalId,
      actor: { id: joaoId, displayName: 'João' },
    });
    expect(a.summary).toContain(r.body.arrival.code);
    expect(a.summary).toContain(po.code);
    expect(a.summary).toContain('3 rolo(s) de');
    expect(a.summary).toMatch(/aguardando conferência/);
    expect(a.changes).toEqual({
      lines: [{ purchaseOrderItemId: item.id, quantity: 3, physicalUnit: 'ROLO' }],
      problem: null,
    });
    // Conteúdo seguro: sem preço/valores do pedido nem PIN do tablet.
    const json = JSON.stringify(a);
    expect(json).not.toMatch(/Cents|price|preço|valor|4500|67500/i);
    expect(json).not.toContain('111222');
    // Sessão do tablet que registrou (no banco).
    const row0 = (await auditOf('material_arrival.registered', arrivalId))[0]!;
    expect(await sessionOf(joaoId)).toContain(row0.sessionId);
    expect(row0.requestId).toBeTruthy();
    // Tablet (sem auditoria.ver, sessão de tablet) não lê a auditoria.
    expect((await joao.get('/api/audit')).status).toBe(403);
  });
});
