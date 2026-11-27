import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { type Client, createTestApp, db, resetDatabase } from './helpers';
import { post, qualityKit } from './quality-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/**
 * Reformulação, Fase 3 — qualidade simplificada ("Tudo conforme") e autoaprovação SÓ do gestor com
 * justificativa auditada e destacada (D4). A embalagem opcional desta fase foi removida de vez na
 * Reformulação S1 (ver remocao-s1-embalagem.test.ts). Banco descartável, dados fictícios.
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
    // Reformulação S1: sem embalagem — aprovada, a peça fica pronta para entrega.
    expect(await db().packagingRecord.count({ where: { serviceOrderItemId: s.sofa.id } })).toBe(0);
    expect(await k.stage(s.sofa.id)).toBe('PRONTA_ENTREGA');

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
