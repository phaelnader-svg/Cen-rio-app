import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { ActorContext } from '../src/core/types';
import {
  notify,
  resolvePickupAssignment,
  resolveNotifications,
} from '../src/modules/notifications/notify';
import { createCustomer, createOrder } from './commercial-helpers';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, resetDatabase } from './helpers';
import { prepareCompany } from './labor-helpers';
import { act, day, tabletOf } from './production-helpers';
import { arrive, depart, setClock } from './presence-helpers';
import { PINS, qualityKit } from './quality-helpers';

/**
 * Remediação pós-auditoria, Rodada 3 — F10-19 (os três tipos que faltavam): atribuição de
 * retirada, "encerrou sem informar o andamento" e revisão por devolução. Cada aviso nasce ativo,
 * LIDO continua ativo, a ação canônica que encerra a condição o marca RESOLVIDO (sai da lista
 * ativa, fica no histórico), repetir a resolução não muda nada e a condição que volta reativa.
 */
let app: App;
const k = qualityKit(() => app);

beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
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

const pickupNotices = (userId: string, pickupId: string) =>
  db().notification.findMany({
    where: {
      userId,
      kind: 'ENTREGA_ATRIBUIDA',
      dedupeKey: { startsWith: `RETIRADA_ATRIBUIDA:${pickupId}:` },
    },
  });
const list = async (c: Client, status: 'ativas' | 'resolvidas' | 'todas') =>
  (await c.get(`/api/v1/notifications?status=${status}`)).body.items as {
    id: string;
    kind: string;
    readAt: string | null;
  }[];
const systemActor = (): ActorContext => ({
  userId: null,
  sessionId: null,
  ip: '127.0.0.1',
  requestId: null,
});

async function pickupFor(admin: Client, logisticsUserId: string) {
  const c = await createCustomer(admin, { name: 'Cliente R3 Retirada', allowSimilar: true });
  const order = await createOrder(admin, c);
  const r = await admin.post(
    '/api/v1/pickups',
    {
      orderId: order.id,
      scheduledDate: day(1),
      windowStart: '09:00',
      windowEnd: '12:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      logisticsUserId,
      items: order.items.map((i: { id: string; quantity: number }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
      })),
    },
    { 'idempotency-key': idemKey() },
  );
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; version: number };
}
const version = async (id: string) =>
  (await db().pickupRequest.findUniqueOrThrow({ where: { id } })).version;
const transition = async (admin: Client, id: string, toStatus: string) =>
  admin.post(
    `/api/v1/pickups/${id}/transition`,
    {
      toStatus,
      version: await version(id),
      ...(toStatus === 'CANCELADA' ? { note: 'Cliente desistiu' } : {}),
    },
    { 'idempotency-key': idemKey() },
  );

describe('F10-19 — atribuição de retirada', () => {
  it('nasce ativa; lida continua ativa; troca de responsável resolve só a do anterior; retirada feita resolve; idempotente; histórico', async () => {
    const s = await k.scenario();
    const pk = await pickupFor(s.admin, s.ids.andre);
    const [born] = await pickupNotices(s.ids.andre, pk.id);
    expect(born).toMatchObject({ resolvedAt: null, readAt: null });
    // Lida ≠ resolvida.
    const andre = await tabletOf(app, s.admin, 'André', PINS['André']!);
    expect((await andre.post(`/api/v1/notifications/${born!.id}/read`, {})).status).toBe(200);
    const read = await db().notification.findUniqueOrThrow({ where: { id: born!.id } });
    expect(read.readAt).not.toBeNull();
    expect(read.resolvedAt).toBeNull();
    expect((await list(andre, 'ativas')).map((n) => n.id)).toContain(born!.id);

    // Passa ao João: o aviso do André deixa de pedir ação; o do João nasce ativo.
    const moved = await s.admin.put(
      `/api/v1/pickups/${pk.id}/logistics`,
      { logisticsUserId: s.ids.joao, version: await version(pk.id) },
      { 'idempotency-key': idemKey() },
    );
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await pickupNotices(s.ids.andre, pk.id)).every((n) => n.resolvedAt !== null)).toBe(
      true,
    );
    const joaoActive = (await pickupNotices(s.ids.joao, pk.id)).filter((n) => !n.resolvedAt);
    expect(joaoActive).toHaveLength(1);
    // Histórico: o aviso resolvido continua consultável (não é apagado).
    expect((await list(andre, 'ativas')).map((n) => n.id)).not.toContain(born!.id);
    expect((await list(andre, 'resolvidas')).map((n) => n.id)).toContain(born!.id);

    // A retirada acontece: o aviso do João é resolvido pela própria transição.
    expect((await transition(s.admin, pk.id, 'EM_EXECUCAO')).status).toBe(200);
    expect((await pickupNotices(s.ids.joao, pk.id)).every((n) => !n.resolvedAt)).toBe(true);
    expect((await transition(s.admin, pk.id, 'RETIRADA_REALIZADA')).status).toBe(200);
    const done = await pickupNotices(s.ids.joao, pk.id);
    expect(done.every((n) => n.resolvedAt !== null)).toBe(true);
    const at = done[0]!.resolvedAt!.getTime();
    // Idempotente: resolver de novo não altera nada nem publica evento.
    const events = await db().domainEvent.count({ where: { type: 'notification.resolved' } });
    await db().$transaction((tx) => resolvePickupAssignment(tx, systemActor(), pk.id));
    expect((await pickupNotices(s.ids.joao, pk.id))[0]!.resolvedAt!.getTime()).toBe(at);
    expect(await db().domainEvent.count({ where: { type: 'notification.resolved' } })).toBe(events);
  });

  it('cancelada resolve; atribuir de novo (fato novo) nasce ativo outra vez; resolução concorrente conta uma vez', async () => {
    const s = await k.scenario();
    const pk = await pickupFor(s.admin, s.ids.andre);
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        db().$transaction((tx) => resolvePickupAssignment(tx, systemActor(), pk.id)),
      ),
    );
    // Três resoluções simultâneas do mesmo assunto: exatamente uma linha muda.
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect((await pickupNotices(s.ids.andre, pk.id)).every((n) => n.resolvedAt !== null)).toBe(
      true,
    );
    // A condição volta (nova atribuição ao André): aviso ativo outra vez.
    await s.admin.put(
      `/api/v1/pickups/${pk.id}/logistics`,
      { logisticsUserId: null, version: await version(pk.id) },
      { 'idempotency-key': idemKey() },
    );
    const back = await s.admin.put(
      `/api/v1/pickups/${pk.id}/logistics`,
      { logisticsUserId: s.ids.andre, version: await version(pk.id) },
      { 'idempotency-key': idemKey() },
    );
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect((await pickupNotices(s.ids.andre, pk.id)).filter((n) => !n.resolvedAt)).toHaveLength(1);
    // Cancelada: deixa de pedir ação.
    const c = await transition(s.admin, pk.id, 'CANCELADA');
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect((await pickupNotices(s.ids.andre, pk.id)).every((n) => n.resolvedAt !== null)).toBe(
      true,
    );
  });
});

describe('F10-19 — encerrou o expediente sem informar o andamento', () => {
  async function pendingDay() {
    const s = await k.scenario();
    setClock('08:10');
    const ricardo = s.tablets.Ricardo!;
    expect((await arrive(ricardo)).status).toBe(200);
    expect((await act(ricardo, s.sofaTask.id, 'start')).status).toBe(200);
    setClock('16:00');
    expect((await depart(ricardo)).status).toBe(200);
    const notices = () =>
      db().notification.findMany({
        where: { userId: s.ids.gestor, kind: 'TAREFA_PENDENTE_ENCERRAMENTO' },
      });
    const impacts = await db().attendanceImpact.findMany({
      where: { kind: 'ANDAMENTO_PENDENTE' },
    });
    expect(impacts).toHaveLength(1);
    return { s, notices, impact: impacts[0]! };
  }
  const resolveImpact = (admin: Client, id: string) =>
    admin.post(`/api/v1/attendance/impacts/${id}/resolve`, {
      resolution: 'Conversado; andamento registrado',
    });

  it('nasce ativo; lido continua ativo; encaminhar o alerta do dia resolve; histórico preservado', async () => {
    const { s, notices, impact } = await pendingDay();
    const [n] = await notices();
    expect(n).toMatchObject({
      resolvedAt: null,
      dedupeKey: `PENDENTE:${impact.attendanceId}:${s.ids.gestor}`,
    });
    expect((await s.admin.post(`/api/v1/notifications/${n!.id}/read`, {})).status).toBe(200);
    expect((await notices())[0]!.resolvedAt).toBeNull();
    expect((await list(s.admin, 'ativas')).map((x) => x.id)).toContain(n!.id);
    const r = await resolveImpact(s.admin, impact.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await notices())[0]!.resolvedAt).not.toBeNull();
    expect((await list(s.admin, 'ativas')).map((x) => x.id)).not.toContain(n!.id);
    expect((await list(s.admin, 'resolvidas')).map((x) => x.id)).toContain(n!.id);
    // Repetir o encaminhamento é recusado (o alerta já foi encaminhado) e nada muda.
    const again = await resolveImpact(s.admin, impact.id);
    expect(again.status).toBe(422);
    expect(
      await db().notification.count({
        where: { userId: s.ids.gestor, kind: 'TAREFA_PENDENTE_ENCERRAMENTO' },
      }),
    ).toBe(1);
  });

  it('dois alertas do mesmo dia encaminhados AO MESMO TEMPO: o aviso do dia é resolvido (sem corrida)', async () => {
    const { s, notices, impact } = await pendingDay();
    // Segundo alerta do mesmo expediente (outra tarefa pausada sem andamento).
    const second = await db().attendanceImpact.create({
      data: {
        attendanceId: impact.attendanceId,
        taskId: s.poltronaTask.id,
        kind: 'ANDAMENTO_PENDENTE',
        affectedUserId: impact.affectedUserId,
        detail: 'Outra tarefa pausada sem andamento informado.',
      },
    });
    // Só um encaminhado: o dia ainda tem pendência → aviso continua ativo.
    const [a, b] = await Promise.all([
      resolveImpact(s.admin, impact.id),
      resolveImpact(s.admin, second.id),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const [n] = await notices();
    expect(n!.resolvedAt).not.toBeNull();
  });

  it('a condição volta (o mesmo fato de novo): o aviso resolvido volta a ficar ativo e não lido', async () => {
    const { s, notices, impact } = await pendingDay();
    expect((await resolveImpact(s.admin, impact.id)).status).toBe(200);
    expect((await notices())[0]!.resolvedAt).not.toBeNull();
    await db().$transaction((tx) =>
      notify(tx, systemActor(), [
        {
          userId: s.ids.gestor,
          kind: 'TAREFA_PENDENTE_ENCERRAMENTO',
          dedupeKey: `PENDENTE:${impact.attendanceId}:${s.ids.gestor}`,
          body: 'Encerrou de novo sem informar o andamento.',
        },
      ]),
    );
    const [n] = await notices();
    expect(n).toMatchObject({ resolvedAt: null, readAt: null });
    expect(
      await db().notification.count({
        where: { userId: s.ids.gestor, kind: 'TAREFA_PENDENTE_ENCERRAMENTO' },
      }),
    ).toBe(1);
    // E a resolução só alcança o tipo certo: outro tipo com o mesmo assunto não é tocado.
    expect(
      await db().$transaction((tx) =>
        resolveNotifications(tx, systemActor(), 'AUSENCIA_PRESUMIDA', [
          `PENDENTE:${impact.attendanceId}`,
        ]),
      ),
    ).toBe(0);
  });
});
