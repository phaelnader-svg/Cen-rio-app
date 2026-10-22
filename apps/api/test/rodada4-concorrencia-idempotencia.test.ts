/**
 * Remediação pós-auditoria, Rodada 4 — prova transversal de CONCORRÊNCIA e IDEMPOTÊNCIA.
 * Requisições HTTP simultâneas reais (Promise.all pelo app in-process) e invariantes finais
 * conferidas no banco (contagens, somas, versões), não só os códigos HTTP.
 * Itens novos: (a) recebimento 7 + 7 na mesma linha de 12; (c) confirmação semanal D13 dupla
 * simultânea e × ajuste do gestor; (d) conta a pagar com a mesma versão; (e) ajuste de mão de
 * obra com a mesma versão (total = base + 1 ajuste); (f) resolução de revisão de mão de obra:
 * 1 resolução, 1 evento; (g) mesma Idempotency-Key em criações simultâneas (compra, pagamento,
 * ação do tablet); (i) saídas livres e reserva × saída do mesmo item de estoque; (k) recebimento
 * e (l) compra com resposta perdida + retry; (n) ação do tablet (sessão DEVICE) simultânea e
 * repetida com a mesma chave. Os demais itens já têm prova citada no relatório da rodada.
 */
import { closingWeekStart } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import {
  F,
  PINS,
  allowWeek,
  finish,
  labor,
  post,
  prepareCompany,
  row,
  scenario,
  setOwner,
} from './labor-helpers';
import { openServiceOrder } from './measurement-helpers';
import { act, today } from './production-helpers';
import {
  approvedNeeds,
  confirmPurchase,
  confirmedFabricPurchase,
  createPurchase,
  createSupplier,
  linen,
  ok,
  receive,
  staples,
} from './purchasing-helpers';

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  setAttendanceClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  await prepareCompany();
});
afterEach(() => setAttendanceClock());

const WEEK = closingWeekStart(today());
const sorted = (rs: { status: number }[]) => rs.map((r) => r.status).sort();

/** Compra de 12 grampos para o ESTOQUE, 3 destinados à OS (reserva ao receber); confirmada. */
async function stockPurchase(admin: Client) {
  const supplier = await createSupplier(admin);
  const need = await approvedNeeds(admin, 'Cliente Concorrência', () => [staples({ quantity: 3 })]);
  const po = await createPurchase(admin, {
    supplierId: supplier.id,
    expectedDate: '2030-01-10',
    items: [
      {
        sourcing: 'ESTOQUE',
        allocations: [{ materialRequirementId: need.reqs[0]!.id, quantity: 3 }],
        quantity: 12,
        unitPriceCents: 1890,
      },
    ],
  });
  expect(po.status, JSON.stringify(po.body)).toBe(201);
  const c = await confirmPurchase(admin, po.body);
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  return { po: c.body, item: c.body.items[0] as { id: string }, need };
}

async function stockItemWith(admin: Client, qty: number) {
  const item = await admin.post('/api/v1/stock-items', {
    kind: 'ESPUMA',
    description: 'Espuma D28',
    foamDensity: 'D28',
    thicknessCm: 3,
    lengthCm: 200,
    widthCm: 60,
    unit: 'PLACA',
    minQuantity: 0,
  });
  expect(item.status).toBe(201);
  const adj = await post(admin, `/api/v1/stock-items/${item.body.id}/adjust`, {
    quantity: qty,
    reason: 'Inventário inicial',
  });
  expect(adj.status).toBe(200);
  return item.body as { id: string };
}
const stockRow = (id: string) => db().stockItem.findUniqueOrThrow({ where: { id } });

// ───────────────────────────── (a) e (k) recebimento ─────────────────────────────

describe('(a) recebimentos simultâneos da mesma linha que juntos excedem o saldo', () => {
  it('7 + 7 na linha de 12 (cada um cabe sozinho): um entra inteiro, o outro é recusado sem gravar nada; estoque e reserva coerentes', async () => {
    const admin = await loginAdmin(app);
    const { po, item } = await stockPurchase(admin);
    const res = await Promise.all([
      receive(admin, po.id, [ok(item.id, 7)]),
      receive(admin, po.id, [ok(item.id, 7)]),
    ]);
    expect(sorted(res), JSON.stringify(res.map((r) => r.body))).toEqual([201, 409]);
    // Nenhum recebimento parcial do perdedor: 1 recebimento, 1 linha, 7 recebidos.
    expect(await db().materialReceipt.count()).toBe(1);
    expect(await db().materialReceiptLine.count()).toBe(1);
    const line = await db().purchaseOrderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(Number(line.receivedQuantity)).toBe(7);
    // Estoque: entrou exatamente uma vez; a reserva da OS (3) cabe no físico.
    const stock = await db().stockItem.findFirstOrThrow();
    expect(Number(stock.onHand)).toBe(7);
    expect(Number(stock.reserved)).toBe(3);
    const moves = await db().stockMovement.findMany({ where: { stockItemId: stock.id } });
    expect(moves.reduce((a, m) => a + Number(m.quantity), 0)).toBe(7);
    // O que falta (5) continua recebível — o perdedor não "comeu" saldo.
    expect((await receive(admin, po.id, [ok(item.id, 5)])).status).toBe(201);
    expect(Number((await stockRow(stock.id)).onHand)).toBe(12);
  });
});

describe('(k) recebimento de material: commit + resposta perdida + retry', () => {
  it('a mesma chave e o mesmo corpo devolvem o mesmo recebimento (replayed); nada entra em dobro', async () => {
    const admin = await loginAdmin(app);
    const { po, item } = await stockPurchase(admin);
    const key = idemKey();
    const lost = await receive(admin, po.id, [ok(item.id, 4)], key);
    expect(lost.status).toBe(201);
    const retry = await receive(admin, po.id, [ok(item.id, 4)], key);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(lost.body);
    expect(await db().materialReceipt.count()).toBe(1);
    const line = await db().purchaseOrderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(Number(line.receivedQuantity)).toBe(4);
    expect(Number((await db().stockItem.findFirstOrThrow()).onHand)).toBe(4);
    // Mesma chave com outra quantidade: 422, nada novo.
    const other = await receive(admin, po.id, [ok(item.id, 5)], key);
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await db().materialReceipt.count()).toBe(1);
  });

  it('(g) mesma chave em dois recebimentos SIMULTÂNEOS: um executa; o outro é 409 (em andamento) ou replay', async () => {
    const admin = await loginAdmin(app);
    const supplier = await createSupplier(admin);
    const { reqs } = await approvedNeeds(admin, 'Cliente Chave', (s) => [linen(s.items[0].id)]);
    const po = await confirmedFabricPurchase(admin, supplier.id, reqs[0]!);
    const key = idemKey();
    const both = await Promise.all([
      receive(admin, po.id, [ok(po.items[0].id, 5)], key),
      receive(admin, po.id, [ok(po.items[0].id, 5)], key),
    ]);
    const okOnes = both.filter((r) => r.status === 201);
    expect(okOnes.length).toBeGreaterThanOrEqual(1);
    for (const r of both) {
      expect([201, 409]).toContain(r.status);
      if (r.status === 201) expect(r.body.id).toBe(okOnes[0]!.body.id);
    }
    expect(await db().materialReceipt.count()).toBe(1);
    expect(Number((await db().purchaseOrderItem.findFirstOrThrow()).receivedQuantity)).toBe(5);
  });
});

// ───────────────────────────── (l) e (g) compra ─────────────────────────────

describe('(l)/(g) pedido de compra com a mesma chave', () => {
  const body = (reqId: string, supplierId: string) => ({
    supplierId,
    expectedDate: '2030-01-10',
    items: [
      {
        sourcing: 'EXCLUSIVO_OS',
        allocations: [{ materialRequirementId: reqId, quantity: 12 }],
        quantity: 12,
        unitPriceCents: 4500,
      },
    ],
  });

  it('commit + resposta perdida + retry: o mesmo pedido, sem segunda alocação', async () => {
    const admin = await loginAdmin(app);
    const supplier = await createSupplier(admin);
    const { reqs } = await approvedNeeds(admin, 'Cliente Retry', (s) => [linen(s.items[0].id)]);
    const key = idemKey();
    const lost = await createPurchase(admin, body(reqs[0]!.id, supplier.id), key);
    expect(lost.status, JSON.stringify(lost.body)).toBe(201);
    const retry = await createPurchase(admin, body(reqs[0]!.id, supplier.id), key);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(lost.body);
    expect(await db().purchaseOrder.count()).toBe(1);
    expect(await db().purchaseOrderItem.count()).toBe(1);
    const alloc = await db().purchaseAllocation.aggregate({ _sum: { quantity: true } });
    expect(Number(alloc._sum.quantity)).toBe(12);
  });

  it('duas criações SIMULTÂNEAS com a mesma chave: exatamente um pedido', async () => {
    const admin = await loginAdmin(app);
    const supplier = await createSupplier(admin);
    const { reqs } = await approvedNeeds(admin, 'Cliente Simult', (s) => [linen(s.items[0].id)]);
    const key = idemKey();
    const both = await Promise.all([
      createPurchase(admin, body(reqs[0]!.id, supplier.id), key),
      createPurchase(admin, body(reqs[0]!.id, supplier.id), key),
    ]);
    for (const r of both) expect([201, 409], JSON.stringify(r.body)).toContain(r.status);
    const created = both.filter((r) => r.status === 201);
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(new Set(created.map((r) => r.body.id)).size).toBe(1);
    expect(await db().purchaseOrder.count()).toBe(1);
    const alloc = await db().purchaseAllocation.aggregate({ _sum: { quantity: true } });
    expect(Number(alloc._sum.quantity)).toBe(12);
  });
});

// ───────────────────────────── (i) estoque comum ─────────────────────────────

describe('(i) estoque comum: saídas e reserva simultâneas acima do disponível', () => {
  it('duas saídas livres de 6 com 10 em estoque: uma passa, a outra 409; nunca negativo', async () => {
    const admin = await loginAdmin(app);
    const stock = await stockItemWith(admin, 10);
    const issue = () =>
      post(admin, `/api/v1/stock-items/${stock.id}/issue`, { quantity: 6, reason: 'Uso' });
    const res = await Promise.all([issue(), issue()]);
    expect(sorted(res)).toEqual([200, 409]);
    const s = await stockRow(stock.id);
    expect(Number(s.onHand)).toBe(4);
    expect(
      await db().stockMovement.count({ where: { stockItemId: stock.id, type: 'SAIDA_OS' } }),
    ).toBe(1);
  });

  it('reserva de 6 × saída livre de 6 com 10 em estoque: só uma; físico ≥ reservado', async () => {
    const admin = await loginAdmin(app);
    const stock = await stockItemWith(admin, 10);
    const so = await openServiceOrder(admin, 'Cliente Reserva');
    const [r, i] = await Promise.all([
      post(admin, '/api/v1/stock-reservations', {
        stockItemId: stock.id,
        serviceOrderId: so.id,
        quantity: 6,
      }),
      post(admin, `/api/v1/stock-items/${stock.id}/issue`, { quantity: 6, reason: 'Uso' }),
    ]);
    expect(
      [r.status, i.status].filter((x) => x === 200 || x === 201),
      JSON.stringify([r.body, i.body]),
    ).toHaveLength(1);
    expect([r.status, i.status]).toContain(409);
    const s = await stockRow(stock.id);
    expect(Number(s.onHand)).toBeGreaterThanOrEqual(Number(s.reserved));
    expect(Number(s.onHand) - Number(s.reserved)).toBe(4);
    expect(await db().stockReservation.count()).toBe(r.status === 201 ? 1 : 0);
  });
});

// ───────────────────── (c) confirmação semanal D13 ─────────────────────

const H = (token: string) => ({ 'x-earnings-unlock': token });
async function tok(c: Client, pin: string) {
  const r = await post(c, F('/my-earnings/unlock'), { pin });
  if (r.status !== 200) throw new Error(`unlock: ${JSON.stringify(r.body)}`);
  return r.body.unlockToken as string;
}
const earnings = async (c: Client, t: string) =>
  (await c.req('GET', F('/my-earnings'), undefined, H(t))).body;
const confirm = (c: Client, t: string, hash: string, key = idemKey()) =>
  c.req(
    'POST',
    F('/my-earnings/confirm'),
    { week: WEEK, hash, confirm: true },
    { ...H(t), 'idempotency-key': key },
  );

/** Ricardo com R$ 1.000 liberado (sofá concluído). */
async function released() {
  const s = await scenario(app);
  const ric = await labor(s.admin, {
    professionalUserId: s.ids.ricardo,
    serviceOrderId: s.so.id,
    serviceOrderItemId: s.sofa.id,
    agreedCents: 100000,
    eligibility: 'PRODUCAO_CONCLUIDA',
  });
  await finish(s.tablets.Ricardo!, s.sofaTask.id);
  return { s, ric };
}

describe('(c) confirmação semanal D13 sob concorrência', () => {
  it('mesmo profissional confirma a mesma semana 2× ao mesmo tempo (mesmo hash, chaves diferentes): 1 confirmação, o mesmo código', async () => {
    const { s } = await released();
    const R = s.tablets.Ricardo!;
    const t = await tok(R, PINS.Ricardo!);
    const hash = (await earnings(R, t)).confirmation.currentHash as string;
    const both = await Promise.all([confirm(R, t, hash), confirm(R, t, hash)]);
    // Regra real (confirmWeek): trava da semana + "mesmo hash devolve a existente".
    expect(sorted(both), JSON.stringify(both.map((r) => r.body))).toEqual([200, 200]);
    expect(both[0]!.body.code).toBe(both[1]!.body.code);
    const rows = await db().weeklyClosingConfirmation.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'PROFISSIONAL', hash, totalCents: 100000 });
    expect(await db().auditLog.count({ where: { action: 'finance.week_confirmed' } })).toBe(1);
    expect((await earnings(R, t)).confirmation.state).toBe('CONFIRMADA');
  });

  it('confirmação × ajuste do gestor simultâneos: nunca "CONFIRMADA" com hash diferente do estado atual', async () => {
    const { s, ric } = await released();
    const R = s.tablets.Ricardo!;
    const t = await tok(R, PINS.Ricardo!);
    for (let n = 0; n < 3; n++) {
      const e = await earnings(R, t);
      const v = (await row(ric.id)).version;
      const [c, a] = await Promise.all([
        confirm(R, t, e.confirmation.currentHash),
        post(s.admin, F(`/labor/${ric.id}/adjustments`), {
          amountCents: 1000,
          reason: `Ajuste concorrente ${n}`,
          version: v,
        }),
      ]);
      expect([200, 409]).toContain(c.status);
      expect(a.status, JSON.stringify(a.body)).toBe(200);
      const cur = (await earnings(R, t)).confirmation;
      const rows = await db().weeklyClosingConfirmation.findMany({
        where: { kind: 'PROFISSIONAL' },
      });
      const matching = rows.filter((x) => x.hash === cur.currentHash);
      // Estado atual "CONFIRMADA" ⇔ existe confirmação com exatamente o hash atual.
      if (cur.state === 'CONFIRMADA') expect(matching.length).toBe(1);
      else expect(matching).toHaveLength(0);
      // O ajuste sempre vence a confirmação antiga: o hash atual mudou nesta rodada.
      expect(cur.currentHash).not.toBe(e.confirmation.currentHash);
      expect(cur.state).not.toBe('CONFIRMADA');
      // Pagamento direto só passa se a semana atual está coberta (aqui não está).
      const p = await post(s.admin, F(`/labor/${ric.id}/payments`), {
        amountCents: 100,
        paidAt: today(),
        method: 'PIX',
        version: (await row(ric.id)).version,
      });
      expect(p.status).toBe(422);
    }
    const p = await row(ric.id);
    expect(p.adjustmentsCents).toBe(3000);
    expect(p.paidCents).toBe(0);
  });
});

// ───────────────────── (d) pagamentos, (e) ajustes, (f) resolução ─────────────────────

describe('(d) conta a pagar: dois pagamentos simultâneos com a mesma versão', () => {
  it('só um entra; pago = valor do vencedor; uma baixa', async () => {
    const admin = await loginAdmin(app);
    const e = await post(admin, F('/expenses'), {
      category: 'CONTABILIDADE',
      description: 'Honorários do contador',
      amountCents: 60000,
      competence: today().slice(0, 7),
      dueDate: today(),
      beneficiary: 'Escritório Exemplo',
    });
    expect(e.status, JSON.stringify(e.body)).toBe(201);
    const ap = await db().accountPayable.findFirstOrThrow();
    const pay = (amountCents: number) =>
      post(admin, F(`/payables/${ap.id}/payments`), {
        amountCents,
        paidAt: today(),
        method: 'PIX',
        version: ap.version,
      });
    const res = await Promise.all([pay(40000), pay(40000)]);
    expect(sorted(res), JSON.stringify(res.map((r) => r.body))).toEqual([200, 409]);
    const after = await db().accountPayable.findUniqueOrThrow({ where: { id: ap.id } });
    expect(after.paidCents).toBe(40000);
    expect(after.version).toBe(ap.version + 1);
    expect(await db().payablePayment.count({ where: { payableId: ap.id } })).toBe(1);
    const sum = await db().payablePayment.aggregate({ _sum: { amountCents: true } });
    expect(sum._sum.amountCents).toBe(40000);
  });
});

describe('(g)/(m) pagamento de mão de obra com a mesma chave', () => {
  it('duas requisições SIMULTÂNEAS com a mesma chave: 1 pagamento; retry depois devolve a mesma resposta', async () => {
    const { s, ric } = await released();
    await allowWeek(s.admin, s.ids.ricardo, WEEK);
    const body = {
      amountCents: 30000,
      paidAt: today(),
      method: 'PIX',
      version: (await row(ric.id)).version,
    };
    const key = idemKey();
    const both = await Promise.all([
      post(s.admin, F(`/labor/${ric.id}/payments`), body, key),
      post(s.admin, F(`/labor/${ric.id}/payments`), body, key),
    ]);
    for (const r of both) expect([200, 409], JSON.stringify(r.body)).toContain(r.status);
    const done = both.find((r) => r.status === 200)!;
    expect(done).toBeTruthy();
    expect(await db().professionalPayment.count()).toBe(1);
    expect((await row(ric.id)).paidCents).toBe(30000);
    // Resposta perdida: o retry com a mesma chave devolve exatamente a resposta gravada.
    const retry = await post(s.admin, F(`/labor/${ric.id}/payments`), body, key);
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(done.body);
    expect(await db().professionalPayment.count()).toBe(1);
    expect((await row(ric.id)).paidCents).toBe(30000);
  });
});

describe('(e) dois ajustes de mão de obra simultâneos com a mesma versão', () => {
  it('um 200 e um 409; total = combinado + o ajuste do vencedor; versão sobe uma vez', async () => {
    const { s, ric } = await released();
    const before = await row(ric.id);
    const res = await Promise.all(
      [1500, 2500].map((amountCents) =>
        post(s.admin, F(`/labor/${ric.id}/adjustments`), {
          amountCents,
          reason: 'Ajuste concorrente',
          version: before.version,
        }),
      ),
    );
    expect(sorted(res), JSON.stringify(res.map((r) => r.body))).toEqual([200, 409]);
    const winner = [1500, 2500][res.findIndex((r) => r.status === 200)]!;
    const after = await row(ric.id);
    expect(after.adjustmentsCents).toBe(before.adjustmentsCents + winner);
    expect(after.agreedCents).toBe(before.agreedCents);
    expect(after.version).toBe(before.version + 1);
    expect(await db().financialAdjustment.count({ where: { productionPayableId: ric.id } })).toBe(
      1,
    );
    expect(await db().financialEvent.count({ where: { entityId: ric.id, kind: 'AJUSTE' } })).toBe(
      1,
    );
  });
});

describe('(f) resolução simultânea de uma revisão de mão de obra', () => {
  it('uma resolução, um evento REVISAO_RESOLVIDA, uma auditoria, um ajuste', async () => {
    const s = await scenario(app);
    const mar = await labor(s.admin, {
      professionalUserId: s.ids.marcio,
      serviceOrderId: s.so.id,
      serviceOrderItemId: s.poltronas.id,
      agreedCents: 40000,
    });
    await setOwner(s.admin, s.poltronas.id, s.ids.ricardo, s.ids.marcio, 'Márcio de férias');
    const rv = await db().laborReview.findFirstOrThrow({ where: { status: 'ABERTA' } });
    const body = {
      lines: [
        { professionalUserId: s.ids.marcio, amountCents: 10000 },
        { professionalUserId: s.ids.ricardo, amountCents: 30000 },
      ],
      reason: 'Márcio cortou; Ricardo costura e monta',
      version: rv.version,
    };
    const res = await Promise.all([
      post(s.admin, F(`/labor-reviews/${rv.id}/resolve`), body),
      post(s.admin, F(`/labor-reviews/${rv.id}/resolve`), body),
    ]);
    expect(
      res.filter((r) => r.status === 200),
      JSON.stringify(res.map((r) => r.body)),
    ).toHaveLength(1);
    expect(res.every((r) => [200, 409, 422].includes(r.status))).toBe(true);
    expect((await db().laborReview.findUniqueOrThrow({ where: { id: rv.id } })).status).toBe(
      'RESOLVIDA',
    );
    expect(await db().financialEvent.count({ where: { kind: 'REVISAO_RESOLVIDA' } })).toBe(1);
    expect(await db().auditLog.count({ where: { action: 'finance.labor_review_resolved' } })).toBe(
      1,
    );
    expect(await db().financialAdjustment.count({ where: { productionPayableId: mar.id } })).toBe(
      1,
    );
    expect(
      await db().productionPayable.count({
        where: { serviceOrderItemId: s.poltronas.id, status: { not: 'CANCELADO' } },
      }),
    ).toBe(2);
  });
});

// ───────────────────── (n) ação do tablet (sessão DEVICE) ─────────────────────

describe('(n) ação do tablet com a mesma chave: simultânea e com resposta perdida', () => {
  it('concluir tarefa: dois envios simultâneos com a mesma chave + retry → uma conclusão, resposta coerente', async () => {
    const s = await scenario(app);
    const R = s.tablets.Ricardo!;
    expect((await act(R, s.sofaTask.id, 'start')).status).toBe(200);
    const key = idemKey();
    const both = await Promise.all([
      act(R, s.sofaTask.id, 'complete', { note: 'ok' }, key),
      act(R, s.sofaTask.id, 'complete', { note: 'ok' }, key),
    ]);
    for (const r of both) expect([200, 409], JSON.stringify(r.body)).toContain(r.status);
    const done = both.find((r) => r.status === 200)!;
    expect(done).toBeTruthy();
    const retry = await act(R, s.sofaTask.id, 'complete', { note: 'ok' }, key);
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(done.body);
    expect(
      await db().productionTaskEvent.count({ where: { taskId: s.sofaTask.id, kind: 'CONCLUIDA' } }),
    ).toBe(1);
    const task = await db().productionTask.findUniqueOrThrow({ where: { id: s.sofaTask.id } });
    expect(task.status).toBe('CONCLUIDA');
    // A chave pertence à sessão do usuário do tablet (escopo por usuário).
    const keyRow = await db().idempotencyKey.findFirstOrThrow({ where: { key } });
    expect(keyRow.userId).toBe(s.ids.ricardo);
    expect(keyRow.responseStatus).toBe(200);
  });
});
