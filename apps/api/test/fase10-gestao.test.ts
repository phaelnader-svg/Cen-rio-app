import {
  ATTENTION_LIST_LIMIT,
  CATEGORY_ORDER,
  zonedDateTime,
  type AttentionDto,
} from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { panelUserWith } from './commercial-helpers';
import {
  approvedNeeds,
  confirmedFabricPurchase,
  createSupplier,
  linen,
} from './purchasing-helpers';
import { openServiceOrder } from './measurement-helpers';
import { day, today } from './production-helpers';
import { post, qualityKit } from './quality-helpers';

/**
 * Fase 10 do plano principal — gestão: Central acionável, Início pelas fontes canônicas,
 * linha do tempo do serviço e auditoria das ações críticas. Contraprovas (falhavam antes) e
 * aceites. Dados fictícios.
 */
let app: App;
const TZ = 'America/Sao_Paulo';
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
  await db().companySettings.update({
    where: { id: 1 },
    data: { workingDays: [0, 1, 2, 3, 4, 5, 6] },
  });
  setAttendanceClock(() => zonedDateTime(today(), '09:00', TZ));
});
afterEach(() => setAttendanceClock());

const attention = async (c: Client, query = '') =>
  (await c.get(`/api/v1/attention${query}`)).body as AttentionDto;
const keys = (a: AttentionDto) => a.items.map((i) => i.key);
const gestorId = async () =>
  (await db().user.findFirstOrThrow({ where: { email: { contains: 'gestor' } } })).id;

/** Pagável de mão de obra real (fluxo existente) para ancorar negociação/revisão. */
async function laborPayable(admin: Client, soId: string, itemId: string) {
  const r = await post(admin, '/api/v1/finance/labor', {
    professionalUserId: (await db().user.findFirstOrThrow({ where: { displayName: 'Ricardo' } }))
      .id,
    serviceOrderId: soId,
    serviceOrderItemId: itemId,
    service: 'Mão de obra',
    agreedCents: 50000,
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`labor: ${JSON.stringify(r.body)}`);
  return r.body as { id: string };
}

describe('Central — decisões que não chegavam (contraprovas)', () => {
  it('1, 12, 13, 15. negociação e revisão financeira aparecem com link para a ação; resolvidas somem', async () => {
    const s = await k.scenario();
    const p = await laborPayable(s.admin, s.so.id, s.sofa.id);
    const ricardo = await db().user.findFirstOrThrow({ where: { displayName: 'Ricardo' } });
    const vr = await db().valueChangeRequest.create({
      data: {
        targetKind: 'PRODUCAO',
        productionPayableId: p.id,
        beneficiaryUserId: ricardo.id,
        currentCents: 50000,
        requestedCents: 60000,
        reason: 'Braço extra não previsto',
      },
    });
    const rv = await db().laborReview.create({
      data: { serviceOrderId: s.so.id, reason: 'Titular trocado depois do valor combinado' },
    });
    const a = await attention(s.admin, '?type=FINANCEIRO');
    const neg = a.items.find((i) => i.key === `FINANCEIRO:negociacao:${vr.id}`);
    const rev = a.items.find((i) => i.key === `FINANCEIRO:revisao:${rv.id}`);
    expect(neg).toMatchObject({ category: 'ACAO', link: '/painel/financeiro?tab=fechamento' });
    expect(rev).toMatchObject({ category: 'ACAO', link: '/painel/financeiro?tab=producao' });
    // Sem valores no item (a decisão abre o contexto financeiro).
    expect(JSON.stringify(neg)).not.toMatch(/60000|50000/);
    // 2. Resolvidas (pelos fluxos existentes) → somem.
    await db().valueChangeRequest.update({
      where: { id: vr.id },
      data: { status: 'OBSOLETA', decidedAt: new Date() },
    });
    await db().laborReview.update({ where: { id: rv.id }, data: { status: 'RESOLVIDA' } });
    expect(keys(await attention(s.admin, '?type=FINANCEIRO'))).toEqual([]);
  });

  it('7. material a comprar e chegada aguardando conferência aparecem (um item cada)', async () => {
    const admin = await loginAdmin(app);
    const { reqs } = await approvedNeeds(admin, 'Cliente Material', (so) => [
      linen(so.items[0]!.id),
    ]);
    let a = await attention(admin, '?type=MATERIAL');
    expect(keys(a)).toEqual(['MATERIAL:comprar']);
    expect(a.items[0]!.link).toBe('/painel/compras');
    const sup = await createSupplier(admin);
    const po = await confirmedFabricPurchase(admin, sup.id, reqs[0]!);
    await db().materialArrival.create({
      data: {
        purchaseOrderId: po.id,
        lines: [{ purchaseOrderItemId: po.items[0]!.id, quantity: '1' }],
        receivedById: await gestorId(),
      },
    });
    a = await attention(admin, '?type=MATERIAL');
    expect(keys(a)).toContain('MATERIAL:conferencia');
    expect(a.items.find((i) => i.key === 'MATERIAL:conferencia')!.link).toBe(
      '/painel/recebimento-materiais',
    );
  });

  it('expediente de dia anterior sem saída aparece para quem gerencia a presença', async () => {
    const s = await k.scenario();
    const e = await db().employee.findFirstOrThrow({ where: { displayName: 'Ricardo' } });
    const at = await db().operationalAttendance.create({
      data: {
        employeeId: e.id,
        date: new Date(`${day(-1)}T00:00:00Z`),
        situation: 'PRESENTE',
        arrivedAt: new Date(`${day(-1)}T11:30:00Z`),
        arrivalKind: 'NO_HORARIO',
      },
    });
    const a = await attention(s.admin, '?type=PRESENCA');
    expect(a.items.find((i) => i.key === `PRESENCA:expediente:${at.id}`)).toMatchObject({
      link: '/painel/presenca',
    });
  });
});

describe('Central — sem duplicar e com a regra única de prazo (contraprovas)', () => {
  it('3, 10. entrega frustrada vira UM item (sem "pronta" nem ocorrência repetidas)', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const d = (await k.schedule(s)).body;
    const andre = await k.andreTablet(s);
    const v = await k.toDestination(andre, d);
    const fr = await post(andre, `/api/v1/deliveries/${d.id}/frustrate`, {
      kind: 'CLIENTE_INDISPONIVEL',
      reason: 'Ninguém em casa',
      version: v,
    });
    expect(fr.status).toBe(200);
    const a = await attention(s.admin, '?type=LOGISTICA');
    expect(keys(a)).toEqual([`LOGISTICA:frustrada:${d.id}`]);
    expect(a.items[0]!.description).toMatch(/Ninguém em casa/);
    expect(a.items[0]!.link).toBe(`/painel/entregas/${d.id}`);
  });

  it('9. correção em andamento: item da qualidade com a tarefa, sem "prazo interno" repetido', async () => {
    const s = await k.scenario();
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    const open = (await k.openOf(s.sofa.id))!;
    const bad = await k.checkAll(s.tablets.Thiago!, open.id, 'Costura solta');
    await post(s.tablets.Thiago!, `/api/v1/quality/inspections/${bad.id}/reject`, {
      reason: 'Costura solta',
      version: bad.version,
    });
    const corr = await db().productionTask.findFirstOrThrow({
      where: { inspectionId: open.id, activity: 'CORRECAO' },
    });
    await db().productionTask.update({
      where: { id: corr.id },
      data: { dueDate: new Date(`${day(-2)}T00:00:00Z`) },
    });
    const a = await attention(s.admin);
    const q = a.items.find((i) => i.key === `QUALIDADE:correcao:${open.id}`);
    expect(q?.task?.id).toBe(corr.id);
    expect(keys(a)).not.toContain(`PRAZO:${corr.id}`);
  });

  it('prazo da qualidade pela regra única: prazo hoje (não vencido) não é "crítico"', async () => {
    const s = await k.scenario();
    await db().serviceOrder.update({
      where: { id: s.so.id },
      data: { promisedDate: new Date(`${today()}T00:00:00Z`) },
    });
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    const open = (await k.openOf(s.sofa.id))!;
    const bad = await k.checkAll(s.tablets.Thiago!, open.id, 'Mancha');
    await post(s.tablets.Thiago!, `/api/v1/quality/inspections/${bad.id}/reject`, {
      reason: 'Mancha',
      version: bad.version,
    });
    const so = (await s.admin.get(`/api/v1/service-orders/${s.so.id}`)).body;
    expect(so.deadline.state).not.toBe('ATRASADO');
    const q = (await attention(s.admin)).items.find(
      (i) => i.key === `QUALIDADE:correcao:${open.id}`,
    );
    expect(q?.category).toBe('ATENCAO');
  });
});

describe('Central — prioridade, prazos, permissões e estado vazio', () => {
  it('4–6, 8. atrasado e em risco pela regra de prazos; prioridade por categoria', async () => {
    const s = await k.scenario();
    const other = { so: await openServiceOrder(s.admin, 'Cliente Prazo') };
    await db().serviceOrder.update({
      where: { id: s.so.id },
      data: { promisedDate: new Date(`${day(-1)}T00:00:00Z`) },
    });
    await db().serviceOrder.update({
      where: { id: other.so.id },
      data: { promisedDate: new Date(`${day(1)}T00:00:00Z`) },
    });
    await db().productionTask.update({
      where: { id: s.sofaTask.id },
      data: { dueDate: new Date(`${day(-1)}T00:00:00Z`) },
    });
    const a = await attention(s.admin);
    expect(a.items.find((i) => i.key === `PRAZO_OS:${s.so.id}`)?.category).toBe('CRITICO');
    expect(a.items.find((i) => i.key === `PRAZO_OS:${other.so.id}`)?.category).toBe('ACAO');
    expect(keys(a)).toContain(`PRAZO:${s.sofaTask.id}`); // produção acionável
    const order = a.items.map((i) => CATEGORY_ORDER[i.category]);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(new Set(keys(a)).size).toBe(a.items.length);
  });

  it('14. sem permissão do domínio não vê; tablet não acessa; 16. estado vazio', async () => {
    const admin = await loginAdmin(app);
    expect((await attention(admin)).items).toEqual([]);
    const s = await k.scenario();
    await laborPayable(s.admin, s.so.id, s.sofa.id);
    await db().laborReview.create({ data: { serviceOrderId: s.so.id, reason: 'Revisão' } });
    const viewer = await panelUserWith(app, s.admin, 'central', ['ocorrencias.ver']);
    const a = await attention(viewer);
    expect(a.items.filter((i) => ['FINANCEIRO', 'MATERIAL', 'COBRANCA'].includes(i.type))).toEqual(
      [],
    );
    expect((await s.tablets.Ricardo!.get('/api/v1/attention')).status).toBe(403);
  });
});

describe('F10-15: contagens da Central pela fonte completa (sem truncar por take)', () => {
  const sum = (a: AttentionDto) => Object.values(a.counts).reduce((x, y) => x + y, 0);

  it('0, 1, abaixo, no limite e acima de 100/300: contagem exata; lista limitada; resolvidos não contam', async () => {
    const s = await k.scenario();
    const task = await db().productionTask.findFirstOrThrow({ where: { serviceOrderId: s.so.id } });
    const reporter = await gestorId();
    let made = 0;
    const issuesUpTo = async (n: number) => {
      if (n > made)
        await db().productionIssue.createMany({
          data: Array.from({ length: n - made }, (_, i) => ({
            kind: 'OUTRO',
            impact: 'DIFICULDADE',
            blocksTask: false,
            description: `Ocorrência em massa ${made + i + 1}`,
            taskId: task.id,
            serviceOrderId: s.so.id,
            reporterUserId: reporter,
          })),
        });
      made = n;
    };
    expect((await attention(s.admin, '?type=OCORRENCIA')).total).toBe(0);
    // 300 era o `take` da fonte de ocorrências (e 100 o das demais).
    for (const n of [1, 99, 100, 101, 299, 300, 301, 350]) {
      await issuesUpTo(n);
      const a = await attention(s.admin, '?type=OCORRENCIA');
      expect(a.counts.ACAO, `n=${n}`).toBe(n);
      expect(a.total).toBe(n);
      expect(sum(a)).toBe(n);
      // A lista continua limitada (os mais urgentes primeiro); a contagem não.
      expect(a.items.length).toBe(Math.min(n, ATTENTION_LIST_LIMIT));
      expect(new Set(keys(a)).size).toBe(a.items.length);
    }
    // Sem filtro: o card soma as 350 ocorrências e o que mais houver.
    const all = await attention(s.admin);
    expect(all.counts.ACAO).toBeGreaterThanOrEqual(350);
    expect(all.total).toBe(sum(all));
    expect(all.items.length).toBe(Math.min(all.total, ATTENTION_LIST_LIMIT));
    // Resolvidas há mais de 24 h não contam.
    const some = await db().productionIssue.findMany({ take: 120, select: { id: true } });
    await db().$executeRawUnsafe(
      `UPDATE production_issues SET status = 'RESOLVIDA', resolved_at = now() - interval '2 days',
         resolved_by_id = $2::uuid, updated_at = now() - interval '2 days' WHERE id = ANY($1::uuid[])`,
      some.map((o) => o.id),
      reporter,
    );
    const after = await attention(s.admin, '?type=OCORRENCIA');
    expect([after.counts.ACAO, after.total, after.items.length]).toEqual([230, 230, 230]);
  });

  it('permissão continua filtrando a contagem; chegadas acima de 100 no título pela contagem da fonte', async () => {
    const s = await k.scenario();
    await db().laborReview.create({ data: { serviceOrderId: s.so.id, reason: 'Revisão' } });
    const admin = await attention(s.admin, '?type=FINANCEIRO');
    expect([admin.total, admin.counts.ACAO]).toEqual([1, 1]);
    const viewer = await panelUserWith(app, s.admin, 'central', ['ocorrencias.ver']);
    const v = await attention(viewer, '?type=FINANCEIRO');
    expect([v.total, v.counts.ACAO, v.items.length]).toEqual([0, 0, 0]);
    expect((await attention(viewer)).total).toBe((await attention(s.admin)).total - 1);

    const { reqs } = await approvedNeeds(s.admin, 'Cliente Chegadas', (so) => [
      linen(so.items[0]!.id),
    ]);
    const sup = await createSupplier(s.admin);
    const po = await confirmedFabricPurchase(s.admin, sup.id, reqs[0]!);
    const by = await gestorId();
    await db().materialArrival.createMany({
      data: Array.from({ length: 101 }, () => ({
        purchaseOrderId: po.id,
        lines: [{ purchaseOrderItemId: po.items[0]!.id, quantity: '1' }],
        receivedById: by,
      })),
    });
    const m = await attention(s.admin, '?type=MATERIAL');
    expect(m.items.find((i) => i.key === 'MATERIAL:conferencia')!.title).toBe(
      '101 chegada(s) de material aguardando conferência',
    );
    // Quem não vê estoque/compras não conta o aviso de material.
    expect((await attention(viewer, '?type=MATERIAL')).total).toBe(0);
  });
});

describe('Início — indicadores pelas fontes canônicas', () => {
  it('17–25. ativos, prazos, materiais, etapas, prontas e entregas próximas', async () => {
    const s = await k.scenario();
    await db().serviceOrder.update({
      where: { id: s.so.id },
      data: { promisedDate: new Date(`${day(-1)}T00:00:00Z`) },
    });
    await k.ready(s, 'sofa');
    await k.finish(s.tablets.Márcio!, s.poltronaTask.id); // poltronas na qualidade
    await k.schedule(s, { scheduledDate: day(1) });
    const o = (await s.admin.get('/api/v1/management/overview')).body;
    expect(o.today).toBe(today());
    expect(o.operations).toMatchObject({
      activeServiceOrders: 1,
      deadlines: { late: 1, atRisk: 0 },
      pieces: { quality: 1, scheduled: 1, production: 0, ready: 0 },
    });
    expect(o.deliveries).toMatchObject({ upcoming: 1, frustrated: 0 });
    // Coerente com a Central (mesma regra de prazo).
    const a = await attention(s.admin, '?type=PRAZO_OS');
    expect(a.counts.CRITICO).toBe(o.operations.deadlines.late);
    // OS com todas as peças entregues sai dos ativos (antes "OS abertas" só crescia).
    await db().serviceOrderItem.updateMany({
      where: { serviceOrderId: s.so.id },
      data: { fulfillmentStage: 'ENTREGUE' },
    });
    const o2 = (await s.admin.get('/api/v1/management/overview')).body;
    expect(o2.operations.activeServiceOrders).toBe(0);
    expect(o2.operations.deadlines.late).toBe(0);
  });

  it('20. aguardando material pela prontidão canônica', async () => {
    const admin = await loginAdmin(app);
    const { so } = await approvedNeeds(admin, 'Cliente Prontidão', (x) => [linen(x.items[0]!.id)]);
    const row = await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } });
    const o = (await admin.get('/api/v1/management/overview')).body;
    const pending = [
      'AGUARDANDO_COMPRA',
      'AGUARDANDO_RECEBIMENTO',
      'PARCIALMENTE_DISPONIVEL',
      'COM_DIVERGENCIA',
    ];
    expect(o.operations.awaitingMaterials).toBe(pending.includes(row.materialsReadiness) ? 1 : 0);
  });

  it('26, 27. financeiro só com permissão (null, nunca zero) e pela fonte canônica', async () => {
    const s = await k.scenario();
    const p = await laborPayable(s.admin, s.so.id, s.sofa.id);
    await db().productionPayable.update({ where: { id: p.id }, data: { status: 'LIBERADO' } });
    const o = (await s.admin.get('/api/v1/management/overview')).body;
    expect(o.finance).toMatchObject({
      laborDueCents: 50000,
      receivables: { openCents: 0, overdueCents: 0, overdueCount: 0 },
      decisions: { valueRequests: 0, laborReviews: 0 },
    });
    const osOnly = await panelUserWith(app, s.admin, 'inicio', ['os.ver']);
    const o2 = (await osOnly.get('/api/v1/management/overview')).body;
    expect(o2.finance).toBeNull();
    expect(o2.deliveries).toBeNull();
    expect(o2.operations).not.toBeNull();
    expect(JSON.stringify(o2)).not.toMatch(/Cents/);
  });

  it('28. "hoje" no fuso da oficina (23h30 em Brasília já é amanhã em UTC)', async () => {
    setAttendanceClock(() => zonedDateTime(today(), '23:30', TZ));
    const admin = await loginAdmin(app);
    const o = (await admin.get('/api/v1/management/overview')).body;
    expect(o.today).toBe(today());
  });

  it('40, 41. tablet e usuário sem permissão não acessam o Início gerencial', async () => {
    const s = await k.scenario();
    expect((await s.tablets.Ricardo!.get('/api/v1/management/overview')).status).toBe(403);
    const none = await panelUserWith(app, s.admin, 'semgestao', ['clientes.ver']);
    expect((await none.get('/api/v1/management/overview')).status).toBe(403);
  });
});

describe('Linha do tempo e auditoria das ações críticas', () => {
  it('12/35. linha do tempo do serviço junta pedido, produção, qualidade e entrega', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const d = (await k.schedule(s)).body;
    const andre = await k.andreTablet(s);
    let v = await k.toDestination(andre, d);
    v = (
      await post(andre, `/api/v1/deliveries/${d.id}/items`, {
        items: [{ serviceOrderItemId: s.sofa.id, status: 'ENTREGUE' }],
        version: v,
      })
    ).body.version;
    await post(andre, `/api/v1/deliveries/${d.id}/complete`, { version: v });
    const t = (await s.admin.get(`/api/v1/service-orders/${s.so.id}/timeline`)).body;
    const domains = new Set((t.entries as { domain: string }[]).map((e) => e.domain));
    for (const x of ['PEDIDO', 'RECEBIMENTO', 'OS', 'PRODUCAO', 'QUALIDADE', 'ENTREGA'])
      expect(domains.has(x), x).toBe(true);
    const ats = (t.entries as { at: string }[]).map((e) => e.at);
    expect(ats).toEqual([...ats].sort());
    // 46. exige permissão de OS.
    const none = await panelUserWith(app, s.admin, 'semos', ['clientes.ver']);
    expect((await none.get(`/api/v1/service-orders/${s.so.id}/timeline`)).status).toBe(403);
  });

  it('31, 32. prazo da OS: omitir não apaga; alterar exige motivo; motivo na auditoria', async () => {
    const s = await k.scenario();
    await db().serviceOrder.update({
      where: { id: s.so.id },
      data: { promisedDate: new Date(`${day(10)}T00:00:00Z`) },
    });
    let so = await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } });
    const r = await s.admin.put(`/api/v1/service-orders/${s.so.id}`, {
      priority: 'ALTA',
      reason: 'Cliente pediu prioridade',
      version: so.version,
    });
    expect(r.status).toBe(200);
    so = await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } });
    expect(so.promisedDate?.toISOString().slice(0, 10)).toBe(day(10));
    const noReason = await s.admin.put(`/api/v1/service-orders/${s.so.id}`, {
      priority: 'ALTA',
      promisedDate: day(12),
      version: so.version,
    });
    expect(noReason.status).toBe(400);
    const ok = await s.admin.put(`/api/v1/service-orders/${s.so.id}`, {
      priority: 'ALTA',
      promisedDate: day(12),
      reason: 'Fornecedor atrasou o tecido',
      version: so.version,
    });
    expect(ok.status).toBe(200);
    const log = await db().auditLog.findFirstOrThrow({
      where: { entityId: s.so.id, action: 'service_order.updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(log.changes).toMatchObject({ reason: 'Fornecedor atrasou o tecido' });
    expect(log.actorUserId).not.toBeNull();
    expect(log.createdAt).toBeInstanceOf(Date);
  });

  it('29, 30. cancelamento de tarefa e desbloqueio registram autor e motivo; motivo longo não quebra', async () => {
    const s = await k.scenario();
    const long = await post(s.admin, `/api/v1/production-tasks/${s.poltronaTask.id}/unblock`, {
      reason: 'x'.repeat(800),
    });
    expect(long.status).toBe(400);
    const c = await post(s.admin, `/api/v1/production-tasks/${s.poltronaTask.id}/cancel`, {
      reason: 'Cliente desistiu das poltronas',
    });
    expect(c.status).toBe(200);
    const log = await db().auditLog.findFirstOrThrow({
      where: { entityId: s.poltronaTask.id, action: 'production.task_cancelled' },
    });
    expect(log.changes).toMatchObject({ reason: 'Cliente desistiu das poltronas' });
  });

  it('34. substituto da inspeção: de/para na auditoria e sem motivo herdado', async () => {
    const s = await k.scenario();
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    const marcio = await db().employee.findFirstOrThrow({ where: { displayName: 'Márcio' } });
    const joao = await db().employee.findFirstOrThrow({ where: { displayName: 'João' } });
    for (const e of [marcio, joao]) {
      const grant = await db().user.findUniqueOrThrow({ where: { id: e.userId! } });
      await db().userPermission.create({
        data: { userId: grant.id, permission: 'qualidade.inspecionar' },
      });
    }
    let i = (await k.openOf(s.sofa.id))!;
    const a1 = await post(s.admin, `/api/v1/quality/inspections/${i.id}/assign`, {
      inspectorUserId: joao.userId,
      reason: 'Thiago de férias',
      version: i.version,
    });
    expect(a1.status).toBe(200);
    i = (await k.openOf(s.sofa.id))!;
    const a2 = await post(s.admin, `/api/v1/quality/inspections/${i.id}/assign`, {
      inspectorUserId: marcio.userId,
      version: i.version,
    });
    expect(a2.status).toBe(200);
    const row = await db().qualityInspection.findUniqueOrThrow({ where: { id: i.id } });
    expect(row.substituteReason).not.toMatch(/férias/);
    const log = await db().auditLog.findFirstOrThrow({
      where: { entityId: i.id, action: 'quality.inspector_assigned' },
      orderBy: { createdAt: 'desc' },
    });
    expect(log.changes).toMatchObject({ from: joao.userId, to: marcio.userId });
  });

  it('35, 36. alteração de entrega guarda o antes/depois; cancelamento de custo logístico auditado', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const d = (await k.schedule(s, { tripCost: { amountCents: 9000 } })).body;
    const u = await s.admin.put(`/api/v1/deliveries/${d.id}`, {
      scheduledDate: day(3),
      windowStart: '14:00',
      team: 'LOGISTICA_TERCEIRIZADA',
      responsibleUserId: s.ids.andre,
      itemIds: [s.sofa.id],
      reason: 'Cliente pediu à tarde',
      version: d.version,
    });
    expect(u.status).toBe(200);
    const log = await db().auditLog.findFirstOrThrow({
      where: { entityId: d.id, action: 'delivery.updated' },
    });
    expect(log.changes).toMatchObject({
      from: { scheduledDate: day(1), windowStart: '09:00' },
      to: { scheduledDate: day(3), windowStart: '14:00' },
      reason: 'Cliente pediu à tarde',
    });
    const cost = await db().logisticsCost.findFirstOrThrow({ where: { deliveryId: d.id } });
    const c = await post(s.admin, `/api/v1/finance/logistics-costs/${cost.id}/cancel`, {
      reason: 'Viagem feita junto com outra entrega',
      version: cost.version,
    });
    expect(c.status).toBe(200);
    expect(
      await db().auditLog.count({
        where: { entityId: cost.id, action: 'finance.logistics_cost_cancelled' },
      }),
    ).toBe(1);
  });

  it('37, 38. presença e exceção administrativa têm histórico próprio (equivalência documentada)', async () => {
    const s = await k.scenario();
    const e = await db().employee.findFirstOrThrow({ where: { displayName: 'Ricardo' } });
    const r = await s.admin.post('/api/v1/attendance/actions', {
      employeeId: e.id,
      date: today(),
      action: 'FOLGA',
      reason: 'Folga combinada',
    });
    expect(r.status).toBe(200);
    const corr = await db().attendanceCorrection.findFirstOrThrow({
      where: { attendance: { employeeId: e.id } },
    });
    expect(corr.reason).toBe('Folga combinada');
    expect(
      await db().auditLog.count({ where: { action: { startsWith: 'attendance.' } } }),
    ).toBeGreaterThan(0);
  });

  it('21-auditoria: filtro por entidade; financeiro oculto para quem não vê o financeiro', async () => {
    const s = await k.scenario();
    await laborPayable(s.admin, s.so.id, s.sofa.id);
    const page = (await s.admin.get(`/api/audit?entityId=${s.so.id}`)).body;
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((i: { entityId: string }) => i.entityId === s.so.id)).toBe(true);
    const auditor = await panelUserWith(app, s.admin, 'auditor', ['auditoria.ver']);
    const all = (await auditor.get('/api/audit?limit=100')).body.items as { action: string }[];
    expect(all.some((x) => x.action.startsWith('finance.'))).toBe(false);
    const fullAll = (await s.admin.get('/api/audit?limit=100')).body.items as { action: string }[];
    expect(fullAll.some((x) => x.action.startsWith('finance.'))).toBe(true);
  });

  it('busca: código da peça (OS-00001/1) encontra a OS', async () => {
    const s = await k.scenario();
    const so = await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } });
    const code = `OS-${String(so.number).padStart(5, '0')}/1`;
    const r = (await s.admin.get(`/api/v1/service-orders?q=${encodeURIComponent(code)}`)).body;
    expect(r.items.map((x: { id: string }) => x.id)).toContain(s.so.id);
  });
});

void idemKey;
