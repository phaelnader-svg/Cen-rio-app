import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import type { Client } from './helpers';
import { WsClient, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { createCustomer, createOrder, receiptBody } from './commercial-helpers';
import {
  act,
  addOs,
  createPlan,
  day,
  publish,
  tabletOf,
  today,
  userIdOf,
} from './production-helpers';

/**
 * Evolução, Fase 3 — distribuição automática por OS e peça (planos em fila semanal).
 * Equipe do seed: Ricardo e Márcio (tapeceiros), João (ajudante), Thiago (cabeceiras/qualidade).
 */
let app: App;
const sockets: WsClient[] = [];
const track = (w: WsClient) => (sockets.push(w), w);
beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
});
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

type T = {
  id: string;
  code: string;
  activity: string;
  status: string;
  version: number;
  blockers: string[];
  assignee: { userId: string } | null;
  serviceOrderItem: { id: string } | null;
  dependsOn: { id: string }[];
};
const post = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.post(url, body, { 'idempotency-key': key });
const put = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.req('PUT', url, body, { 'idempotency-key': key });

/** OS aberta (peças recebidas) com as peças pedidas. */
async function os(
  admin: Client,
  name: string,
  pieces: { pieceType: string; description: string; serviceType?: string }[],
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
      serviceType: pieces[k]!.serviceType ?? 'REFORMA_COMPLETA',
    })),
  });
  expect(so.status).toBe(201);
  return so.body as { id: string; code: string; items: { id: string; position: number }[] };
}

async function team() {
  return {
    ricardo: await userIdOf('Ricardo'),
    marcio: await userIdOf('Márcio'),
    joao: await userIdOf('João'),
    thiago: await userIdOf('Thiago'),
  };
}
const planOf = async (admin: Client, id: string) =>
  (await admin.get(`/api/v1/production-plans/${id}`)).body as {
    id: string;
    version: number;
    status: string;
    items: { id: string; serviceOrder: { id: string } }[];
    tasks: T[];
  };
const dist = async (admin: Client, planId: string) =>
  (await admin.get(`/api/v1/production-plans/${planId}/distribution`)).body as {
    pieces: {
      item: { id: string; code: string };
      upholsterer: { userId: string } | null;
      inspector: { userId: string } | null;
      pendencies: { kind: string }[];
      tasks: { id: string; stepClass: string | null; assignee: { userId: string } | null }[];
      ownerChanges: { kind: string; financialReviewRequired: boolean }[];
    }[];
    pendencyCount: number;
  };
const TAPECARIA = ['CORTE_TECIDO', 'COSTURA', 'MONTAGEM', 'ACABAMENTO'];
const PREP = ['DESMONTAGEM', 'PREPARACAO'];

/** Plano em fila com uma OS de dois sofás: A → Ricardo, B → Márcio. */
async function twoSofas(published = false) {
  const admin = await loginAdmin(app);
  const p = await team();
  const so = await os(admin, 'Cliente Dois Sofás', [
    { pieceType: 'SOFA', description: 'Sofá A' },
    { pieceType: 'SOFA', description: 'Sofá B' },
  ]);
  const [a, b] = so.items.sort((x, y) => x.position - y.position);
  const plan = await createPlan(admin, today(), 'FILA_SEMANAL');
  const r = await addOs(admin, plan.id, {
    serviceOrderId: so.id,
    pieces: [
      { serviceOrderItemId: a!.id, upholstererUserId: p.ricardo },
      { serviceOrderItemId: b!.id, upholstererUserId: p.marcio },
    ],
  });
  expect(r.status).toBe(201);
  let current = await planOf(admin, plan.id);
  if (published) current = await publish(admin, current);
  const of = (itemId: string, activity: string) =>
    current.tasks.find((t) => t.serviceOrderItem?.id === itemId && t.activity === activity)!;
  return { admin, p, so, a: a!, b: b!, plan: current, of };
}

describe('Distribuição automática (fila semanal)', () => {
  it('CA3-01/02/04: titular por peça; tapeçaria inteira de cada um; preparação ao João; sem distribuição manual', async () => {
    const { admin, p, a, b, plan, of } = await twoSofas();
    expect(plan.tasks).toHaveLength(12); // 6 etapas × 2 peças, sem nenhuma atribuição manual
    for (const act2 of TAPECARIA) {
      expect(of(a.id, act2).assignee!.userId).toBe(p.ricardo);
      expect(of(b.id, act2).assignee!.userId).toBe(p.marcio);
    }
    for (const act2 of PREP) {
      expect(of(a.id, act2).assignee!.userId).toBe(p.joao);
      expect(of(b.id, act2).assignee!.userId).toBe(p.joao);
    }
    expect(plan.tasks.every((t) => t.status === 'RASCUNHO')).toBe(true);
    // DAG do modelo: montagem depende da preparação E da costura da MESMA peça.
    expect(
      of(a.id, 'MONTAGEM')
        .dependsOn.map((d) => d.id)
        .sort(),
    ).toEqual([of(a.id, 'PREPARACAO').id, of(a.id, 'COSTURA').id].sort());
    const items = await db().serviceOrderItem.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(Object.fromEntries(items.map((i) => [i.id, i.upholstererUserId]))).toEqual({
      [a.id]: p.ricardo,
      [b.id]: p.marcio,
    });
    const d = await dist(admin, plan.id);
    expect(d.pieces.map((x) => x.upholsterer?.userId)).toEqual([p.ricardo, p.marcio]);
    expect(d.pieces.every((x) => x.inspector?.userId === p.thiago)).toBe(true); // CA3-03
    expect(d.pendencyCount).toBe(0);
    // Banco: tapeçaria da peça A não pode ir ao Márcio (titular único).
    await expect(
      db().productionTask.update({
        where: { id: of(a.id, 'COSTURA').id },
        data: { assigneeUserId: p.marcio },
      }),
    ).rejects.toThrow(/titular/);
    // API: mesma regra, mensagem clara.
    const r = await admin.put(`/api/v1/production-tasks/${of(a.id, 'COSTURA').id}`, {
      assigneeUserId: p.marcio,
      version: of(a.id, 'COSTURA').version,
    });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/titular/);
  });

  it('CA3-05: reprocessar e requisições concorrentes não duplicam nem divergem', async () => {
    const { admin, plan } = await twoSofas();
    const planItem = plan.items[0]!;
    const url = `/api/v1/production-plans/${plan.id}/items/${planItem.id}/distribute`;
    const before = await db().productionTask.findMany({
      where: { planId: plan.id },
      orderBy: { id: 'asc' },
      select: { id: true, assigneeUserId: true, version: true },
    });
    expect((await post(admin, url, {})).status).toBe(200);
    const both = await Promise.all([post(admin, url, {}), post(admin, url, {})]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    const after = await db().productionTask.findMany({
      where: { planId: plan.id },
      orderBy: { id: 'asc' },
      select: { id: true, assigneeUserId: true, version: true },
    });
    expect(after).toEqual(before);
    // Mesma OS incluída duas vezes ao mesmo tempo em outra semana: uma vence, sem duplicar.
    const admin2 = await loginAdmin(app);
    const p2 = await createPlan(admin2, day(7), 'FILA_SEMANAL');
    const so = planItem.serviceOrder.id;
    const twice = await Promise.all([
      addOs(admin2, p2.id, { serviceOrderId: so }),
      addOs(admin2, p2.id, { serviceOrderId: so }),
    ]);
    expect(twice.map((r) => r.status).sort()).toEqual([201, 409]);
    // As peças já têm tarefas na semana anterior: nada é gerado de novo (pendência explícita).
    expect(await db().productionTask.count({ where: { serviceOrderId: so } })).toBe(12);
    const d2 = await dist(admin2, p2.id);
    expect(
      d2.pieces.every((x) => x.pendencies.some((k) => k.kind === 'JA_GERADA_EM_OUTRA_SEMANA')),
    ).toBe(true);
    // Índice único: uma segunda tarefa viva para a mesma peça/etapa é recusada pelo banco.
    const t = await db().productionTask.findFirstOrThrow({
      where: { serviceOrderId: so, templateId: { not: null } },
    });
    await expect(
      db().productionTask.create({
        data: {
          planId: t.planId,
          serviceOrderId: t.serviceOrderId,
          serviceOrderItemId: t.serviceOrderItemId,
          activity: t.activity,
          title: 'duplicada',
          role: t.role,
          priority: t.priority,
          sequence: t.sequence,
          templateId: t.templateId,
          templateVersion: t.templateVersion,
          templateStepPosition: t.templateStepPosition,
        },
      }),
    ).rejects.toThrow(/Unique constraint/);
  });

  it('CA3-06/12: gerar não libera; publicação segue dependências, materiais e a fila', async () => {
    const { admin, p, a, b, plan, of } = await twoSofas();
    const joaoTab = await tabletOf(app, admin, 'João', '271828');
    const ricTab = await tabletOf(app, admin, 'Ricardo', '482915');
    expect((await act(joaoTab, of(a.id, 'DESMONTAGEM').id, 'start')).status).toBe(422); // rascunho
    const pub = await publish(admin, plan);
    const s = (id: string) => pub.tasks.find((t: T) => t.id === id) as T;
    expect(s(of(a.id, 'DESMONTAGEM').id).status).toBe('LIBERADA');
    expect(s(of(a.id, 'PREPARACAO').id)).toMatchObject({
      status: 'BLOQUEADA',
      blockers: ['DEPENDENCIAS'],
    });
    expect(s(of(a.id, 'CORTE_TECIDO').id).blockers).toContain('MATERIAIS');
    expect(s(of(a.id, 'MONTAGEM').id).blockers).toEqual(expect.arrayContaining(['DEPENDENCIAS']));
    // Filas: João recebe a preparação das duas peças; Ricardo, só a tapeçaria da peça A.
    const qj = (await joaoTab.get('/api/v1/production-tasks/mine/queue')).body;
    expect(qj.total).toBe(4);
    const qr = (await ricTab.get('/api/v1/production-tasks/mine/queue')).body;
    expect(
      qr.items.map(
        (e: { task: { serviceOrderItem: { id: string } } }) => e.task.serviceOrderItem.id,
      ),
    ).toEqual(Array(4).fill(a.id));
    // Concluir a desmontagem libera a preparação, que não inicia sozinha; só uma principal ativa.
    await act(joaoTab, of(a.id, 'DESMONTAGEM').id, 'start');
    expect((await act(joaoTab, of(b.id, 'DESMONTAGEM').id, 'start')).status).toBe(409);
    await act(joaoTab, of(a.id, 'DESMONTAGEM').id, 'complete');
    const prep = await db().productionTask.findUniqueOrThrow({
      where: { id: of(a.id, 'PREPARACAO').id },
    });
    expect(prep.status).toBe('LIBERADA');
    expect(prep.startedAt).toBeNull();
    void p;
  });

  it('CA3-07/03: sem titular, sem competência e etapa ambígua viram pendência, nunca atribuição arbitrária', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    // Responsável padrão da preparação configurado para quem não tem a competência (Ricardo).
    expect(
      (
        await admin.put('/api/v1/production/distribution-settings', {
          preparationAssigneeUserId: p.ricardo,
        })
      ).status,
    ).toBe(200);
    // Modelo com etapa ambígua (montagem como APOIO, sem classe) para cadeiras.
    const tpl = await admin.post('/api/v1/production-templates', {
      name: 'Cadeira ambígua',
      pieceTypes: ['CADEIRA'],
      steps: [
        { activity: 'PREPARACAO', name: 'Preparação', role: 'APOIO' },
        { activity: 'MONTAGEM', name: 'Montagem (apoio?)', role: 'APOIO', dependsOn: [1] },
      ],
    });
    expect(tpl.status).toBe(201);
    expect(tpl.body.steps.map((s: { stepClass: string | null }) => s.stepClass)).toEqual([
      'PREPARACAO',
      null,
    ]);
    const so = await os(admin, 'Cliente Pendências', [
      { pieceType: 'SOFA', description: 'Sofá sem titular' },
      { pieceType: 'CADEIRA', description: 'Cadeira' },
    ]);
    const plan = await createPlan(admin, today(), 'FILA_SEMANAL');
    const sofa = so.items.find((i) => i.position === 1)!;
    const chair = so.items.find((i) => i.position === 2)!;
    expect(
      (
        await addOs(admin, plan.id, {
          serviceOrderId: so.id,
          pieces: [{ serviceOrderItemId: chair.id, templateId: tpl.body.id }],
        })
      ).status,
    ).toBe(201);
    const d = await dist(admin, plan.id);
    const kinds = (id: string) =>
      d.pieces.find((x) => x.item.id === id)!.pendencies.map((k) => k.kind);
    expect(kinds(sofa.id)).toEqual(
      expect.arrayContaining(['SEM_TITULAR', 'SEM_RESPONSAVEL_PADRAO']),
    );
    expect(kinds(chair.id)).toEqual(
      expect.arrayContaining(['ETAPA_SEM_CLASSIFICACAO', 'SEM_RESPONSAVEL_PADRAO']),
    );
    const tasks = await db().productionTask.findMany({ where: { serviceOrderId: so.id } });
    expect(tasks.every((t) => t.assigneeUserId === null)).toBe(true); // nada arbitrário
    // Publicado: sem responsável continua não executável.
    const pub = await publish(admin, await planOf(admin, plan.id));
    expect(
      pub.tasks.every((t: T) => t.status === 'BLOQUEADA' && t.blockers.includes('SEM_RESPONSAVEL')),
    ).toBe(true);
    // Corrigida a configuração e definido o titular, o reprocessamento completa só o que falta.
    await admin.put('/api/v1/production/distribution-settings', {
      preparationAssigneeUserId: null,
    });
    const def = await put(admin, `/api/v1/service-order-items/${sofa.id}/upholsterer`, {
      userId: p.marcio,
      expectedUserId: null,
      reason: 'Definição do titular',
    });
    expect(def.status).toBe(200);
    const r = await post(
      admin,
      `/api/v1/production-plans/${plan.id}/items/${pub.items[0].id}/distribute`,
      {
        reason: 'Responsáveis definidos',
      },
    );
    expect(r.status).toBe(200);
    const after = await db().productionTask.findMany({
      where: { serviceOrderId: so.id },
      orderBy: { sequence: 'asc' },
    });
    const who = (it: string, a: string) =>
      after.find((t) => t.serviceOrderItemId === it && t.activity === a)!.assigneeUserId;
    expect(who(sofa.id, 'COSTURA')).toBe(p.marcio);
    expect(who(sofa.id, 'PREPARACAO')).toBe(p.joao);
    expect(who(chair.id, 'MONTAGEM')).toBeNull(); // ambígua segue para o gestor
    expect(after).toHaveLength(tasks.length);
  });

  it('CA3-08/09/13: substituição só pelo gestor, com motivo, sem reescrever execução nem valores', async () => {
    const { admin, p, so, a, plan, of } = await twoSofas(true);
    const ricTab = await tabletOf(app, admin, 'Ricardo', '482915');
    const wsRic = track(await WsClient.connect(app, ricTab));
    // Mão de obra já combinada com o Ricardo para a peça A.
    const labor = await post(admin, '/api/v1/finance/labor', {
      professionalUserId: p.ricardo,
      serviceOrderId: so.id,
      serviceOrderItemId: a.id,
      service: 'Reforma do sofá A',
      agreedCents: 120000,
    });
    expect(labor.status).toBe(201);
    // Corte sem exigir material (alteração auditada) para o Ricardo poder executá-lo.
    const corte = of(a.id, 'CORTE_TECIDO');
    await admin.put(`/api/v1/production-tasks/${corte.id}`, {
      requiresMaterials: false,
      version: corte.version,
      reason: 'Tecido do cliente já na oficina',
    });
    expect((await act(ricTab, corte.id, 'start')).status).toBe(200);
    const url = `/api/v1/service-order-items/${a.id}/upholsterer`;
    const body = {
      userId: p.marcio,
      expectedUserId: p.ricardo,
      reason: 'Ricardo afastado',
      confirm: true,
    };
    // Com etapa de tapeçaria em execução: recusado.
    expect((await put(admin, url, body)).status).toBe(422);
    expect((await act(ricTab, corte.id, 'complete')).status).toBe(200);
    // Funcionário não troca titular; sem motivo; sem confirmação; titular desatualizado.
    expect((await put(ricTab, url, body)).status).toBe(403);
    expect((await put(admin, url, { ...body, reason: undefined })).status).toBe(400);
    expect((await put(admin, url, { ...body, confirm: false })).status).toBe(422);
    expect((await put(admin, url, { ...body, expectedUserId: p.marcio })).status).toBe(409);
    const ok = await put(admin, url, body);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ changed: true, financialReviewRequired: true });
    const rows = await db().productionTask.findMany({ where: { serviceOrderItemId: a.id } });
    const by = (act2: string) => rows.find((t) => t.activity === act2)!;
    expect(by('CORTE_TECIDO')).toMatchObject({
      status: 'CONCLUIDA',
      assigneeUserId: p.ricardo,
      completedById: p.ricardo,
    });
    for (const x of ['COSTURA', 'MONTAGEM', 'ACABAMENTO'])
      expect(by(x).assigneeUserId).toBe(p.marcio);
    // Peça B não foi tocada.
    expect(
      (
        await db().productionTask.findMany({
          where: {
            serviceOrderItemId: { not: a.id },
            serviceOrderId: so.id,
            stepClass: 'TAPECARIA',
          },
        })
      ).every((t) => t.assigneeUserId === p.marcio),
    ).toBe(true);
    // Financeiro intacto, só sinalizado.
    const pay = await db().productionPayable.findFirstOrThrow({
      where: { serviceOrderItemId: a.id },
    });
    expect(pay).toMatchObject({ professionalUserId: p.ricardo, agreedCents: 120000, paidCents: 0 });
    const d = await dist(admin, plan.id);
    const pa = d.pieces.find((x) => x.item.id === a.id)!;
    expect(pa.pendencies.map((k) => k.kind)).toContain('REVISAO_FINANCEIRA');
    expect(pa.ownerChanges.map((c) => c.kind)).toEqual(['SUBSTITUICAO', 'DEFINICAO']);
    expect(
      await db().auditLog.count({ where: { action: 'production.piece_owner_replaced' } }),
    ).toBe(1);
    await expect(db().serviceOrderItemOwnerChange.deleteMany({})).rejects.toThrow(/imutável/);
    expect((await admin.get(`/api/v1/production-plans/${plan.id}`)).body.revision).toBeGreaterThan(
      1,
    );
    // Tempo real sem valores.
    await wsRic.waitFor((m) => m.event?.type === 'production.piece_owner_changed');
    expect(JSON.stringify(wsRic.messages)).not.toMatch(/Cents"|"(price|valor|amount)"/i);
    // CA3-13: modelo alterado depois da execução → pendência, sem regenerar nada iniciado.
    const tpl = (await admin.get('/api/v1/production-templates')).body.find(
      (t: { pieceTypes: string[] }) => t.pieceTypes.includes('SOFA'),
    );
    const upd = await admin.put(`/api/v1/production-templates/${tpl.id}`, {
      ...tpl,
      name: `${tpl.name} v2`,
    });
    expect(upd.status).toBe(200);
    const count = await db().productionTask.count({ where: { serviceOrderId: so.id } });
    const re = await post(
      admin,
      `/api/v1/production-plans/${plan.id}/items/${plan.items[0]!.id}/distribute`,
      {
        regenerate: true,
        reason: 'Novo modelo',
      },
    );
    expect(re.status).toBe(200);
    // Peça A (com etapa executada): nada muda, fica a pendência. Peça B (nada iniciado): as 6
    // tarefas antigas são CANCELADAS com motivo (histórico mantido) e 6 novas são geradas.
    expect(await db().productionTask.count({ where: { serviceOrderId: so.id } })).toBe(count + 6);
    const rowsA = await db().productionTask.findMany({ where: { serviceOrderItemId: a.id } });
    expect(rowsA.map((t) => t.id).sort()).toEqual(rows.map((t) => t.id).sort());
    expect(rowsA.find((t) => t.activity === 'CORTE_TECIDO')!.status).toBe('CONCLUIDA');
    expect(
      await db().productionTask.count({
        where: { serviceOrderItemId: { not: a.id }, serviceOrderId: so.id, status: 'CANCELADA' },
      }),
    ).toBe(6);
    const after = re.body as Awaited<ReturnType<typeof dist>>;
    expect(after.pieces.find((x) => x.item.id === a.id)!.pendencies.map((k) => k.kind)).toContain(
      'MODELO_ALTERADO',
    );
  });

  it('CA3-13b: rascunho sem nada iniciado pode ser regenerado com o modelo novo (com motivo)', async () => {
    const { admin, plan, so } = await twoSofas();
    const tpl = (await admin.get('/api/v1/production-templates')).body.find(
      (t: { pieceTypes: string[] }) => t.pieceTypes.includes('SOFA'),
    );
    await admin.put(`/api/v1/production-templates/${tpl.id}`, { ...tpl, name: `${tpl.name} v2` });
    const url = `/api/v1/production-plans/${plan.id}/items/${plan.items[0]!.id}/distribute`;
    expect((await post(admin, url, { regenerate: true })).status).toBe(400); // sem motivo
    expect((await post(admin, url, { regenerate: true, reason: 'Modelo revisado' })).status).toBe(
      200,
    );
    const rows = await db().productionTask.findMany({ where: { serviceOrderId: so.id } });
    expect(rows).toHaveLength(12);
    expect(rows.every((t) => t.templateVersion === tpl.version + 1)).toBe(true);
  });

  it('CA3-10: plano LEGADO segue a geração anterior, sem classe, sem titular por peça', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const so = await os(admin, 'Cliente Legado', [{ pieceType: 'SOFA', description: 'Sofá' }]);
    const plan = await createPlan(admin, today(), 'LEGADO');
    const r = await addOs(admin, plan.id, {
      serviceOrderId: so.id,
      principalUserId: p.ricardo,
      date: today(),
    });
    expect(r.status).toBe(201);
    const rows = await db().productionTask.findMany({ where: { planId: plan.id } });
    expect(rows).toHaveLength(6);
    expect(rows.every((t) => t.stepClass === null && t.templateId === null)).toBe(true);
    expect(
      rows.filter((t) => t.role === 'PRINCIPAL').every((t) => t.assigneeUserId === p.ricardo),
    ).toBe(true);
    expect(rows.filter((t) => t.role === 'APOIO').every((t) => t.assigneeUserId === null)).toBe(
      true,
    );
    expect(
      (await db().serviceOrderItem.findFirstOrThrow({ where: { serviceOrderId: so.id } }))
        .upholstererUserId,
    ).toBeNull();
    // Titular por peça é recusado no LEGADO; regra antiga do sofá (principal obrigatório) mantida.
    const so2 = await os(admin, 'Cliente Legado 2', [{ pieceType: 'SOFA', description: 'Sofá' }]);
    expect(
      (await addOs(admin, plan.id, { serviceOrderId: so2.id, principalUserId: null })).status,
    ).toBe(422);
  });

  it('CA3-11: funcionário não distribui, não vê distribuição e não troca titular', async () => {
    const { admin, p, a, plan } = await twoSofas();
    const tab = await tabletOf(app, admin, 'Márcio', '602413');
    expect((await tab.get(`/api/v1/production-plans/${plan.id}/distribution`)).status).toBe(403);
    expect(
      (
        await post(
          tab,
          `/api/v1/production-plans/${plan.id}/items/${plan.items[0]!.id}/distribute`,
          {},
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await put(tab, `/api/v1/service-order-items/${a.id}/upholsterer`, {
          userId: p.marcio,
          expectedUserId: p.ricardo,
          reason: 'quero',
          confirm: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await tab.put('/api/v1/production/distribution-settings', {
          preparationAssigneeUserId: p.marcio,
        })
      ).status,
    ).toBe(403);
    expect(
      (await db().serviceOrderItem.findUniqueOrThrow({ where: { id: a.id } })).upholstererUserId,
    ).toBe(p.ricardo);
  });

  it('CA3-12: reconexão do tablet recupera a troca de titular perdida', async () => {
    const { admin, p, b } = await twoSofas(true);
    const tab = await tabletOf(app, admin, 'Ricardo', '482915');
    let w = track(await WsClient.connect(app, tab));
    await tab.post('/api/sync/signal', { message: 'marco' }, { 'idempotency-key': idemKey() });
    const mark = await w.waitFor((m) => m.event?.payload?.message === 'marco');
    await w.close();
    const r = await put(admin, `/api/v1/service-order-items/${b.id}/upholsterer`, {
      userId: p.ricardo,
      expectedUserId: p.marcio,
      reason: 'Márcio de férias',
      confirm: true,
    });
    expect(r.status).toBe(200);
    w = track(await WsClient.connect(app, tab, mark.event.seq as string));
    await w.waitFor((m) => m.kind === 'replay.done');
    expect(w.events('production.piece_owner_changed')).toHaveLength(1);
    const q = (await tab.get('/api/v1/production-tasks/mine/queue')).body;
    expect(q.total).toBe(8); // tapeçaria das duas peças agora é do Ricardo
  });
});
