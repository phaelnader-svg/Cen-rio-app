import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { releaseDueTasks } from '../src/modules/production/common';
import type { Client } from './helpers';
import { WsClient, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { createCustomer, createOrder, panelUserWith, receiptBody } from './commercial-helpers';
import { mondayOf } from '@cenario/shared';
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
    expect((await act(joao, first.id, 'start', { version: v })).status).not.toBe(200);
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
    const next = day(9);
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
      startDate: day(20),
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
    if (sameWeekLater) {
      const moveDate = await put(admin, `/api/v1/production/planned/${fresh.plan!.itemId}`, {
        version: fresh.plan!.version,
        startDate: sameWeekLater,
        reason: 'Ajuste de agenda',
      });
      expect(moveDate.status, JSON.stringify(moveDate.body)).toBe(200);
    }
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
        await put(viewer, `/api/v1/production/planned/${r.body.planned[0].planId}`, {
          version: 1,
          startDate: today(),
        })
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
