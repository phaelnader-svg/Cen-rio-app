import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { releaseDueTasks } from '../src/modules/production/common';
import { Client, WsClient, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { createCustomer, createOrder, panelUserWith, receiptBody } from './commercial-helpers';
import { compareQueue, mondayOf } from '@cenario/shared';
import {
  act,
  createPlan,
  day,
  serviceOrderWith,
  tabletOf,
  today,
  userIdOf,
} from './production-helpers';

/**
 * Simplificação Fase 4 — pré-planejamento: fila "A planejar", planejamento individual e em
 * lote, data de início, publicação semanal e reprogramação, sobre o mecanismo existente
 * (plano semanal único por semana + distribuição automática da Evolução Fase 3).
 * Equipe do seed: Ricardo e Márcio (tapeceiros), João (preparação), Thiago.
 */
let app: App;
const sockets: WsClient[] = [];
beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  setClock();
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
});
afterEach(async () => {
  setClock();
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

const post = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.post(url, body, { 'idempotency-key': key });
const put = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.req('PUT', url, body, { 'idempotency-key': key });

type Piece = { id: string; code: string; upholsterer: { userId: string } | null };
type Entry = {
  serviceOrder: { id: string; code: string };
  stage: string;
  pieces: Piece[];
  materials: { state: string; label: string };
  plan: { planId: string; itemId: string; startDate: string | null; version: number } | null;
  tasks: { total: number; draft: number };
  blockers: string[];
  pendencies: string[];
};
const pipeline = async (c: Client) =>
  (await c.get('/api/v1/production/pipeline')).body as {
    counts: Record<string, number>;
    items: Entry[];
  };
const entryOf = async (c: Client, soId: string) =>
  (await pipeline(c)).items.find((i) => i.serviceOrder.id === soId);

async function team() {
  return {
    ricardo: await userIdOf('Ricardo'),
    marcio: await userIdOf('Márcio'),
    joao: await userIdOf('João'),
  };
}

/** OS com peças recebidas (recebimento + OS, como na chegada à oficina). */
async function os(
  admin: Client,
  name: string,
  pieces: { pieceType: string; description: string }[],
) {
  const customer = await createCustomer(admin, { name, phone: null, allowSimilar: true });
  const order = await createOrder(
    admin,
    customer,
    pieces.map((p) => ({ pieceType: p.pieceType, description: p.description, quantity: 1 })),
  );
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
    items: order.items.map((i: { id: string }, k: number) => ({
      orderItemId: i.id,
      quantity: 1,
      description: pieces[k]!.description,
      serviceType: 'REFORMA_COMPLETA',
    })),
  });
  expect(so.status, JSON.stringify(so.body)).toBe(201);
  return so.body as { id: string; code: string; items: { id: string; position: number }[] };
}
const sofa = (admin: Client, name: string) =>
  os(admin, name, [{ pieceType: 'SOFA', description: 'Sofá' }]);

const planServices = (admin: Client, entries: unknown[], key = idemKey()) =>
  post(admin, '/api/v1/production/plan-services', { entries }, key);
const tasksOf = (soId: string) =>
  db().productionTask.findMany({
    where: { serviceOrderId: soId, status: { not: 'CANCELADA' } },
    include: { dependsOn: true },
    orderBy: { sequence: 'asc' },
  });
const planDto = async (admin: Client, id: string) =>
  (await admin.get(`/api/v1/production-plans/${id}`)).body as {
    id: string;
    version: number;
    status: string;
    revision: number;
  };
const publishWeek = async (admin: Client, planId: string, notes?: string) => {
  const p = await planDto(admin, planId);
  return post(admin, `/api/v1/production-plans/${planId}/publish`, { version: p.version, notes });
};
const queue = async (c: Client) =>
  (await c.get('/api/v1/production-tasks/mine/queue')).body as {
    items: { executable: boolean; task: { id: string; status: string; activity: string } }[];
  };
const money = async () => ({
  payables: await db().productionPayable.count(),
  payableSum: (await db().productionPayable.aggregate({ _sum: { agreedCents: true } }))._sum
    .agreedCents,
  accounts: await db().accountPayable.count(),
  receivables: await db().customerReceivable.count(),
});

describe('A. Fila "A planejar"', () => {
  it('OS recebida e não planejada aparece; não recebida e cancelada não (CA4-01..03)', async () => {
    const admin = await loginAdmin(app);
    const a = await sofa(admin, 'Cliente A Planejar');
    const e = await entryOf(admin, a.id);
    expect(e).toMatchObject({ stage: 'A_PLANEJAR', plan: null, blockers: [] });
    expect(e!.pieces[0]).toMatchObject({ needsUpholsterer: true, upholsterer: null });
    expect(e!.materials.label).toBeTruthy();
    // Legado: OS cujas peças não chegaram (recebimento zerado) não é planejável.
    const b = await sofa(admin, 'Cliente Sem Peça');
    const item = await db().serviceOrderItem.findFirstOrThrow({ where: { serviceOrderId: b.id } });
    await db().commercialOrderItem.update({
      where: { id: item.orderItemId },
      data: { receivedQuantity: 0 },
    });
    const c = await sofa(admin, 'Cliente Cancelada');
    await db().serviceOrder.update({
      where: { id: c.id },
      data: { status: 'CANCELADA', cancelledAt: new Date() },
    });
    const ids = (await pipeline(admin)).items.map((i) => i.serviceOrder.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
    expect(ids).not.toContain(c.id);
    // Planejar OS não recebida é recusado também pela API.
    const p = await team();
    const r = await planServices(admin, [
      {
        serviceOrderId: b.id,
        startDate: today(),
        pieces: [{ serviceOrderItemId: item.id, upholstererUserId: p.ricardo }],
      },
    ]);
    expect(r.status).toBe(422);
    // OS com a produção concluída: aparece em "Concluídos", nunca como pendência de planejamento.
    const d = await sofa(admin, 'Cliente Concluída');
    const planned = await planServices(admin, [
      {
        serviceOrderId: d.id,
        startDate: today(),
        pieces: [{ serviceOrderItemId: d.items[0]!.id, upholstererUserId: p.ricardo }],
      },
    ]);
    expect(planned.status).toBe(201);
    await db().productionTask.updateMany({
      where: { serviceOrderId: d.id },
      data: { status: 'CONCLUIDA', startedAt: new Date(), completedAt: new Date() },
    });
    const done = await entryOf(admin, d.id);
    expect(done!.stage).toBe('CONCLUIDO');
    expect(
      (await pipeline(admin)).items
        .filter((i) => i.stage === 'A_PLANEJAR')
        .map((i) => i.serviceOrder.id),
    ).not.toContain(d.id);
  });
});

describe('B. Planejamento individual e publicação', () => {
  it('só titular e data; rascunho invisível; publicar libera João e Ricardo (CA4-04..06, CA4-11..15)', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const so = await sofa(admin, 'Cliente Sofá Ricardo');
    const before = await money();
    // Sem titular → recusado (o único campo obrigatório além da data).
    const missing = await planServices(admin, [{ serviceOrderId: so.id, startDate: today() }]);
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toMatch(/escolha o tapeceiro/);
    const past = await planServices(admin, [
      {
        serviceOrderId: so.id,
        startDate: day(-1),
        pieces: [{ serviceOrderItemId: so.items[0]!.id, upholstererUserId: p.ricardo }],
      },
    ]);
    expect(past.status).toBe(400);
    const r = await planServices(admin, [
      {
        serviceOrderId: so.id,
        startDate: today(),
        pieces: [{ serviceOrderItemId: so.items[0]!.id, upholstererUserId: p.ricardo }],
      },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const planned = r.body.planned[0];
    expect(planned.tasksCreated).toBeGreaterThan(0);
    // Saiu de "A planejar" pelo vínculo real; aparece como rascunho.
    const e = await entryOf(admin, so.id);
    expect(e).toMatchObject({ stage: 'PLANEJADO_RASCUNHO' });
    expect(e!.plan).toMatchObject({ startDate: today(), planStatus: 'RASCUNHO' });
    expect((await pipeline(admin)).counts.A_PLANEJAR).toBe(0);
    // Distribuição automática: preparação → João; tapeçaria → Ricardo; dependências do modelo.
    const tasks = await tasksOf(so.id);
    expect(tasks.every((t) => t.status === 'RASCUNHO')).toBe(true);
    const prep = tasks.filter((t) => t.stepClass === 'PREPARACAO');
    const tap = tasks.filter((t) => t.stepClass === 'TAPECARIA');
    expect(prep.length).toBeGreaterThan(0);
    expect(tap.length).toBeGreaterThan(0);
    expect(prep.every((t) => t.assigneeUserId === p.joao)).toBe(true);
    expect(tap.every((t) => t.assigneeUserId === p.ricardo)).toBe(true);
    expect(tasks.some((t) => t.dependsOn.length > 0)).toBe(true);
    expect(
      (await db().serviceOrderItem.findUniqueOrThrow({ where: { id: so.items[0]!.id } }))
        .upholstererUserId,
    ).toBe(p.ricardo);
    // Rascunho: nada nos tablets.
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482913');
    const joao = await tabletOf(app, admin, 'João', '730561');
    expect((await queue(ricardo)).items).toHaveLength(0);
    expect((await queue(joao)).items).toHaveLength(0);
    // Nem por chamada direta: lista, detalhe e início recusam o rascunho.
    const mineList = (await joao.get('/api/v1/production-tasks/mine')).body;
    expect(JSON.stringify(mineList)).not.toContain(prep[0]!.id);
    expect((await joao.get(`/api/v1/production-tasks/${prep[0]!.id}`)).status).toBe(404);
    expect((await act(joao, prep[0]!.id, 'start', { version: prep[0]!.version })).status).toBe(422);
    expect(await db().productionTask.count({ where: { startedAt: { not: null } } })).toBe(0);
    // Prévia e publicação em uma ação.
    const prev = (await admin.get(`/api/v1/production-plans/${planned.planId}/publication-preview`))
      .body;
    expect(prev).toMatchObject({
      serviceOrders: 1,
      pieces: 1,
      tasks: tasks.length,
      publishable: true,
      startDates: [{ code: so.code, startDate: today() }],
    });
    expect(prev.byAssignee.map((b: { displayName: string }) => b.displayName).sort()).toEqual([
      'João',
      'Ricardo',
    ]);
    const pub = await publishWeek(admin, planned.planId);
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect((await entryOf(admin, so.id))!.stage).toMatch(/PLANEJADO_PUBLICADO|AGUARDANDO_CONDICAO/);
    const qj = await queue(joao);
    expect(qj.items.length).toBe(prep.length);
    expect(qj.items[0]!.executable).toBe(true); // primeira etapa de preparação liberada
    const qr = await queue(ricardo);
    expect(qr.items.length).toBe(tap.length);
    expect(qr.items.every((i) => !i.executable)).toBe(true); // depende da preparação
    // Nada é iniciado automaticamente nem valor algum muda.
    expect(await db().productionTask.count({ where: { startedAt: { not: null } } })).toBe(0);
    expect(await money()).toEqual(before);
  });

  it('data de início futura: tarefa fica Programada até a data (CA4-09, CA4-10)', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const so = await sofa(admin, 'Cliente Início Futuro');
    const start = day(2);
    const r = await planServices(admin, [
      {
        serviceOrderId: so.id,
        startDate: start,
        pieces: [{ serviceOrderItemId: so.items[0]!.id, upholstererUserId: p.ricardo }],
      },
    ]);
    expect(r.status).toBe(201);
    expect((await publishWeek(admin, r.body.planned[0].planId)).status).toBe(200);
    const joao = await tabletOf(app, admin, 'João', '730561');
    const q1 = await queue(joao);
    expect(q1.items.length).toBeGreaterThan(0);
    expect(q1.items.some((i) => i.executable)).toBe(false);
    expect(q1.items[0]!.task.status).toBe('PROGRAMADA');
    // Tentar iniciar antes da data: recusado.
    const first = q1.items[0]!.task;
    const v = (await db().productionTask.findUniqueOrThrow({ where: { id: first.id } })).version;
    const early = await act(joao, first.id, 'start', { version: v });
    expect(early.status).toBe(422);
    expect(early.body.error.message).toMatch(/data de início/);
    expect(
      (await db().productionTask.findUniqueOrThrow({ where: { id: first.id } })).startedAt,
    ).toBeNull();
    expect((await entryOf(admin, so.id))!.blockers.join(' ')).toMatch(
      /Aguardando a data de início/,
    );
    // Chega o dia: a liberação periódica libera a primeira etapa.
    setClock(() => new Date(`${start}T12:00:00Z`));
    await releaseDueTasks(app.ctx.prisma);
    const q2 = await queue(joao);
    expect(q2.items[0]!.executable).toBe(true);
    expect(q2.items[0]!.task.status).toBe('LIBERADA');
  });

  it('OS com dois sofás: Ricardo e Márcio, titular por peça (CA4-07, CA4-14)', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const so = await os(admin, 'Cliente Dois Sofás', [
      { pieceType: 'SOFA', description: 'Sofá A' },
      { pieceType: 'SOFA', description: 'Sofá B' },
    ]);
    const [a, b] = [...so.items].sort((x, y) => x.position - y.position);
    const r = await planServices(admin, [
      {
        serviceOrderId: so.id,
        startDate: today(),
        pieces: [
          { serviceOrderItemId: a!.id, upholstererUserId: p.ricardo },
          { serviceOrderItemId: b!.id, upholstererUserId: p.marcio },
        ],
      },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const tasks = await tasksOf(so.id);
    const tapOf = (id: string) =>
      tasks.filter((t) => t.serviceOrderItemId === id && t.stepClass === 'TAPECARIA');
    expect(tapOf(a!.id).every((t) => t.assigneeUserId === p.ricardo)).toBe(true);
    expect(tapOf(b!.id).every((t) => t.assigneeUserId === p.marcio)).toBe(true);
    expect(tapOf(a!.id).length).toBeGreaterThan(0);
    // Reprocessar não duplica nem troca titular (CA4-17).
    const item = (await entryOf(admin, so.id))!.plan!;
    const count = tasks.length;
    const rp = await post(
      admin,
      `/api/v1/production-plans/${item.planId}/items/${item.itemId}/distribute`,
      {},
    );
    expect(rp.status, JSON.stringify(rp.body)).toBe(200);
    expect((await tasksOf(so.id)).length).toBe(count);
    expect(await db().taskDependency.count({ where: { task: { serviceOrderId: so.id } } })).toBe(
      tasks.reduce((s, t) => s + t.dependsOn.length, 0),
    );
    expect(
      (await db().serviceOrderItem.findUniqueOrThrow({ where: { id: b!.id } })).upholstererUserId,
    ).toBe(p.marcio);
    // Titular já definido não é substituído pelo pré-planejamento (sem confirmação).
    const so2 = await sofa(admin, 'Cliente Titular Existente');
    await db().serviceOrderItem.update({
      where: { id: so2.items[0]!.id },
      data: { upholstererUserId: p.marcio },
    });
    const swap = await planServices(admin, [
      {
        serviceOrderId: so2.id,
        startDate: today(),
        pieces: [{ serviceOrderItemId: so2.items[0]!.id, upholstererUserId: p.ricardo }],
      },
    ]);
    expect(swap.status).toBe(422);
    expect(swap.body.error.message).toMatch(/já tem titular/);
    // Sem escolher (titular já definido): aceito, mantém Márcio.
    const keep = await planServices(admin, [{ serviceOrderId: so2.id, startDate: today() }]);
    expect(keep.status, JSON.stringify(keep.body)).toBe(201);
    expect(
      (await tasksOf(so2.id))
        .filter((t) => t.stepClass === 'TAPECARIA')
        .every((t) => t.assigneeUserId === p.marcio),
    ).toBe(true);
  });
});

describe('C. Lote, idempotência e concorrência', () => {
  it('lote em duas semanas numa operação; erro em uma OS desfaz tudo (CA4-08)', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const [s1, s2, s3] = [
      await sofa(admin, 'Cliente Lote 1'),
      await sofa(admin, 'Cliente Lote 2'),
      await sofa(admin, 'Cliente Lote 3'),
    ];
    const piece = (s: typeof s1, who: string) => [
      { serviceOrderItemId: s.items[0]!.id, upholstererUserId: who },
    ];
    // Uma OS sem titular: nada é gravado (nem as outras).
    const bad = await planServices(admin, [
      { serviceOrderId: s1.id, startDate: today(), pieces: piece(s1, p.ricardo) },
      { serviceOrderId: s2.id, startDate: today() },
    ]);
    expect(bad.status).toBe(400);
    expect(await db().productionPlanItem.count()).toBe(0);
    expect(await db().productionTask.count()).toBe(0);
    const ok = await planServices(admin, [
      { serviceOrderId: s1.id, startDate: today(), pieces: piece(s1, p.ricardo) },
      { serviceOrderId: s2.id, startDate: today(), pieces: piece(s2, p.marcio) },
      { serviceOrderId: s3.id, startDate: day(8), pieces: piece(s3, p.ricardo) },
    ]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.planned).toHaveLength(3);
    const weeks = new Set(ok.body.planned.map((x: { weekStart: string }) => x.weekStart));
    expect(weeks.size).toBe(2);
    expect(await db().productionPlan.count({ where: { mode: 'FILA_SEMANAL' } })).toBe(2);
    expect((await pipeline(admin)).counts.PLANEJADO_RASCUNHO).toBe(3);
  });

  it('duplo clique, repetição após falha de rede e dois gestores simultâneos (CA4-18, CA4-19)', async () => {
    const admin = await loginAdmin(app);
    const other = await loginAdmin(app);
    const p = await team();
    const so = await sofa(admin, 'Cliente Concorrência');
    const body = [
      {
        serviceOrderId: so.id,
        startDate: today(),
        pieces: [{ serviceOrderItemId: so.items[0]!.id, upholstererUserId: p.ricardo }],
      },
    ];
    // Dois gestores ao mesmo tempo (chaves diferentes): um vence, o outro recebe 409.
    const [x, y] = await Promise.all([planServices(admin, body), planServices(other, body)]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    const n = (await tasksOf(so.id)).length;
    expect(await db().productionPlanItem.count({ where: { serviceOrderId: so.id } })).toBe(1);
    // Repetição com a mesma chave (resposta perdida): mesmo resultado, nada novo.
    const winner = x.status === 201 ? { c: admin, r: x } : { c: other, r: y };
    const key = idemKey();
    const so2 = await sofa(admin, 'Cliente Duplo Clique');
    const body2 = [
      {
        serviceOrderId: so2.id,
        startDate: today(),
        pieces: [{ serviceOrderItemId: so2.items[0]!.id, upholstererUserId: p.marcio }],
      },
    ];
    const first = await planServices(winner.c, body2, key);
    const again = await planServices(winner.c, body2, key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    // Duplo clique (outra chave): 409, sem duplicar.
    const dbl = await planServices(winner.c, body2);
    expect(dbl.status).toBe(409);
    expect((await tasksOf(so.id)).length).toBe(n);
    expect(await db().productionPlanItem.count({ where: { serviceOrderId: so2.id } })).toBe(1);
    // Publicação simultânea com a mesma versão: uma vale, a outra recebe conflito.
    const planId = first.body.planned[0].planId;
    const v = (await planDto(admin, planId)).version;
    const pubs = await Promise.all([
      post(admin, `/api/v1/production-plans/${planId}/publish`, { version: v }),
      post(other, `/api/v1/production-plans/${planId}/publish`, { version: v }),
    ]);
    expect(pubs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db().productionPlanRevision.count({ where: { planId } })).toBe(1);
  });
});

describe('D. Semana publicada, reprogramação e histórico', () => {
  it('rascunho numa semana publicada não aparece até "Publicar semana" (nova revisão) (CA4-05, CA4-11, CA4-12)', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const s1 = await sofa(admin, 'Cliente Semana 1');
    const r1 = await planServices(admin, [
      {
        serviceOrderId: s1.id,
        startDate: today(),
        pieces: [{ serviceOrderItemId: s1.items[0]!.id, upholstererUserId: p.ricardo }],
      },
    ]);
    const planId = r1.body.planned[0].planId;
    expect((await publishWeek(admin, planId)).status).toBe(200);
    const joao = await tabletOf(app, admin, 'João', '730561');
    const before = (await queue(joao)).items.length;
    // Nova OS na semana já publicada: entra em rascunho, separada.
    const s2 = await sofa(admin, 'Cliente Semana 2');
    const r2 = await planServices(admin, [
      {
        serviceOrderId: s2.id,
        startDate: today(),
        pieces: [{ serviceOrderItemId: s2.items[0]!.id, upholstererUserId: p.marcio }],
      },
    ]);
    expect(r2.body.planned[0].planId).toBe(planId);
    expect((await tasksOf(s2.id)).every((t) => t.status === 'RASCUNHO')).toBe(true);
    expect((await entryOf(admin, s2.id))!.stage).toBe('PLANEJADO_RASCUNHO');
    expect((await entryOf(admin, s1.id))!.stage).not.toBe('PLANEJADO_RASCUNHO');
    expect((await queue(joao)).items.length).toBe(before);
    // Reprocessar a OS em rascunho não a publica.
    const it2 = (await entryOf(admin, s2.id))!.plan!;
    await post(admin, `/api/v1/production-plans/${planId}/items/${it2.itemId}/distribute`, {});
    expect((await tasksOf(s2.id)).every((t) => t.status === 'RASCUNHO')).toBe(true);
    // Tablet conectado recebe a revisão em tempo real ao publicar (CA4-24).
    const ws = await WsClient.connect(app, joao);
    sockets.push(ws);
    const prev = (await admin.get(`/api/v1/production-plans/${planId}/publication-preview`)).body;
    expect(prev).toMatchObject({ planStatus: 'PUBLICADO', serviceOrders: 1, publishable: true });
    const pub = await publishWeek(admin, planId);
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    await ws.waitFor((m) => m.event?.type === 'production.plan_revised');
    expect((await planDto(admin, planId)).revision).toBe(2);
    expect((await queue(joao)).items.length).toBeGreaterThan(before);
  });

  it('reprogramar data/semana com versão; iniciada não troca de semana; concluída não reinicia (CA4-20, CA4-21)', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const so = await sofa(admin, 'Cliente Reprogramar');
    const r = await planServices(admin, [
      {
        serviceOrderId: so.id,
        startDate: today(),
        pieces: [{ serviceOrderItemId: so.items[0]!.id, upholstererUserId: p.ricardo }],
      },
    ]);
    const planId = r.body.planned[0].planId;
    let e = (await entryOf(admin, so.id))!;
    // Rascunho: muda de semana sem motivo; tarefas vão juntas, versão sobe.
    // Data fixa numa quarta-feira futura: sempre há outro dia depois dela na mesma semana
    // (com day(9) o teste ficava sem a verificação final quando caía num domingo).
    const weekAhead = mondayOf(day(14));
    const atDay = (n: number) =>
      new Date(Date.parse(`${weekAhead}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const next = atDay(2);
    const mv = await put(admin, `/api/v1/production/planned/${e.plan!.itemId}`, {
      version: e.plan!.version,
      startDate: next,
    });
    expect(mv.status, JSON.stringify(mv.body)).toBe(200);
    e = (await entryOf(admin, so.id))!;
    expect(e.plan!.startDate).toBe(next);
    expect(e.plan!.planId).not.toBe(planId);
    expect((await tasksOf(so.id)).every((t) => t.planId === e.plan!.planId)).toBe(true);
    // Versão antiga: 409 (outro gestor já alterou).
    const stale = await put(admin, `/api/v1/production/planned/${mv.body.itemId}`, {
      version: 1,
      startDate: today(),
    });
    expect(stale.status).toBe(409);
    // Publica; na semana publicada, mudar a data exige motivo (nova revisão).
    expect((await publishWeek(admin, e.plan!.planId)).status).toBe(200);
    const monday = mondayOf(next);
    const sameWeek = [0, 1, 2, 3, 4, 5, 6]
      .map((k) =>
        new Date(Date.parse(`${monday}T12:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10),
      )
      .find((d) => d !== next && d >= today())!;
    const noReason = await put(admin, `/api/v1/production/planned/${e.plan!.itemId}`, {
      version: e.plan!.version,
      startDate: sameWeek,
    });
    expect(noReason.status).toBe(400);
    const withReason = await put(admin, `/api/v1/production/planned/${e.plan!.itemId}`, {
      version: e.plan!.version,
      startDate: next,
      priority: 'ALTA',
      reason: 'Cliente pediu prioridade',
    });
    expect(withReason.status, JSON.stringify(withReason.body)).toBe(200);
    expect(withReason.body.version).toBe(e.plan!.version + 1);
    // Inicia uma tarefa (relógio no dia de início) → trocar de semana é recusado.
    setClock(() => new Date(`${next}T12:00:00Z`));
    await releaseDueTasks(app.ctx.prisma);
    const joao = await tabletOf(app, admin, 'João', '730561');
    const t = (await queue(joao)).items.find((i) => i.executable)!.task;
    const v = (await db().productionTask.findUniqueOrThrow({ where: { id: t.id } })).version;
    expect((await act(joao, t.id, 'start', { version: v })).status).toBe(200);
    const cur = (await entryOf(admin, so.id))!;
    expect(cur.stage).toBe('EM_PRODUCAO');
    const blocked = await put(admin, `/api/v1/production/planned/${cur.plan!.itemId}`, {
      version: cur.plan!.version,
      startDate: atDay(14),
      reason: 'Cliente pediu',
    });
    expect(blocked.status).toBe(422);
    // Conclui a etapa iniciada e muda a data dentro da semana: a concluída não é reiniciada.
    const v2 = (await db().productionTask.findUniqueOrThrow({ where: { id: t.id } })).version;
    const done = await act(joao, t.id, 'complete', { version: v2 });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const doneRow = await db().productionTask.findUniqueOrThrow({ where: { id: t.id } });
    expect(doneRow.status).toBe('CONCLUIDA');
    const fresh = (await entryOf(admin, so.id))!;
    const sameWeekLater = [1, 2, 3, 4, 5, 6]
      .map((k) =>
        new Date(Date.parse(`${next}T12:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10),
      )
      .find((d) => mondayOf(d) === mondayOf(next));
    expect(sameWeekLater).toBe(atDay(3));
    const moveDate = await put(admin, `/api/v1/production/planned/${fresh.plan!.itemId}`, {
      version: fresh.plan!.version,
      startDate: sameWeekLater,
      reason: 'Ajuste de agenda',
    });
    expect(moveDate.status, JSON.stringify(moveDate.body)).toBe(200);
    expect((await entryOf(admin, so.id))!.plan!.startDate).toBe(sameWeekLater);
    const after = await db().productionTask.findUniqueOrThrow({ where: { id: t.id } });
    expect(after).toMatchObject({
      status: 'CONCLUIDA',
      version: doneRow.version,
      completedAt: doneRow.completedAt,
    });
    // Histórico preservado: transferência registrada nas tarefas.
    expect(
      await db().productionTaskEvent.count({
        where: { task: { serviceOrderId: so.id }, kind: 'TRANSFERIDA_SEMANA' },
      }),
    ).toBeGreaterThan(0);
  });
});

describe('E. Materiais, permissões e compatibilidade', () => {
  it('material faltando: planejar é permitido, mas a tarefa não é liberada (CA4-16)', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const { so } = await serviceOrderWith(admin, 'missing', 'Cliente Material Faltando');
    const items = so.items as { id: string }[];
    const pieces = items.map((i) => ({ serviceOrderItemId: i.id, upholstererUserId: p.ricardo }));
    const e0 = (await entryOf(admin, so.id))!;
    expect(e0.materials.state).not.toBe('COMPLETO');
    const r = await planServices(admin, [{ serviceOrderId: so.id, startDate: today(), pieces }]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const prev = (
      await admin.get(`/api/v1/production-plans/${r.body.planned[0].planId}/publication-preview`)
    ).body;
    expect(prev.materialsBlocked.length).toBe(1);
    expect((await publishWeek(admin, r.body.planned[0].planId)).status).toBe(200);
    const needing = (await tasksOf(so.id)).filter((t) => t.requiresMaterials);
    expect(needing.length).toBeGreaterThan(0);
    expect(needing.every((t) => t.status === 'BLOQUEADA')).toBe(true);
    expect(needing.some((t) => t.blockers.includes('MATERIAIS'))).toBe(true);
  });

  it('permissões na API: tablet e painel sem planejar recebem 403 (CA4-23)', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const so = await sofa(admin, 'Cliente Permissão');
    const body = [
      {
        serviceOrderId: so.id,
        startDate: today(),
        pieces: [{ serviceOrderItemId: so.items[0]!.id, upholstererUserId: p.ricardo }],
      },
    ];
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482913');
    expect((await planServices(ricardo, body)).status).toBe(403);
    const viewer = await panelUserWith(app, admin, 'visualiza', ['producao.ver']);
    expect((await planServices(viewer, body)).status).toBe(403);
    expect((await viewer.get('/api/v1/production/pipeline')).status).toBe(200);
    const r = await planServices(admin, body);
    const planId = r.body.planned[0].planId;
    const v = (await planDto(admin, planId)).version;
    expect(
      (await post(viewer, `/api/v1/production-plans/${planId}/publish`, { version: v })).status,
    ).toBe(403);
    expect(
      (
        await put(
          viewer,
          `/api/v1/production/planned/${(await entryOf(admin, so.id))!.plan!.itemId}`,
          {
            version: 1,
            startDate: today(),
          },
        )
      ).status,
    ).toBe(403);
    // Fila operacional sem valores financeiros.
    expect(JSON.stringify(await pipeline(admin))).not.toMatch(/Cents|valor|price/i);
  });

  it('semana em planejamento antigo (por horário) é preservada e recusa o pré-planejamento (CA4-25)', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const legacy = await createPlan(admin, day(14), 'LEGADO');
    const so = await sofa(admin, 'Cliente Legado');
    const r = await planServices(admin, [
      {
        serviceOrderId: so.id,
        startDate: day(14),
        pieces: [{ serviceOrderItemId: so.items[0]!.id, upholstererUserId: p.ricardo }],
      },
    ]);
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/planejamento antigo por horário/);
    const after = await db().productionPlan.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(after).toMatchObject({ mode: 'LEGADO', status: 'RASCUNHO', version: legacy.version });
    expect(await db().productionPlanItem.count()).toBe(0);
    // A OS continua em "A planejar".
    expect((await entryOf(admin, so.id))!.stage).toBe('A_PLANEJAR');
  });

  it('tempo real: outro gestor recebe a atualização ao planejar (CA4-24)', async () => {
    const admin = await loginAdmin(app);
    const other = await loginAdmin(app);
    const p = await team();
    const so = await sofa(admin, 'Cliente Tempo Real');
    const ws = await WsClient.connect(app, other);
    sockets.push(ws);
    const r = await planServices(admin, [
      {
        serviceOrderId: so.id,
        startDate: today(),
        pieces: [{ serviceOrderItemId: so.items[0]!.id, upholstererUserId: p.ricardo }],
      },
    ]);
    expect(r.status).toBe(201);
    await ws.waitFor((m) => m.event?.type === 'production.plan_updated');
    // Auditoria registra quem planejou, data e titular.
    const log = await db().auditLog.findFirstOrThrow({
      where: { action: 'production.service_planned', entityId: so.id },
    });
    expect(log.summary).toContain(today().split('-').reverse().join('/'));
    expect(JSON.stringify(log.changes)).toContain('Ricardo');
    expect(log.actorUserId).toBeTruthy();
  });
});

describe('F. Estabilização (auditoria): liberação por OS e rascunhos antigos', () => {
  /** Semana futura fixa (segunda-feira daqui a ~2 semanas): independe do dia da execução. */
  const futureWeek = () => mondayOf(day(14));
  const plusDays = (iso: string, n: number) =>
    new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const releaseTicks = () =>
    db().auditLog.findMany({
      where: { action: 'production.release_tick' },
      orderBy: { createdAt: 'asc' },
    });

  it('duas OS na mesma semana, dias diferentes: a OS futura não é reprocessada antes do dia (CA4-10)', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const monday = futureWeek();
    const tuesday = plusDays(monday, 1);
    const thursday = plusDays(monday, 3);
    const early = await sofa(admin, 'Cliente Terça');
    const late = await sofa(admin, 'Cliente Quinta');
    const r = await planServices(admin, [
      {
        serviceOrderId: early.id,
        startDate: tuesday,
        pieces: [{ serviceOrderItemId: early.items[0]!.id, upholstererUserId: p.ricardo }],
      },
      {
        serviceOrderId: late.id,
        startDate: thursday,
        pieces: [{ serviceOrderItemId: late.items[0]!.id, upholstererUserId: p.marcio }],
      },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await publishWeek(admin, r.body.planned[0].planId)).status).toBe(200);
    const snapshot = async (soId: string) =>
      (await tasksOf(soId)).map((t) => ({ id: t.id, status: t.status, version: t.version }));
    const lateBefore = await snapshot(late.id);
    expect(lateBefore.some((t) => t.status === 'PROGRAMADA')).toBe(true);
    const ticksBefore = (await releaseTicks()).length;

    // Terça, meio-dia: só a OS de terça é liberada; a de quinta não é tocada.
    setClock(() => new Date(`${tuesday}T15:00:00Z`));
    await releaseDueTasks(app.ctx.prisma);
    const earlyTasks = await tasksOf(early.id);
    expect(earlyTasks.some((t) => t.status === 'LIBERADA')).toBe(true);
    expect(earlyTasks.some((t) => t.status === 'PROGRAMADA')).toBe(false);
    expect(await snapshot(late.id)).toEqual(lateBefore);
    const ticks = await releaseTicks();
    expect(ticks.length).toBe(ticksBefore + 1);
    // Só a(s) tarefa(s) da OS de terça entram na contagem do registro.
    const releasedEarly = earlyTasks.filter((t) => t.status === 'LIBERADA').length;
    expect(ticks.at(-1)!.summary).toContain(`${releasedEarly} tarefa(s)`);

    // Novos ciclos no mesmo dia: nada muda → nenhum registro de auditoria novo.
    for (let i = 0; i < 3; i++) await releaseDueTasks(app.ctx.prisma);
    expect((await releaseTicks()).length).toBe(ticksBefore + 1);
    expect(await snapshot(late.id)).toEqual(lateBefore);

    // Quarta: a de quinta continua Programada (nunca antes da data).
    setClock(() => new Date(`${plusDays(monday, 2)}T23:00:00Z`));
    await releaseDueTasks(app.ctx.prisma);
    expect(await snapshot(late.id)).toEqual(lateBefore);

    // Quinta: chega a vez dela.
    setClock(() => new Date(`${thursday}T12:00:00Z`));
    await releaseDueTasks(app.ctx.prisma);
    const lateTasks = await tasksOf(late.id);
    expect(lateTasks.some((t) => t.status === 'LIBERADA')).toBe(true);
    expect(lateTasks.some((t) => t.status === 'PROGRAMADA')).toBe(false);
    expect((await releaseTicks()).length).toBe(ticksBefore + 2);
    // Ordem e integridade: nenhuma tarefa nova, nenhuma sequência alterada.
    expect(lateTasks.map((t) => t.id).sort()).toEqual(lateBefore.map((t) => t.id).sort());
  });

  it('liberação concorrente (duas instâncias) é idempotente', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const day1 = plusDays(futureWeek(), 2);
    const so = await sofa(admin, 'Cliente Concorrência Liberação');
    const r = await planServices(admin, [
      {
        serviceOrderId: so.id,
        startDate: day1,
        pieces: [{ serviceOrderItemId: so.items[0]!.id, upholstererUserId: p.ricardo }],
      },
    ]);
    expect((await publishWeek(admin, r.body.planned[0].planId)).status).toBe(200);
    const ticksBefore = (await releaseTicks()).length;
    setClock(() => new Date(`${day1}T12:00:00Z`));
    const counts = await Promise.all([
      releaseDueTasks(app.ctx.prisma),
      releaseDueTasks(app.ctx.prisma),
    ]);
    const released = (await tasksOf(so.id)).filter((t) => t.status === 'LIBERADA');
    expect(released.length).toBeGreaterThan(0);
    // Uma única transição por tarefa (evento LIBERADA) e um único registro com mudança.
    expect(counts.reduce((a, b) => a + b, 0)).toBe(released.length);
    expect(
      await db().productionTaskEvent.count({
        where: { taskId: { in: released.map((t) => t.id) }, kind: 'LIBERADA' },
      }),
    ).toBe(released.length);
    expect((await releaseTicks()).length).toBe(ticksBefore + 1);
  });

  it('todas as rotas do pré-planejamento: tablet, painel só leitura e anônimo recusados sem efeito colateral (CA4-23)', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const so = await sofa(admin, 'Cliente Rotas Protegidas');
    const other = await sofa(admin, 'Cliente Ainda Não Planejado');
    const start = plusDays(futureWeek(), 1);
    const r = await planServices(admin, [
      {
        serviceOrderId: so.id,
        startDate: start,
        pieces: [{ serviceOrderItemId: so.items[0]!.id, upholstererUserId: p.ricardo }],
      },
    ]);
    expect(r.status).toBe(201);
    const planned = (await entryOf(admin, so.id))!.plan!;
    const { planId, itemId, version: itemVersion } = planned;
    const planVersion = (await planDto(admin, planId)).version;
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482913');
    const viewer = await panelUserWith(app, admin, 'somente-leitura', ['producao.ver']);
    const anon = new Client(app);

    const state = async () => ({
      plan: await db().productionPlan.findUniqueOrThrow({
        where: { id: planId },
        select: { version: true, status: true },
      }),
      item: await db().productionPlanItem.findUniqueOrThrow({
        where: { id: itemId },
        select: { version: true, startDate: true, priority: true },
      }),
      tasks: (await db().productionTask.findMany({ orderBy: { id: 'asc' } })).map((t) => [
        t.id,
        t.status,
        t.version,
        t.planId,
      ]),
      planItems: await db().productionPlanItem.count(),
      audits: await db().auditLog.count(),
      events: await db().domainEvent.count(),
    });
    const before = await state();

    const writes = (c: Client) => [
      planServices(c, [
        {
          serviceOrderId: other.id,
          startDate: start,
          pieces: [{ serviceOrderItemId: other.items[0]!.id, upholstererUserId: p.marcio }],
        },
      ]),
      put(c, `/api/v1/production/planned/${itemId}`, {
        version: itemVersion,
        startDate: plusDays(start, 1),
      }),
      post(c, `/api/v1/production-plans/${planId}/publish`, { version: planVersion }),
    ];
    const reads = (c: Client) => [
      c.get('/api/v1/production/pipeline'),
      c.get(`/api/v1/production-plans/${planId}/publication-preview`),
    ];
    // Tablet: nenhuma rota do pré-planejamento (sessão de painel exigida).
    for (const res of await Promise.all([...writes(ricardo), ...reads(ricardo)])) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    }
    // Painel só com "ver": lê, mas não planeja, não reprograma e não publica.
    for (const res of await Promise.all(writes(viewer))) {
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    }
    for (const res of await Promise.all(reads(viewer))) expect(res.status).toBe(200);
    // Sem sessão: 401 em todas.
    for (const res of await Promise.all([...writes(anon), ...reads(anon)])) {
      expect(res.status).toBe(401);
    }
    // Nenhum efeito: plano, item, tarefas, auditoria e eventos idênticos.
    expect(await state()).toEqual(before);
    // O gestor continua podendo (a recusa não "travou" nada).
    expect(
      (
        await put(admin, `/api/v1/production/planned/${itemId}`, {
          version: itemVersion,
          startDate: plusDays(start, 1),
        })
      ).status,
    ).toBe(200);
  });

  it('rascunho esquecido numa semana passada: segue visível, invisível ao tablet e reprogramável', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const so = await sofa(admin, 'Cliente Rascunho Esquecido');
    const start = today();
    const r = await planServices(admin, [
      {
        serviceOrderId: so.id,
        startDate: start,
        pieces: [{ serviceOrderItemId: so.items[0]!.id, upholstererUserId: p.ricardo }],
      },
    ]);
    expect(r.status).toBe(201);
    const oldPlanId = r.body.planned[0].planId as string;
    // Três semanas depois, ninguém publicou.
    const later = plusDays(start, 21);
    setClock(() => new Date(`${later}T12:00:00Z`));
    await releaseDueTasks(app.ctx.prisma);
    const e = (await entryOf(admin, so.id))!;
    expect(e.plan).toMatchObject({ planId: oldPlanId, startDate: start, planStatus: 'RASCUNHO' });
    expect(e.tasks.draft).toBeGreaterThan(0);
    // Nada foi liberado nem transferido sozinho; o tablet não vê o rascunho.
    expect(
      (await tasksOf(so.id)).every((t) => t.status === 'RASCUNHO' && t.planId === oldPlanId),
    ).toBe(true);
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482913');
    expect((await queue(ricardo)).items).toHaveLength(0);
    // A prévia da publicação avisa que a data já passou.
    const preview = await admin.get(`/api/v1/production-plans/${oldPlanId}/publication-preview`);
    expect(preview.status).toBe(200);
    expect(JSON.stringify(preview.body)).toMatch(/já passou/);
    // Caminho explícito: o gestor reprograma para hoje (nova semana, ainda em rascunho).
    const moved = await put(admin, `/api/v1/production/planned/${e.plan!.itemId}`, {
      version: e.plan!.version,
      startDate: later,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const after = (await entryOf(admin, so.id))!;
    expect(after.plan!.startDate).toBe(later);
    expect(after.plan!.planId).not.toBe(oldPlanId);
    expect((await tasksOf(so.id)).every((t) => t.planId === after.plan!.planId)).toBe(true);
  });
});

describe('G. Rascunhos de semanas passadas — aviso na Central de atenção (decisão: tratamento manual)', () => {
  type Item = { key: string; type: string; category: string; title: string; link: string };
  const plusDays = (iso: string, n: number) =>
    new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const drafts = async (c: Client) => {
    const r = await c.get('/api/v1/attention');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (r.body.items as Item[]).filter((i) => i.type === 'RASCUNHO_ANTIGO');
  };
  const snapshot = async () =>
    (
      await db().productionTask.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, status: true, version: true, planId: true, assigneeUserId: true },
      })
    ).map((t) => JSON.stringify(t));
  const items = async () =>
    (
      await db().productionPlanItem.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, planId: true, startDate: true, version: true },
      })
    ).map((i) => JSON.stringify(i));

  it('sem rascunho antigo: nenhum aviso (nem para rascunho da semana atual)', async () => {
    const admin = await loginAdmin(app);
    expect(await drafts(admin)).toEqual([]);
    const p = await team();
    const so = await sofa(admin, 'Cliente Rascunho Atual');
    const r = await planServices(admin, [
      {
        serviceOrderId: so.id,
        startDate: today(),
        pieces: [{ serviceOrderItemId: so.items[0]!.id, upholstererUserId: p.ricardo }],
      },
    ]);
    expect(r.status).toBe(201);
    expect(await drafts(admin)).toEqual([]);
  });

  it('rascunho antigo: um aviso por semana; consultas e ciclos repetidos não duplicam nem alteram nada', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const start = today();
    const a = await sofa(admin, 'Cliente Antigo A');
    const b = await sofa(admin, 'Cliente Antigo B');
    const r = await planServices(admin, [
      {
        serviceOrderId: a.id,
        startDate: start,
        pieces: [{ serviceOrderItemId: a.items[0]!.id, upholstererUserId: p.ricardo }],
      },
      {
        serviceOrderId: b.id,
        startDate: start,
        pieces: [{ serviceOrderItemId: b.items[0]!.id, upholstererUserId: p.marcio }],
      },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const planId = r.body.planned[0].planId as string;
    // Duas semanas depois, ninguém publicou; um rascunho da semana atual também existe.
    const later = plusDays(start, 14);
    setClock(() => new Date(`${later}T12:00:00Z`));
    const current = await sofa(admin, 'Cliente Semana Atual');
    expect(
      (
        await planServices(admin, [
          {
            serviceOrderId: current.id,
            startDate: later,
            pieces: [{ serviceOrderItemId: current.items[0]!.id, upholstererUserId: p.ricardo }],
          },
        ])
      ).status,
    ).toBe(201);
    const tasksBefore = await snapshot();
    const itemsBefore = await items();
    const audits = await db().auditLog.count();
    const events = await db().domainEvent.count();
    const first = await drafts(admin);
    expect(first).toEqual([
      expect.objectContaining({
        key: `RASCUNHO_ANTIGO:${planId}`,
        category: 'ACAO',
        title: `Semana de ${mondayOf(start).split('-').reverse().join('/')}: 2 serviço(s) ainda em rascunho`,
        link: '/painel/producao/a-planejar',
      }),
    ]);
    // Repetição: consultas e ciclos de liberação seguidos → o mesmo aviso, uma vez só.
    for (let i = 0; i < 3; i++) {
      await releaseDueTasks(app.ctx.prisma);
      expect(await drafts(admin)).toEqual(first);
    }
    // Nada mudou: rascunhos, itens, auditoria e eventos intactos.
    expect(await snapshot()).toEqual(tasksBefore);
    expect(await items()).toEqual(itemsBefore);
    expect(await db().auditLog.count()).toBe(audits);
    expect(await db().domainEvent.count()).toBe(events);
  });

  it('o aviso não bloqueia: o gestor reprograma e o aviso some; quem não vê produção não recebe', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const start = today();
    const so = await sofa(admin, 'Cliente Reprograma');
    const r = await planServices(admin, [
      {
        serviceOrderId: so.id,
        startDate: start,
        pieces: [{ serviceOrderItemId: so.items[0]!.id, upholstererUserId: p.ricardo }],
      },
    ]);
    expect(r.status).toBe(201);
    const later = plusDays(start, 21);
    setClock(() => new Date(`${later}T12:00:00Z`));
    expect(await drafts(admin)).toHaveLength(1);
    const e = (await entryOf(admin, so.id))!;
    const moved = await put(admin, `/api/v1/production/planned/${e.plan!.itemId}`, {
      version: e.plan!.version,
      startDate: later,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(await drafts(admin)).toEqual([]);
    // Tablet não acessa a Central de atenção.
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482913');
    expect((await ricardo.get('/api/v1/attention')).status).toBe(403);
  });
});

describe('H. D9 (decisão C) — a data de início define a posição inicial na fila', () => {
  const plusDays = (iso: string, n: number) =>
    new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  // Semana seguinte (sempre futura): segunda = base.
  const base = () => mondayOf(plusDays(today(), 7));
  /** Fila de uma pessoa num plano: OS na ordem final (compareQueue) + posições gravadas. */
  async function orderOf(userId: string, planId: string) {
    const rows = await db().productionTask.findMany({
      where: {
        planId,
        assigneeUserId: userId,
        supportForTaskId: null,
        status: { notIn: ['CONCLUIDA', 'CANCELADA'] },
      },
      select: {
        id: true,
        serviceOrderId: true,
        priority: true,
        queuePosition: true,
        sequence: true,
        number: true,
      },
    });
    const sorted = [...rows].sort((a, b) =>
      compareQueue({ ...a, weekStart: null }, { ...b, weekStart: null }),
    );
    return {
      services: [...new Set(sorted.map((t) => t.serviceOrderId))],
      taskIds: sorted.map((t) => t.id),
      positions: sorted.map((t) => t.queuePosition),
    };
  }
  async function plan(
    admin: Client,
    so: { id: string; items: { id: string }[] },
    startDate: string,
    owner: string,
    priority?: string,
  ) {
    const r = await planServices(admin, [
      {
        serviceOrderId: so.id,
        startDate,
        ...(priority ? { priority } : {}),
        pieces: [{ serviceOrderItemId: so.items[0]!.id, upholstererUserId: owner }],
      },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.planned[0].planId as string;
  }
  const contiguous = (positions: (number | null)[]) =>
    expect(positions).toEqual(positions.map((_, i) => i + 1));

  it('planejamento: ordem pela data, não pela ordem de inclusão; datas iguais = quem veio antes', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const wed = await sofa(admin, 'Cliente Quarta');
    const mon = await sofa(admin, 'Cliente Segunda');
    const fri = await sofa(admin, 'Cliente Sexta');
    const tue1 = await sofa(admin, 'Cliente Terça 1');
    const tue2 = await sofa(admin, 'Cliente Terça 2');
    const planId = await plan(admin, wed, plusDays(base(), 2), p.ricardo);
    await plan(admin, mon, base(), p.ricardo);
    await plan(admin, fri, plusDays(base(), 4), p.ricardo);
    await plan(admin, tue1, plusDays(base(), 1), p.ricardo);
    await plan(admin, tue2, plusDays(base(), 1), p.ricardo);
    const o = await orderOf(p.ricardo, planId);
    expect(o.services).toEqual([mon.id, tue1.id, tue2.id, wed.id, fri.id]);
    contiguous(o.positions);
    // As etapas de uma OS ficam juntas e na ordem (dependência respeitada).
    const seqs = (await tasksOf(mon.id)).filter((t) => t.assigneeUserId === p.ricardo);
    expect(o.taskIds.slice(0, seqs.length)).toEqual(seqs.map((t) => t.id));
  });

  it('prioridade: urgente com data posterior fica à frente; dentro da faixa, vale a data', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const a = await sofa(admin, 'Cliente Normal Segunda');
    const b = await sofa(admin, 'Cliente Urgente Sexta');
    const c = await sofa(admin, 'Cliente Urgente Terça');
    const planId = await plan(admin, a, base(), p.ricardo);
    await plan(admin, b, plusDays(base(), 4), p.ricardo, 'URGENTE');
    await plan(admin, c, plusDays(base(), 1), p.ricardo, 'URGENTE');
    const o = await orderOf(p.ricardo, planId);
    expect(o.services).toEqual([c.id, b.id, a.id]);
    contiguous(o.positions);
  });

  it('posição manual: preservada ao planejar outro serviço; o novo entra pela data', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const a = await sofa(admin, 'Cliente A Segunda');
    const b = await sofa(admin, 'Cliente B Quarta');
    const c = await sofa(admin, 'Cliente C Quinta');
    const planId = await plan(admin, a, base(), p.ricardo);
    await plan(admin, b, plusDays(base(), 2), p.ricardo);
    await plan(admin, c, plusDays(base(), 3), p.ricardo);
    // O gestor coloca C (quinta) na frente: C, A, B.
    const now = await orderOf(p.ricardo, planId);
    const taskSo = new Map(
      (
        await db().productionTask.findMany({
          where: { id: { in: now.taskIds } },
          select: { id: true, serviceOrderId: true },
        })
      ).map((t) => [t.id, t.serviceOrderId]),
    );
    const tasksBy = (so: string) => now.taskIds.filter((id) => taskSo.get(id) === so);
    const manual = [...tasksBy(c.id), ...tasksBy(a.id), ...tasksBy(b.id)];
    const v = (await planDto(admin, planId)).version;
    const r = await put(admin, `/api/v1/production-plans/${planId}/queue`, {
      userId: p.ricardo,
      taskIds: manual,
      version: v,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await orderOf(p.ricardo, planId)).services).toEqual([c.id, a.id, b.id]);
    // Novo serviço na terça: entra depois da última tarefa com data ≤ terça (A) — C, A, D, B.
    const d = await sofa(admin, 'Cliente D Terça');
    await plan(admin, d, plusDays(base(), 1), p.ricardo);
    const after = await orderOf(p.ricardo, planId);
    expect(after.services).toEqual([c.id, a.id, d.id, b.id]);
    contiguous(after.positions);
    // Reordenação com a lista antiga é recusada (nada é sobrescrito por uma tela desatualizada).
    const stale = await put(admin, `/api/v1/production-plans/${planId}/queue`, {
      userId: p.ricardo,
      taskIds: manual,
      version: (await planDto(admin, planId)).version,
    });
    expect(stale.status).toBe(422);
    expect((await orderOf(p.ricardo, planId)).services).toEqual([c.id, a.id, d.id, b.id]);
  });

  it('reprogramação: só a OS reprogramada é reposicionada (mesma semana e outra semana)', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const a = await sofa(admin, 'Cliente A');
    const b = await sofa(admin, 'Cliente B');
    const c = await sofa(admin, 'Cliente C');
    const planId = await plan(admin, a, base(), p.ricardo);
    await plan(admin, b, plusDays(base(), 1), p.ricardo);
    await plan(admin, c, plusDays(base(), 2), p.ricardo);
    expect((await orderOf(p.ricardo, planId)).services).toEqual([a.id, b.id, c.id]);
    // A: segunda → sexta (mesma semana) → vai para o fim; B e C mantêm a ordem entre si.
    const ea = (await entryOf(admin, a.id))!;
    const moved = await put(admin, `/api/v1/production/planned/${ea.plan!.itemId}`, {
      version: ea.plan!.version,
      startDate: plusDays(base(), 4),
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    let o = await orderOf(p.ricardo, planId);
    expect(o.services).toEqual([b.id, c.id, a.id]);
    contiguous(o.positions);
    // Só prioridade: A urgente → frente (faixa de prioridade).
    const ea2 = (await entryOf(admin, a.id))!;
    expect(
      (
        await put(admin, `/api/v1/production/planned/${ea2.plan!.itemId}`, {
          version: ea2.plan!.version,
          priority: 'URGENTE',
        })
      ).status,
    ).toBe(200);
    o = await orderOf(p.ricardo, planId);
    expect(o.services).toEqual([a.id, b.id, c.id]);
    // C para a semana seguinte, numa terça: na fila de destino, pela data.
    const other = await sofa(admin, 'Cliente Próxima Quarta');
    const next = plusDays(base(), 7);
    const nextPlan = await plan(admin, other, plusDays(next, 2), p.ricardo);
    const ec = (await entryOf(admin, c.id))!;
    expect(
      (
        await put(admin, `/api/v1/production/planned/${ec.plan!.itemId}`, {
          version: ec.plan!.version,
          startDate: plusDays(next, 1),
        })
      ).status,
    ).toBe(200);
    const dest = await orderOf(p.ricardo, nextPlan);
    expect(dest.services).toEqual([c.id, other.id]);
    contiguous(dest.positions);
    expect((await orderOf(p.ricardo, planId)).services).toEqual([a.id, b.id]);
  });

  it('ordem visual não libera: posição na frente com data futura continua programada e não inicia', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const later = await sofa(admin, 'Cliente Quarta');
    const first = await sofa(admin, 'Cliente Segunda');
    const planId = await plan(admin, later, plusDays(base(), 2), p.ricardo);
    await plan(admin, first, base(), p.ricardo);
    // João (desmontagem): o gestor põe a OS de quarta na frente.
    const j = await orderOf(p.joao, planId);
    expect(j.services).toEqual([first.id, later.id]);
    const ids = await db().productionTask.findMany({
      where: { id: { in: j.taskIds } },
      select: { id: true, serviceOrderId: true },
    });
    const manual = [
      ...ids.filter((t) => t.serviceOrderId === later.id).map((t) => t.id),
      ...ids.filter((t) => t.serviceOrderId === first.id).map((t) => t.id),
    ];
    expect(
      (
        await put(admin, `/api/v1/production-plans/${planId}/queue`, {
          userId: p.joao,
          taskIds: manual,
          version: (await planDto(admin, planId)).version,
        })
      ).status,
    ).toBe(200);
    expect((await publishWeek(admin, planId)).status).toBe(200);
    setClock(() => new Date(`${base()}T12:00:00Z`));
    await releaseDueTasks(app.ctx.prisma);
    const laterTask = (await tasksOf(later.id)).find((t) => t.assigneeUserId === p.joao)!;
    const firstTask = (await tasksOf(first.id)).find((t) => t.assigneeUserId === p.joao)!;
    expect(laterTask.status).toBe('PROGRAMADA');
    expect(firstTask.status).toBe('LIBERADA');
    const joao = await tabletOf(app, admin, 'João', '482917');
    const q = await queue(joao);
    expect(q.items[0]!.task.id).toBe(laterTask.id); // primeira na ordem visual…
    expect(q.items[0]!.executable).toBe(false); // …mas não executável antes da data
    expect(q.items.find((i) => i.executable)!.task.id).toBe(firstTask.id);
    expect((await act(joao, laterTask.id, 'start')).status).toBe(422);
  });

  it('semana publicada: serviço acrescentado entra na fila publicada pela data ao publicar o rascunho', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const a = await sofa(admin, 'Cliente A Segunda');
    const c = await sofa(admin, 'Cliente C Quinta');
    const planId = await plan(admin, a, base(), p.ricardo);
    await plan(admin, c, plusDays(base(), 3), p.ricardo);
    expect((await publishWeek(admin, planId)).status).toBe(200);
    // Gestor reordena a fila publicada: C antes de A.
    const live = await orderOf(p.ricardo, planId);
    const ids = await db().productionTask.findMany({
      where: { id: { in: live.taskIds } },
      select: { id: true, serviceOrderId: true },
    });
    const soOf = new Map(ids.map((t) => [t.id, t.serviceOrderId]));
    // Na ordem atual das etapas (dependências), só trocando as OS de lugar.
    const manual = [
      ...live.taskIds.filter((id) => soOf.get(id) === c.id),
      ...live.taskIds.filter((id) => soOf.get(id) === a.id),
    ];
    expect(
      (
        await put(admin, `/api/v1/production-plans/${planId}/queue`, {
          userId: p.ricardo,
          taskIds: manual,
          version: (await planDto(admin, planId)).version,
          reason: 'Cliente C pediu urgência',
        })
      ).status,
    ).toBe(200);
    // B (terça) acrescentado e publicado: entra depois de A (última com data ≤ terça).
    const b = await sofa(admin, 'Cliente B Terça');
    await plan(admin, b, plusDays(base(), 1), p.ricardo);
    expect((await publishWeek(admin, planId, 'Inclusão de B')).status).toBe(200);
    const o = await orderOf(p.ricardo, planId);
    expect(o.services).toEqual([c.id, a.id, b.id]);
    contiguous(o.positions);
  });

  it('concorrência: planejamentos simultâneos na mesma semana → posições únicas e ordem pela data', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const sos = [];
    for (const n of ['W', 'X', 'Y', 'Z']) sos.push(await sofa(admin, `Cliente ${n}`));
    const days = [3, 0, 2, 1];
    const results = await Promise.all(
      sos.map((so, i) =>
        planServices(admin, [
          {
            serviceOrderId: so.id,
            startDate: plusDays(base(), days[i]!),
            pieces: [{ serviceOrderItemId: so.items[0]!.id, upholstererUserId: p.ricardo }],
          },
        ]),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    const planId = results[0]!.body.planned[0].planId as string;
    const o = await orderOf(p.ricardo, planId);
    expect(o.services).toEqual([sos[1]!.id, sos[3]!.id, sos[2]!.id, sos[0]!.id]);
    contiguous(o.positions);
    expect(new Set(o.positions).size).toBe(o.positions.length);
  });
});
