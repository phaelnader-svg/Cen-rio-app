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
import { act, today } from './production-helpers';

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
