import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { type Client, createTestApp, db, idemKey, resetDatabase } from './helpers';
import { post, qualityKit } from './quality-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/**
 * Reformulação, Fase 3 — qualidade simplificada ("Tudo conforme"), autoaprovação SÓ do gestor com
 * justificativa auditada e destacada (D4), e embalagem opcional pelo interruptor da Fase 0, com
 * os efeitos em entrega, cobrança, prazo e mão de obra. Banco descartável, dados fictícios.
 */
let app: App;
const k = qualityKit(() => app);
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());
beforeEach(async () => resetDatabase());

const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const approve = (c: Client, i: { id: string; version: number }, body: Record<string, unknown>) =>
  post(c, `/api/v1/quality/inspections/${i.id}/approve`, { version: i.version, ...body });

async function setModule(admin: Client, key: string, enabled: boolean) {
  const list = ok<{ key: string; version: number }[]>(await admin.get('/api/company/modules'));
  const m = list.find((x) => x.key === key)!;
  return admin.req(
    'PUT',
    `/api/company/modules/${key}`,
    { enabled, version: m.version },
    { 'idempotency-key': idemKey() },
  );
}
/** Dá a permissão de gestor da qualidade a um funcionário (sem mexer nas funções). */
async function makeQualityManager(userId: string) {
  await db().userPermission.create({ data: { userId, permission: 'qualidade.gerenciar' } });
}

describe('Qualidade simplificada', () => {
  it('"Tudo conforme" aprova marcando só os itens não conferidos; com defeito, recusa', async () => {
    const s = await k.scenario();
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    const open = (await k.openOf(s.sofa.id))!;
    let i = await k.inspection(s.tablets.Thiago!, open.id);
    // Um item conferido à mão continua como está.
    ok(
      await s.tablets.Thiago!.put(`/api/v1/quality/inspections/${i.id}/items/${i.items[0]!.id}`, {
        result: 'OK',
        note: 'conferido à mão',
      }),
    );
    i = await k.inspection(s.tablets.Thiago!, open.id);
    const done = ok(await approve(s.tablets.Thiago!, i, { allConform: true }));
    expect(done.status).toBe('APROVADA');
    const items = await db().qualityInspectionItem.findMany({
      where: { inspectionId: open.id },
      orderBy: { position: 'asc' },
    });
    expect(items.every((x) => x.result === 'OK')).toBe(true);
    expect(items[0]!.note).toBe('conferido à mão');
    expect(items.every((x) => x.checkedById === s.ids.thiago)).toBe(true);
    // Embalagem (ligada por padrão) continua obrigatória: registro criado, peça aguardando.
    expect(await db().packagingRecord.count({ where: { serviceOrderItemId: s.sofa.id } })).toBe(1);
    expect(await k.stage(s.sofa.id)).toBe('AGUARDANDO_EMBALAGEM');

    // Com item não conforme, "Tudo conforme" é recusado e nada muda.
    await k.finish(s.tablets.Márcio!, s.poltronaTask.id);
    const o2 = (await k.openOf(s.poltronas.id))!;
    let i2 = await k.inspection(s.tablets.Thiago!, o2.id);
    ok(
      await s.tablets.Thiago!.put(`/api/v1/quality/inspections/${i2.id}/items/${i2.items[0]!.id}`, {
        result: 'NAO_CONFORME',
        note: 'costura aberta',
      }),
    );
    i2 = await k.inspection(s.tablets.Thiago!, o2.id);
    const r = await approve(s.tablets.Thiago!, i2, { allConform: true });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toMatch(/não conformes/);
    expect(
      await db().qualityInspectionItem.count({ where: { inspectionId: o2.id, result: null } }),
    ).toBeGreaterThan(0);
    // Reprovar continua igual: gera correção.
    ok(
      await post(s.tablets.Thiago!, `/api/v1/quality/inspections/${i2.id}/reject`, {
        reason: 'Costura aberta no braço',
        version: i2.version,
      }),
    );
    expect(
      await db().productionTask.count({ where: { activity: 'CORRECAO', inspectionId: o2.id } }),
    ).toBe(1);
  });

  it('D4: o gestor aprova a própria execução só com justificativa — auditada e destacada', async () => {
    const s = await k.scenario();
    // Ricardo executa o sofá e passa a ser gestor da qualidade.
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    await makeQualityManager(s.ids.ricardo);
    const open = (await k.openOf(s.sofa.id))!;
    const i = await k.inspection(s.tablets.Ricardo!, open.id);
    const dto = ok((await s.tablets.Ricardo!.get(`/api/v1/quality/inspections/${i.id}`)) as J);
    expect(dto.can).toMatchObject({ decide: true, selfApproval: true });
    // Sem justificativa (ou curta demais): recusado, nada gravado.
    const none = await approve(s.tablets.Ricardo!, i, { allConform: true });
    expect(none.status).toBe(422);
    expect(JSON.stringify(none.body)).toMatch(/justificativa/);
    expect(
      (await approve(s.tablets.Ricardo!, i, { allConform: true, selfApprovalReason: 'curta' }))
        .status,
    ).toBe(400);
    expect(
      (await db().qualityInspection.findUniqueOrThrow({ where: { id: i.id } })).status,
    ).not.toBe('APROVADA');
    // Com justificativa: aprovado, com identidade, data e justificativa gravadas.
    const reason = 'Inspetor de férias e cliente busca hoje; conferido com o cliente presente';
    const done = ok(
      await approve(s.tablets.Ricardo!, i, { allConform: true, selfApprovalReason: reason }),
    );
    expect(done.status).toBe('APROVADA');
    const row = await db().qualityInspection.findUniqueOrThrow({ where: { id: i.id } });
    expect(row).toMatchObject({ selfApprovalReason: reason, decidedById: s.ids.ricardo });
    expect(row.decidedAt).not.toBeNull();
    const audits = await db().auditLog.findMany({
      where: { entityType: 'quality_inspection', entityId: i.id },
      orderBy: { createdAt: 'asc' },
    });
    const self = audits.find((a) => a.action === 'quality.inspection_self_approved')!;
    expect(self.actorUserId).toBe(s.ids.ricardo);
    expect(self.summary).toMatch(/^EXCEÇÃO: Ricardo aprovou a própria execução/);
    expect(self.summary).toContain(reason.slice(0, 40));
    // A auditoria filtra as exceções destacadas.
    const hl = ok(await s.admin.get('/api/audit?highlighted=1'));
    expect(hl.items.map((x: J) => x.action)).toEqual(['quality.inspection_self_approved']);
    // O detalhe mostra a justificativa.
    const after = ok((await s.admin.get(`/api/v1/quality/inspections/${i.id}`)) as J);
    expect(after.selfApprovalReason).toBe(reason);
  });

  it('demais executores continuam sem aprovar (nem com justificativa); gestor que executou pode reprovar', async () => {
    const s = await k.scenario();
    await k.finish(s.tablets.Márcio!, s.poltronaTask.id);
    const open = (await k.openOf(s.poltronas.id))!;
    const i = await k.inspection(s.tablets.Thiago!, open.id);
    // Márcio executou e não é gestor: recusado mesmo com justificativa.
    const r = await approve(s.tablets.Márcio!, i, {
      allConform: true,
      selfApprovalReason: 'Justificativa qualquer bem longa',
    });
    expect([403, 422]).toContain(r.status);
    expect(
      (await db().qualityInspection.findUniqueOrThrow({ where: { id: i.id } })).status,
    ).not.toBe('APROVADA');
    // Inspetor que NÃO executou aprova sem marca de autoaprovação.
    const dto = ok((await s.tablets.Thiago!.get(`/api/v1/quality/inspections/${i.id}`)) as J);
    expect(dto.can).toMatchObject({ decide: true, selfApproval: false });

    // Gestor que executou o sofá reprova sem justificativa (não é conflito).
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    await makeQualityManager(s.ids.ricardo);
    const o2 = (await k.openOf(s.sofa.id))!;
    const bad = await k.checkAll(s.tablets.Ricardo!, o2.id, 'Grampo aparente');
    ok(
      await post(s.tablets.Ricardo!, `/api/v1/quality/inspections/${bad.id}/reject`, {
        reason: 'Grampo aparente no encosto',
        version: bad.version,
      }),
    );
    expect(
      await db().auditLog.count({ where: { action: 'quality.inspection_self_approved' } }),
    ).toBe(0);
  });
});

describe('Embalagem opcional (interruptor da Fase 0)', () => {
  it('desligada: aprovada vai direto a "pronta para entrega"; sem liberação financeira prematura', async () => {
    const s = await k.scenario();
    // Mão de obra: uma liberada na aprovação, outra só na entrega.
    const laborQ = ok(
      await post(s.admin, '/api/v1/finance/labor', {
        professionalUserId: s.ids.ricardo,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.sofa.id,
        service: 'Revestimento do sofá',
        agreedCents: 30000,
        eligibility: 'QUALIDADE_APROVADA',
      }),
      201,
    );
    // A da entrega fica nas poltronas (uma mão de obra por peça).
    const laborE = ok(
      await post(s.admin, '/api/v1/finance/labor', {
        professionalUserId: s.ids.marcio,
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.poltronas.id,
        service: 'Troca de tecido das poltronas',
        agreedCents: 45000,
        eligibility: 'ENTREGA_CONCLUIDA',
      }),
      201,
    );
    const order = await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } });
    const rec = ok(
      await post(s.admin, '/api/v1/finance/receivables', {
        orderId: order.orderId,
        description: 'Saldo na entrega',
        amountCents: 100000,
        dueTrigger: 'ENTREGA',
        expectedMethod: 'PIX',
      }),
      201,
    );
    ok(await setModule(s.admin, 'embalagem', false));

    // Produção da peça concluída: nada liberado ainda.
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    const status = async (id: string) =>
      (await db().productionPayable.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(laborQ.id)).toBe('PREVISTO');

    const insp = await k.approveOpen(s, s.sofa.id);
    const row = await db().qualityInspection.findUniqueOrThrow({ where: { id: insp.id } });
    expect(row.packagingRequired).toBe(false);
    expect(await db().packagingRecord.count({ where: { serviceOrderItemId: s.sofa.id } })).toBe(0);
    expect(await k.stage(s.sofa.id)).toBe('PRONTA_ENTREGA');
    // Aviso de "pronta para entrega" continua saindo (uma vez, sem embalagem).
    expect(
      await db().notification.count({
        where: { kind: 'PRONTO_ENTREGA', dedupeKey: { contains: s.sofa.id } },
      }),
    ).toBeGreaterThan(0);
    // Mão de obra: liberada a da aprovação; a da entrega, NÃO (sem liberação prematura).
    expect(await status(laborQ.id)).toBe('LIBERADO');
    expect(await status(laborE.id)).toBe('PREVISTO');
    // Cobrança com vencimento na entrega continua aguardando a entrega.
    const recNow = ok(await s.admin.get(`/api/v1/finance/receivables/${rec.id}`));
    expect(recNow.effectiveDueDate).toBeNull();

    // A poltrona ainda não está pronta: a OS não pode ser entregue por inteiro ainda.
    const elig = ok(await s.admin.get(`/api/v1/service-orders/${s.so.id}/direct-delivery`));
    expect(elig.eligible).toBe(false);
    expect(JSON.stringify(elig.blocks)).not.toMatch(/embalagem/i);
    await k.finish(s.tablets.Márcio!, s.poltronaTask.id);
    await k.approveOpen(s, s.poltronas.id);
    // Poltronas aprovadas (sem embalagem): a mão de obra "na entrega" segue prevista.
    expect(await k.stage(s.poltronas.id)).toBe('PRONTA_ENTREGA');
    expect(await status(laborE.id)).toBe('PREVISTO');
    const e2 = ok(await s.admin.get(`/api/v1/service-orders/${s.so.id}/direct-delivery`));
    expect(e2).toMatchObject({ eligible: true, blocks: [] });
    // Entrega: só então libera a mão de obra da entrega e vence a cobrança.
    ok(
      await post(s.admin, `/api/v1/service-orders/${s.so.id}/deliver`, { note: 'Cliente buscou' }),
    );
    expect(await k.stage(s.sofa.id)).toBe('ENTREGUE');
    expect(await status(laborE.id)).toBe('LIBERADO');
    expect(
      ok(await s.admin.get(`/api/v1/finance/receivables/${rec.id}`)).effectiveDueDate,
    ).not.toBeNull();
  });

  it('ligada: fluxo de sempre; mudar o interruptor não altera o que já foi decidido', async () => {
    const s = await k.scenario();
    // Sofá aprovado com a embalagem LIGADA: embalagem pendente continua exigida mesmo depois de
    // desligar o interruptor.
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    await k.approveOpen(s, s.sofa.id);
    expect(await k.stage(s.sofa.id)).toBe('AGUARDANDO_EMBALAGEM');
    ok(await setModule(s.admin, 'embalagem', false));
    expect(await k.stage(s.sofa.id)).toBe('AGUARDANDO_EMBALAGEM');
    const elig = ok(await s.admin.get(`/api/v1/service-orders/${s.so.id}/direct-delivery`));
    expect(JSON.stringify(elig.blocks)).toMatch(/embalagem/i);
    await k.pack(s, s.sofa.id);
    expect(await k.stage(s.sofa.id)).toBe('PRONTA_ENTREGA');

    // Poltronas aprovadas com a embalagem DESLIGADA; religar não volta a exigir.
    await k.finish(s.tablets.Márcio!, s.poltronaTask.id);
    await k.approveOpen(s, s.poltronas.id);
    expect(await k.stage(s.poltronas.id)).toBe('PRONTA_ENTREGA');
    ok(await setModule(s.admin, 'embalagem', true));
    // Recalcula (ex.: qualquer evento da peça) e continua pronta.
    expect(await k.stage(s.poltronas.id)).toBe('PRONTA_ENTREGA');
    const audit = await db().auditLog.findMany({
      where: { action: { startsWith: 'company.module' } },
    });
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('quem não gerencia a empresa não muda o interruptor', async () => {
    const s = await k.scenario();
    for (const c of [s.tablets.Thiago!, s.tablets.Ricardo!]) {
      const r = await c.req(
        'PUT',
        '/api/company/modules/embalagem',
        { enabled: false, version: 0 },
        { 'idempotency-key': idemKey() },
      );
      expect([401, 403]).toContain(r.status);
    }
    expect(await db().moduleSetting.count({ where: { key: 'embalagem' } })).toBe(0);
  });
});
