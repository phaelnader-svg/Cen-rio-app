import { MODULE_KEYS, READINESS_CHECKS } from '@cenario/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { MANAGE_PERMISSIONS } from '../src/modules/attachments/policy';
import { type Client, createTestApp, db, idemKey, resetDatabase } from './helpers';
import { post, qualityKit } from './quality-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/**
 * Reformulação por remoção real — S1: a embalagem deixou de existir como etapa. Aprovada na
 * qualidade, a peça fica "pronta para entrega"; não há registro nem tarefa de embalagem, nem
 * interruptor, nem rotas. O histórico antigo (registros, tarefas e linha do interruptor) fica
 * intacto e não impede nada. Banco descartável, dados fictícios.
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
const putModule = (c: Client, key: string, enabled: boolean, version = 0) =>
  c.req(
    'PUT',
    `/api/company/modules/${key}`,
    { enabled, version },
    { 'idempotency-key': idemKey() },
  );

describe('S1 — produção → qualidade → entrega sem embalagem', () => {
  it('aprovada vai direto a "pronta para entrega"; sem embalagem; financeiro na hora certa', async () => {
    const s = await k.scenario();
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
    const status = async (id: string) =>
      (await db().productionPayable.findUniqueOrThrow({ where: { id } })).status;

    // 1. Produção concluída → qualidade (inspeção criada), nada de embalagem.
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    expect(await k.stage(s.sofa.id)).toBe('AGUARDANDO_INSPECAO');
    expect(await status(laborQ.id)).toBe('PREVISTO');
    const insp = await k.approveOpen(s, s.sofa.id);
    const row = await db().qualityInspection.findUniqueOrThrow({ where: { id: insp.id } });
    expect(row.packagingRequired).toBe(false);
    expect(await db().packagingRecord.count()).toBe(0);
    expect(await db().productionTask.count({ where: { activity: 'EMBALAGEM' } })).toBe(0);
    expect(await k.stage(s.sofa.id)).toBe('PRONTA_ENTREGA');
    const piece = ok(await s.admin.get(`/api/v1/pieces/${s.sofa.id}`));
    expect(piece.readiness).toEqual({ ready: true, missing: [] });
    expect(piece).not.toHaveProperty('packaging');
    expect(
      await db().notification.count({
        where: { kind: 'PRONTO_ENTREGA', dedupeKey: { contains: s.sofa.id } },
      }),
    ).toBe(1);
    expect(await db().notification.count({ where: { kind: 'EMBALAGEM_LIBERADA' } })).toBe(0);
    // Mão de obra: a da aprovação liberada; a da entrega, não.
    expect(await status(laborQ.id)).toBe('LIBERADO');
    expect(await status(laborE.id)).toBe('PREVISTO');
    expect(
      ok(await s.admin.get(`/api/v1/finance/receivables/${rec.id}`)).effectiveDueDate,
    ).toBeNull();

    // 2. Poltronas: o bloqueio legítimo continua — sem qualidade aprovada, a OS não é entregue.
    const elig = ok(await s.admin.get(`/api/v1/service-orders/${s.so.id}/direct-delivery`));
    expect(elig.eligible).toBe(false);
    expect(JSON.stringify(elig.blocks)).not.toMatch(/embalag/i);
    await k.finish(s.tablets.Márcio!, s.poltronaTask.id);
    await k.approveOpen(s, s.poltronas.id);
    expect(await k.stage(s.poltronas.id)).toBe('PRONTA_ENTREGA');

    // 3. Conclusão do serviço sem embalagem: entrega libera a mão de obra e vence a cobrança.
    expect(
      ok(await s.admin.get(`/api/v1/service-orders/${s.so.id}/direct-delivery`)),
    ).toMatchObject({
      eligible: true,
      blocks: [],
    });
    ok(
      await post(s.admin, `/api/v1/service-orders/${s.so.id}/deliver`, { note: 'Cliente buscou' }),
    );
    expect(await k.stage(s.sofa.id)).toBe('ENTREGUE');
    expect(await k.stage(s.poltronas.id)).toBe('ENTREGUE');
    expect(await status(laborE.id)).toBe('LIBERADO');
    expect(
      ok(await s.admin.get(`/api/v1/finance/receivables/${rec.id}`)).effectiveDueDate,
    ).not.toBeNull();
    expect(await db().packagingRecord.count()).toBe(0);
    // Nenhuma tarefa de embalagem nasceu em nenhum momento (o modelo e a qualidade não criam).
    expect(await db().productionTask.count({ where: { activity: 'EMBALAGEM' } })).toBe(0);
  });

  it('não há interruptor, condição de prontidão nem rotas de embalagem', async () => {
    const s = await k.scenario();
    expect(MODULE_KEYS as readonly string[]).not.toContain('embalagem');
    expect(READINESS_CHECKS as readonly string[]).not.toContain('EMBALAGEM');
    const mods = ok<{ key: string }[]>(await s.admin.get('/api/company/modules'));
    expect(mods.map((m) => m.key)).not.toContain('embalagem');
    expect((await putModule(s.admin, 'embalagem', true)).status).toBe(404);
    expect(await db().moduleSetting.count({ where: { key: 'embalagem' } })).toBe(0);
    const id = '00000000-0000-4000-8000-000000000000';
    for (const [m, u] of [
      ['GET', '/api/v1/packaging'],
      ['GET', `/api/v1/packaging/${id}`],
      ['POST', `/api/v1/packaging/${id}/assign`],
      ['POST', `/api/v1/packaging/${id}/complete`],
      ['GET', '/api/v1/system/rollback-readiness'],
    ] as const)
      expect((await s.admin.req(m, u, m === 'POST' ? {} : undefined)).status, `${m} ${u}`).toBe(
        404,
      );
    // Fotos de embalagem antigas: só consulta (ninguém envia nem remove).
    expect(MANAGE_PERMISSIONS.PACKAGING).toEqual([]);
  });
});

describe('S1 — histórico antigo de embalagem (gravado antes da remoção)', () => {
  it('registro e tarefa antigos ficam intactos, não bloqueiam a entrega e a linha do interruptor é ignorada', async () => {
    const s = await k.scenario();
    await k.finish(s.tablets.Ricardo!, s.sofaTask.id);
    const insp = await k.approveOpen(s, s.sofa.id);
    await k.finish(s.tablets.Márcio!, s.poltronaTask.id);
    await k.approveOpen(s, s.poltronas.id);
    // Simula o que a versão anterior gravava: interruptor ligado, tarefa e registro pendentes,
    // peça gravada em "aguardando embalagem".
    await db().moduleSetting.create({ data: { key: 'embalagem', enabled: true } });
    const so = await db().serviceOrder.findUniqueOrThrow({ where: { id: s.so.id } });
    const task = await db().productionTask.create({
      data: {
        serviceOrderId: s.so.id,
        serviceOrderItemId: s.sofa.id,
        activity: 'EMBALAGEM',
        role: 'APOIO',
        title: 'Embalar sofá (versão anterior)',
        assigneeUserId: s.ids.joao,
        priority: so.priority,
        sequence: 9,
        scheduledAt: new Date(Date.now() - 60_000),
        requiresMaterials: false,
        inspectionId: insp.id,
        status: 'LIBERADA',
        blockers: [],
      },
    });
    const legacy = await db().packagingRecord.create({
      data: {
        serviceOrderItemId: s.sofa.id,
        serviceOrderId: s.so.id,
        inspectionId: insp.id,
        taskId: task.id,
        assigneeUserId: s.ids.joao,
      },
    });
    await db().serviceOrderItem.update({
      where: { id: s.sofa.id },
      data: { fulfillmentStage: 'AGUARDANDO_EMBALAGEM' },
    });
    const before = await db().packagingRecord.findUniqueOrThrow({ where: { id: legacy.id } });

    // OS antiga continua acessível; a peça aparece pronta (cálculo sem embalagem, nada gravado).
    ok(await s.admin.get(`/api/v1/service-orders/${s.so.id}`));
    ok(await s.admin.get(`/api/v1/service-orders/${s.so.id}/timeline`));
    const piece = ok(await s.admin.get(`/api/v1/pieces/${s.sofa.id}`));
    expect(piece.stage).toBe('PRONTA_ENTREGA');
    expect(piece.readiness.ready).toBe(true);
    expect(await k.stage(s.sofa.id)).toBe('AGUARDANDO_EMBALAGEM'); // leitura não grava
    // O interruptor antigo gravado é ignorado.
    const mods = ok<{ key: string }[]>(await s.admin.get('/api/company/modules'));
    expect(mods.map((m) => m.key)).not.toContain('embalagem');

    // A tarefa antiga conclui como qualquer outra, sem tela de embalagem.
    const joao = s.tablets['João']!;
    ok(await post(joao, `/api/v1/production-tasks/${task.id}/start`, {}));
    ok(await post(joao, `/api/v1/production-tasks/${task.id}/complete`, { note: 'Antiga' }));

    // A OS antiga é entregue normalmente; o registro antigo de embalagem não muda.
    const e = ok(await s.admin.get(`/api/v1/service-orders/${s.so.id}/direct-delivery`));
    expect(e).toMatchObject({ eligible: true, blocks: [] });
    ok(await post(s.admin, `/api/v1/service-orders/${s.so.id}/deliver`, { note: 'OS antiga' }));
    expect(await k.stage(s.sofa.id)).toBe('ENTREGUE');
    const after = await db().packagingRecord.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(after).toEqual(before);
    expect(await db().moduleSetting.count({ where: { key: 'embalagem' } })).toBe(1);
  });
});
