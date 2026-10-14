import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SIMPLIFIED_PRODUCTION_TEMPLATES, type ProductionTemplateDto } from '@cenario/shared';
import { runSeed } from '@cenario/db/seed';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
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
 * Simplificação Fase 5 — modelos de produção simplificados (CA5-01 a CA5-06; D6, D7, D14).
 * O banco de teste é zerado e recebe o seed (só os modelos antigos); os modelos simplificados
 * entram pelos MESMOS comandos da migration `20261230000000_modelos_simplificados` e o seed é
 * repetido (como no procedimento de publicação: migrate → seed), preenchendo João e Thiago
 * como responsáveis padrão das etapas de preparação. Equipe do seed: Ricardo e Márcio
 * (tapeceiros), João (ajudante), Thiago (cabeceiras/qualidade, SEM corte e costura).
 */
const DB = resolve(__dirname, '../../../packages/db');
const MIGRATION = '20261230000000_modelos_simplificados';
const migrationInserts = readFileSync(
  resolve(DB, `prisma/migrations/${MIGRATION}/migration.sql`),
  'utf8',
)
  .replace(/--.*$/gm, '')
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter((s) => s.startsWith('INSERT'));
const [REFORMA, CABECEIRA] = SIMPLIFIED_PRODUCTION_TEMPLATES.map((t) => t.id) as [string, string];

let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  expect(migrationInserts).toHaveLength(2);
  for (const st of migrationInserts) await db().$executeRawUnsafe(st);
  await runSeed({ withTeam: true, log: () => undefined });
});

const post = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.post(url, body, { 'idempotency-key': key });

async function team() {
  return {
    ricardo: await userIdOf('Ricardo'),
    marcio: await userIdOf('Márcio'),
    joao: await userIdOf('João'),
    thiago: await userIdOf('Thiago'),
    andre: await userIdOf('André'),
  };
}

/** OS aberta (peças recebidas) com as peças pedidas. */
async function os(
  admin: Client,
  name: string,
  pieces: { pieceType: string; description: string; serviceType: string }[],
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
      serviceType: pieces[k]!.serviceType,
    })),
  });
  expect(so.status).toBe(201);
  const items = (so.body.items as { id: string; position: number }[]).sort(
    (a, b) => a.position - b.position,
  );
  return { id: so.body.id as string, items };
}

/** Tarefas da peça (vivas), na ordem das etapas do modelo. */
const tasksOf = (itemId: string) =>
  db().productionTask.findMany({
    where: { serviceOrderItemId: itemId, status: { not: 'CANCELADA' } },
    include: { dependsOn: true },
    orderBy: { templateStepPosition: 'asc' },
  });

const dist = async (admin: Client, planId: string) =>
  (await admin.get(`/api/v1/production-plans/${planId}/distribution`)).body as {
    pieces: {
      item: { id: string };
      template: { id: string; name: string } | null;
      pendencies: { kind: string }[];
    }[];
  };

const templates = async (admin: Client) =>
  (await admin.get('/api/v1/production-templates')).body as ProductionTemplateDto[];

/** Corpo de gravação de um modelo a partir do DTO, com alterações. */
function templateBody(
  t: ProductionTemplateDto,
  patch: Partial<{ active: boolean; serviceTypes: string[] }> = {},
  stepPatch: (s: ProductionTemplateDto['steps'][number]) => Record<string, unknown> = () => ({}),
) {
  return {
    name: t.name,
    pieceTypes: t.pieceTypes,
    serviceTypes: t.serviceTypes,
    active: t.active,
    version: t.version,
    ...patch,
    steps: t.steps.map((s) => ({
      activity: s.activity,
      name: s.name,
      role: s.role,
      requiresMaterials: s.requiresMaterials,
      optional: s.optional,
      dependsOn: s.dependsOn,
      completionRequirement: s.completionRequirement,
      stepClass: s.stepClass,
      defaultAssigneeUserId: s.defaultAssignee?.userId ?? null,
      ...stepPatch(s),
    })),
  };
}

/** Competências atuais (mecanismo existente de competências). */
async function setSkills(admin: Client, name: string, change: (s: string[]) => string[]) {
  const e = await db().employee.findFirstOrThrow({
    where: { displayName: name },
    include: { skills: true },
  });
  const r = await admin.put(`/api/v1/employees/${e.id}/skills`, {
    skills: change(e.skills.map((s) => s.skill)),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

describe('Modelos simplificados (Simplificação Fase 5)', () => {
  it('CA5-01: reforma de sofá gera exatamente 3 tarefas — João, titular, titular — sem distribuição manual', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const so = await os(admin, 'Cliente Reforma', [
      { pieceType: 'SOFA', description: 'Sofá reforma', serviceType: 'REFORMA_COMPLETA' },
      { pieceType: 'SOFA', description: 'Sofá troca de tecido', serviceType: 'TROCA_DE_TECIDO' },
    ]);
    const [reforma, troca] = so.items;
    const plan = await createPlan(admin, today(), 'FILA_SEMANAL');
    const r = await addOs(admin, plan.id, {
      serviceOrderId: so.id,
      pieces: [
        { serviceOrderItemId: reforma!.id, upholstererUserId: p.ricardo },
        { serviceOrderItemId: troca!.id, upholstererUserId: p.marcio },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const t = await tasksOf(reforma!.id);
    expect(t).toHaveLength(3);
    expect(t.map((x) => [x.activity, x.stepClass, x.assigneeUserId])).toEqual([
      ['DESMONTAGEM', 'PREPARACAO', p.joao],
      ['CORTE_TECIDO', 'TAPECARIA', p.ricardo],
      ['MONTAGEM', 'TAPECARIA', p.ricardo],
    ]);
    expect(t.map((x) => x.title.split(' — ')[0])).toEqual([
      'Desmontagem e preparação',
      'Corte e costura',
      'Montagem e acabamento',
    ]);
    expect(t.every((x) => x.templateId === REFORMA && x.templateVersion === 1)).toBe(true);
    expect(t.every((x) => x.status === 'RASCUNHO')).toBe(true);
    // Montagem e acabamento depende da preparação e do corte e costura da MESMA peça.
    expect(t[2]!.dependsOn.map((d) => d.dependsOnId).sort()).toEqual([t[0]!.id, t[1]!.id].sort());
    // Regressão: troca de tecido não tem modelo simplificado → modelo antigo (6 etapas).
    const legacy = await tasksOf(troca!.id);
    expect(legacy).toHaveLength(6);
    expect(legacy.every((x) => x.templateId && x.templateId !== REFORMA)).toBe(true);
    const d = await dist(admin, plan.id);
    const piece = d.pieces.find((x) => x.item.id === reforma!.id)!;
    expect(piece.template?.id).toBe(REFORMA);
    expect(piece.pendencies).toEqual([]);
    // Pré-planejamento mostra o mesmo modelo (mesma regra de escolha).
    const pipeline = (await admin.get('/api/v1/production/pipeline')).body as {
      items: { pieces: { id: string; template: string | null; needsUpholsterer: boolean }[] }[];
    };
    const shown = pipeline.items.flatMap((s) => s.pieces);
    expect(shown.find((x) => x.id === reforma!.id)).toMatchObject({
      template: SIMPLIFIED_PRODUCTION_TEMPLATES[0]!.name,
      needsUpholsterer: true,
    });
    expect(shown.find((x) => x.id === troca!.id)?.template).toBe('Reforma de sofá');
    // Uma reforma de canto alemão também usa o modelo simplificado.
    const canto = await os(admin, 'Cliente Canto', [
      { pieceType: 'CANTO_ALEMAO', description: 'Canto', serviceType: 'REFORMA_COMPLETA' },
    ]);
    expect(
      (
        await addOs(admin, plan.id, {
          serviceOrderId: canto.id,
          pieces: [{ serviceOrderItemId: canto.items[0]!.id, upholstererUserId: p.marcio }],
        })
      ).status,
    ).toBe(201);
    expect((await tasksOf(canto.items[0]!.id)).map((x) => x.assigneeUserId)).toEqual([
      p.joao,
      p.marcio,
      p.marcio,
    ]);
  });

  it('CA5-02: cabeceira gera 2 tarefas — Thiago prepara; tapeçaria do titular (Thiago só por competência, D7)', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const plan = await createPlan(admin, today(), 'FILA_SEMANAL');
    const cab = async (name: string) =>
      (
        await os(admin, name, [
          { pieceType: 'CABECEIRA', description: name, serviceType: 'FABRICACAO' },
        ])
      ).items[0]!;
    // Titular Ricardo: Thiago prepara, Ricardo faz a tapeçaria.
    const a = await cab('Cabeceira Ricardo');
    const soA = (await db().serviceOrderItem.findUniqueOrThrow({ where: { id: a.id } }))
      .serviceOrderId;
    expect(
      (
        await addOs(admin, plan.id, {
          serviceOrderId: soA,
          pieces: [{ serviceOrderItemId: a.id, upholstererUserId: p.ricardo }],
        })
      ).status,
    ).toBe(201);
    const ta = await tasksOf(a.id);
    expect(ta.map((x) => [x.activity, x.assigneeUserId])).toEqual([
      ['PREPARACAO_MDF', p.thiago],
      ['REVESTIMENTO', p.ricardo],
    ]);
    expect(ta.every((x) => x.templateId === CABECEIRA)).toBe(true);
    // Thiago titular SEM a competência de corte e costura: recusado (nenhuma regra fixa no código).
    const b = await cab('Cabeceira Thiago');
    const soB = (await db().serviceOrderItem.findUniqueOrThrow({ where: { id: b.id } }))
      .serviceOrderId;
    const denied = await addOs(admin, plan.id, {
      serviceOrderId: soB,
      pieces: [{ serviceOrderItemId: b.id, upholstererUserId: p.thiago }],
    });
    expect(denied.status).toBe(422);
    expect(denied.body.error.message).toMatch(/tapeceiro ativo/);
    expect(await tasksOf(b.id)).toHaveLength(0);
    // D7: o gestor concede CORTE_COSTURA pelo cadastro de competências → Thiago faz as duas.
    await setSkills(admin, 'Thiago', (s) => [...s, 'CORTE_COSTURA']);
    expect(
      (
        await addOs(admin, plan.id, {
          serviceOrderId: soB,
          pieces: [{ serviceOrderItemId: b.id, upholstererUserId: p.thiago }],
        })
      ).status,
    ).toBe(201);
    expect((await tasksOf(b.id)).map((x) => [x.activity, x.assigneeUserId])).toEqual([
      ['PREPARACAO_MDF', p.thiago],
      ['REVESTIMENTO', p.thiago],
    ]);
    // Márcio titular: mesma divisão do Ricardo.
    const c = await cab('Cabeceira Márcio');
    const soC = (await db().serviceOrderItem.findUniqueOrThrow({ where: { id: c.id } }))
      .serviceOrderId;
    await addOs(admin, plan.id, {
      serviceOrderId: soC,
      pieces: [{ serviceOrderItemId: c.id, upholstererUserId: p.marcio }],
    });
    expect((await tasksOf(c.id)).map((x) => x.assigneeUserId)).toEqual([p.thiago, p.marcio]);
    // Cabeceira em REPARO não tem modelo simplificado → modelo antigo (fallback).
    const rep = await os(admin, 'Cabeceira reparo', [
      { pieceType: 'CABECEIRA', description: 'Reparo', serviceType: 'REPARO' },
    ]);
    await addOs(admin, plan.id, {
      serviceOrderId: rep.id,
      pieces: [{ serviceOrderItemId: rep.items[0]!.id, upholstererUserId: p.ricardo }],
    });
    expect(await tasksOf(rep.items[0]!.id)).toHaveLength(5);
  });

  it('responsável por etapa: precedência sobre o global, inelegível vira pendência, sem responsável próprio vale o global', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const plan = await createPlan(admin, today(), 'FILA_SEMANAL');
    const add = async (name: string, pieceType: string, serviceType: string) => {
      const s = await os(admin, name, [{ pieceType, description: name, serviceType }]);
      const r = await addOs(admin, plan.id, {
        serviceOrderId: s.id,
        pieces: [{ serviceOrderItemId: s.items[0]!.id, upholstererUserId: p.ricardo }],
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return s.items[0]!.id;
    };
    // Global = Thiago; a etapa da reforma tem João próprio → João (a etapa vence).
    expect(
      (
        await admin.put('/api/v1/production/distribution-settings', {
          preparationAssigneeUserId: p.thiago,
        })
      ).status,
    ).toBe(200);
    expect((await tasksOf(await add('R1', 'SOFA', 'REFORMA_COMPLETA')))[0]!.assigneeUserId).toBe(
      p.joao,
    );
    // Sem responsável próprio na etapa → vale o global (Thiago).
    const reforma = (await templates(admin)).find((t) => t.id === REFORMA)!;
    const cleared = await admin.put(
      `/api/v1/production-templates/${REFORMA}`,
      templateBody(reforma, {}, () => ({ defaultAssigneeUserId: null })),
    );
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect((await tasksOf(await add('R2', 'SOFA', 'REFORMA_COMPLETA')))[0]!.assigneeUserId).toBe(
      p.thiago,
    );
    // Responsável próprio inelegível (Thiago sem a competência de preparação): pendência visível,
    // nunca outra pessoa no lugar (nem o global, nem o único ajudante).
    await setSkills(admin, 'Thiago', (s) => s.filter((x) => x !== 'PREPARACAO'));
    const item = await add('C1', 'CABECEIRA', 'FABRICACAO');
    const t = await tasksOf(item);
    expect(t[0]!.assigneeUserId).toBeNull();
    expect(t[1]!.assigneeUserId).toBe(p.ricardo);
    const piece = (await dist(admin, plan.id)).pieces.find((x) => x.item.id === item)!;
    expect(piece.pendencies.map((x) => x.kind)).toContain('SEM_RESPONSAVEL_PADRAO');
    // A competência volta: reprocessar completa o responsável (nunca troca um já gravado).
    await setSkills(admin, 'Thiago', (s) => [...s, 'PREPARACAO']);
    const planItem = await db().productionPlanItem.findFirstOrThrow({
      where: { planId: plan.id, serviceOrder: { items: { some: { id: item } } } },
    });
    expect(
      (await post(admin, `/api/v1/production-plans/${plan.id}/items/${planItem.id}/distribute`, {}))
        .status,
    ).toBe(200);
    expect((await tasksOf(item)).map((x) => x.assigneeUserId)).toEqual([p.thiago, p.ricardo]);
  });

  it('cadastro do modelo: tipos de serviço e responsável por etapa validados; inativo não é escolhido (D6)', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const list = await templates(admin);
    const reforma = list.find((t) => t.id === REFORMA)!;
    expect(reforma.serviceTypes).toEqual(['REFORMA_COMPLETA']);
    expect(reforma.steps.map((s) => s.defaultAssignee?.displayName ?? null)).toEqual([
      'João',
      null,
      null,
    ]);
    // Antigos continuam listados, gerais (sem tipo de serviço) e intactos.
    expect(
      list
        .filter((t) => t.serviceTypes.length === 0)
        .map((t) => t.name)
        .sort(),
    ).toEqual(['Cabeceira', 'Cadeira ou poltrona', 'Reforma de sofá']);
    // Tapeçaria com responsável padrão: recusado (titular da peça).
    const bad = await admin.put(
      `/api/v1/production-templates/${REFORMA}`,
      templateBody(reforma, {}, (s) =>
        s.stepClass === 'TAPECARIA' ? { defaultAssigneeUserId: p.marcio } : {},
      ),
    );
    expect(bad.status).toBe(400);
    // Classe derivada (sem classe explícita) também é conferida no servidor.
    const derived = await admin.put(
      `/api/v1/production-templates/${REFORMA}`,
      templateBody(reforma, {}, (s) =>
        s.stepClass === 'TAPECARIA'
          ? { stepClass: undefined, defaultAssigneeUserId: p.marcio }
          : {},
      ),
    );
    expect(derived.status).toBe(400);
    // Quem não executa produção (logística) não pode ser responsável padrão.
    const notWorker = await admin.put(
      `/api/v1/production-templates/${REFORMA}`,
      templateBody(reforma, {}, (s) =>
        s.stepClass === 'PREPARACAO' ? { defaultAssigneeUserId: p.andre } : {},
      ),
    );
    expect(notWorker.status).toBe(422);
    expect((await templates(admin)).find((t) => t.id === REFORMA)!.version).toBe(1);
    // Inativo: nova geração volta ao modelo geral (antigo).
    expect(
      (
        await admin.put(
          `/api/v1/production-templates/${REFORMA}`,
          templateBody(reforma, { active: false }),
        )
      ).status,
    ).toBe(200);
    const so = await os(admin, 'Cliente Inativo', [
      { pieceType: 'SOFA', description: 'Sofá', serviceType: 'REFORMA_COMPLETA' },
    ]);
    const plan = await createPlan(admin, today(), 'FILA_SEMANAL');
    await addOs(admin, plan.id, {
      serviceOrderId: so.id,
      pieces: [{ serviceOrderItemId: so.items[0]!.id, upholstererUserId: p.ricardo }],
    });
    const t = await tasksOf(so.items[0]!.id);
    expect(t).toHaveLength(6);
    expect(t.every((x) => x.templateId !== REFORMA)).toBe(true);
    // Escolha explícita de modelo inativo é recusada (regra existente).
    const so2 = await os(admin, 'Cliente Explícito', [
      { pieceType: 'SOFA', description: 'Sofá', serviceType: 'REFORMA_COMPLETA' },
    ]);
    const explicit = await addOs(admin, plan.id, {
      serviceOrderId: so2.id,
      pieces: [
        { serviceOrderItemId: so2.items[0]!.id, upholstererUserId: p.ricardo, templateId: REFORMA },
      ],
    });
    expect(explicit.status).toBe(422);
    expect(await tasksOf(so2.items[0]!.id)).toHaveLength(0);
  });

  it('CA5-04: serviço em andamento mantém o modelo e as tarefas originais com os novos modelos ativos', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    // Antes da Fase 5 (simplificado inativo): a OS nasce no modelo antigo e começa a ser feita.
    const reforma = (await templates(admin)).find((t) => t.id === REFORMA)!;
    await admin.put(
      `/api/v1/production-templates/${REFORMA}`,
      templateBody(reforma, { active: false }),
    );
    const so = await os(admin, 'Cliente Em Andamento', [
      { pieceType: 'SOFA', description: 'Sofá', serviceType: 'REFORMA_COMPLETA' },
    ]);
    const item = so.items[0]!.id;
    const plan = await createPlan(admin, day(-1), 'FILA_SEMANAL');
    await addOs(admin, plan.id, {
      serviceOrderId: so.id,
      pieces: [{ serviceOrderItemId: item, upholstererUserId: p.ricardo }],
    });
    await publish(admin, (await admin.get(`/api/v1/production-plans/${plan.id}`)).body);
    const before = await tasksOf(item);
    expect(before).toHaveLength(6);
    const joao = await tabletOf(app, admin, 'João', '271828');
    const desm = before.find((t) => t.activity === 'DESMONTAGEM')!;
    expect((await act(joao, desm.id, 'start')).status).toBe(200);
    // Fase 5 ativada.
    const now = (await templates(admin)).find((t) => t.id === REFORMA)!;
    expect(
      (
        await admin.put(
          `/api/v1/production-templates/${REFORMA}`,
          templateBody(now, { active: true }),
        )
      ).status,
    ).toBe(200);
    // Reprocessar (inclusive pedindo troca de modelo com motivo) não mexe no serviço iniciado.
    const planItem = await db().productionPlanItem.findFirstOrThrow({ where: { planId: plan.id } });
    const url = `/api/v1/production-plans/${plan.id}/items/${planItem.id}/distribute`;
    expect((await post(admin, url, {})).status).toBe(200);
    expect(
      (await post(admin, url, { regenerate: true, reason: 'Adotar modelo novo' })).status,
    ).toBe(200);
    const after = await tasksOf(item);
    const pick = (t: typeof after) =>
      t.map((x) => [x.id, x.templateId, x.templateVersion, x.assigneeUserId, x.status]);
    expect(pick(after)).toEqual(
      pick(before).map((x) => (x[0] === desm.id ? [...x.slice(0, 4), 'EM_EXECUCAO'] : x)),
    );
    expect(after.some((x) => x.templateId === REFORMA)).toBe(false);
    const piece = (await dist(admin, plan.id)).pieces.find((x) => x.item.id === item)!;
    expect(piece.template?.id).not.toBe(REFORMA);
    expect(piece.pendencies.map((x) => x.kind)).not.toContain('MODELO_ALTERADO');
    // Um serviço NOVO, no mesmo plano, já usa o modelo simplificado.
    const novo = await os(admin, 'Cliente Novo', [
      { pieceType: 'SOFA', description: 'Sofá', serviceType: 'REFORMA_COMPLETA' },
    ]);
    const added = await addOs(admin, plan.id, {
      serviceOrderId: novo.id,
      pieces: [{ serviceOrderItemId: novo.items[0]!.id, upholstererUserId: p.marcio }],
      reason: 'Serviço novo na semana publicada',
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const nt = await tasksOf(novo.items[0]!.id);
    expect(nt).toHaveLength(3);
    expect(nt.every((x) => x.templateId === REFORMA)).toBe(true);
  });

  it('CA5-05: mão de obra por peça inalterada (D14): mesmos valores e regras com o modelo novo e o antigo', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const payables = () => db().productionPayable.findMany({ orderBy: { createdAt: 'asc' } });
    const so = await os(admin, 'Cliente Mão de Obra', [
      { pieceType: 'SOFA', description: 'Sofá novo modelo', serviceType: 'REFORMA_COMPLETA' },
      { pieceType: 'SOFA', description: 'Sofá modelo antigo', serviceType: 'TROCA_DE_TECIDO' },
      { pieceType: 'CABECEIRA', description: 'Cabeceira', serviceType: 'FABRICACAO' },
    ]);
    const [novo, antigo, cab] = so.items;
    await setSkills(admin, 'Thiago', (s) => [...s, 'CORTE_COSTURA']);
    const plan = await createPlan(admin, today(), 'FILA_SEMANAL');
    expect(
      (
        await addOs(admin, plan.id, {
          serviceOrderId: so.id,
          pieces: [
            { serviceOrderItemId: novo!.id, upholstererUserId: p.ricardo },
            { serviceOrderItemId: antigo!.id, upholstererUserId: p.ricardo },
            { serviceOrderItemId: cab!.id, upholstererUserId: p.thiago },
          ],
        })
      ).status,
    ).toBe(201);
    expect((await tasksOf(novo!.id)).length).toBe(3);
    expect((await tasksOf(antigo!.id)).length).toBe(6);
    // Gerar tarefas não cria nem altera valor algum.
    expect(await payables()).toEqual([]);
    const labor = (itemId: string, who: string) =>
      post(admin, '/api/v1/finance/labor', {
        professionalUserId: who,
        serviceOrderId: so.id,
        serviceOrderItemId: itemId,
        service: 'Mão de obra',
        agreedCents: 80000,
        eligibility: 'QUALIDADE_APROVADA',
      });
    expect((await labor(novo!.id, p.ricardo)).status).toBe(201);
    expect((await labor(antigo!.id, p.ricardo)).status).toBe(201);
    const [n, a] = await payables();
    const same = (x: typeof n) => ({
      professionalUserId: x!.professionalUserId,
      agreedCents: x!.agreedCents,
      status: x!.status,
      eligibility: x!.eligibility,
    });
    expect(same(n)).toEqual(same(a));
    expect(same(n)).toMatchObject({ professionalUserId: p.ricardo, agreedCents: 80000 });
    // Regras de remuneração inalteradas: valor por peça só com o titular; Thiago (titular da
    // cabeceira por competência) e João (preparação) seguem na equipe de remuneração fixa.
    const marcio = await labor(novo!.id, p.marcio);
    expect(marcio.status).toBe(422);
    expect(marcio.body.error.message).toMatch(/titular/);
    for (const who of [p.thiago, p.joao]) {
      const r = await labor(cab!.id, who);
      expect(r.status).toBe(422);
      expect(r.body.error.message).toMatch(/remuneração fixa/);
    }
    expect(await payables()).toHaveLength(2);
  });

  it('CA5-06: geração repetida e concorrente não duplica tarefas (proteção do banco preservada)', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const so = await os(admin, 'Cliente Concorrência', [
      { pieceType: 'SOFA', description: 'Sofá', serviceType: 'REFORMA_COMPLETA' },
      { pieceType: 'CABECEIRA', description: 'Cabeceira', serviceType: 'FABRICACAO' },
    ]);
    const plan = await createPlan(admin, today(), 'FILA_SEMANAL');
    expect(
      (
        await addOs(admin, plan.id, {
          serviceOrderId: so.id,
          pieces: [
            { serviceOrderItemId: so.items[0]!.id, upholstererUserId: p.ricardo },
            { serviceOrderItemId: so.items[1]!.id, upholstererUserId: p.marcio },
          ],
        })
      ).status,
    ).toBe(201);
    const snap = () =>
      db().productionTask.findMany({
        where: { serviceOrderId: so.id },
        orderBy: { id: 'asc' },
        select: { id: true, assigneeUserId: true, version: true, templateId: true },
      });
    const before = await snap();
    expect(before).toHaveLength(5);
    const planItem = await db().productionPlanItem.findFirstOrThrow({ where: { planId: plan.id } });
    const url = `/api/v1/production-plans/${plan.id}/items/${planItem.id}/distribute`;
    expect((await post(admin, url, {})).status).toBe(200);
    const both = await Promise.all([
      post(admin, url, {}),
      post(admin, url, {}),
      post(admin, url, {}),
    ]);
    expect(both.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await snap()).toEqual(before);
    // A mesma OS em outra semana, duas vezes ao mesmo tempo: uma vence; nada é gerado de novo.
    const p2 = await createPlan(admin, day(7), 'FILA_SEMANAL');
    const twice = await Promise.all([
      addOs(admin, p2.id, { serviceOrderId: so.id }),
      addOs(admin, p2.id, { serviceOrderId: so.id }),
    ]);
    expect(twice.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await snap()).toEqual(before);
    // Índice único parcial (peça + modelo + etapa) recusa a duplicata direto no banco.
    const t = await db().productionTask.findFirstOrThrow({ where: { templateId: REFORMA } });
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
    // Reversão da migration bloqueada: há tarefas geradas pelos modelos simplificados.
    const down = readFileSync(resolve(DB, `rollback/${MIGRATION}.down.sql`), 'utf8');
    const guard = down.slice(down.indexOf('DO $$'), down.indexOf('END $$;') + 'END $$'.length);
    await expect(db().$executeRawUnsafe(guard)).rejects.toThrow(/Reversão bloqueada: 5 tarefa/);
  });
});

describe('Seed dos modelos simplificados (responsável inicial da preparação)', () => {
  const stepsOf = async () =>
    (
      await db().productionTemplateStep.findMany({
        select: { templateId: true, position: true, defaultAssigneeUserId: true },
        orderBy: [{ templateId: 'asc' }, { position: 'asc' }],
      })
    ).map((s) => `${s.templateId}:${s.position}:${s.defaultAssigneeUserId ?? '-'}`);
  const firstStep = async (templateId: string) =>
    db().productionTemplateStep.findUniqueOrThrow({
      where: { templateId_position: { templateId, position: 1 } },
    });
  /** Instalação recém-migrada: etapa vazia e modelo na versão 1 (como sai da migration). */
  const resetToMigrated = (templateId: string) =>
    db().productionTemplateStep.update({
      where: { templateId_position: { templateId, position: 1 } },
      data: { defaultAssigneeUserId: null },
    });
  const seed = async (withTeam = true) => {
    const logs: string[] = [];
    await runSeed({ withTeam, log: (m) => logs.push(m) });
    return logs;
  };

  it('modelo novo, não editado e vazio: aplica João e Thiago; repetir o seed não muda nada; antigos sem responsável', async () => {
    const p = await team();
    expect((await firstStep(REFORMA)).defaultAssigneeUserId).toBe(p.joao);
    expect((await firstStep(CABECEIRA)).defaultAssigneeUserId).toBe(p.thiago);
    const before = await stepsOf();
    await seed();
    await seed();
    expect(await stepsOf()).toEqual(before);
    expect(
      await db().productionTemplateStep.count({
        where: {
          templateId: { notIn: [REFORMA, CABECEIRA] },
          defaultAssigneeUserId: { not: null },
        },
      }),
    ).toBe(0);
    expect(
      (await db().productionTemplate.findMany({ where: { id: { in: [REFORMA, CABECEIRA] } } })).map(
        (t) => t.version,
      ),
    ).toEqual([1, 1]);
  });

  it('modelo editado pelo gestor: etapa vazia continua vazia e responsável diferente é preservado', async () => {
    const admin = await loginAdmin(app);
    const p = await team();
    const list = await templates(admin);
    // Reforma: o gestor esvazia a etapa (decisão: usar o responsável global).
    const reforma = list.find((t) => t.id === REFORMA)!;
    expect(
      (
        await admin.put(
          `/api/v1/production-templates/${REFORMA}`,
          templateBody(reforma, {}, () => ({ defaultAssigneeUserId: null })),
        )
      ).status,
    ).toBe(200);
    // Cabeceira: o gestor troca o responsável da preparação pelo João.
    const cab = list.find((t) => t.id === CABECEIRA)!;
    expect(
      (
        await admin.put(
          `/api/v1/production-templates/${CABECEIRA}`,
          templateBody(cab, {}, (s) =>
            s.stepClass === 'PREPARACAO' ? { defaultAssigneeUserId: p.joao } : {},
          ),
        )
      ).status,
    ).toBe(200);
    const before = await stepsOf();
    for (let i = 0; i < 3; i++) await seed();
    expect(await stepsOf()).toEqual(before);
    expect((await firstStep(REFORMA)).defaultAssigneeUserId).toBeNull();
    expect((await firstStep(CABECEIRA)).defaultAssigneeUserId).toBe(p.joao);
  });

  it('funcionário ausente ou com nome repetido: nada é configurado (sem escolha arbitrária) e o motivo é registrado', async () => {
    const p = await team();
    // Ausente: o João passa a se chamar de outro jeito (seed sem cadastro de equipe).
    await resetToMigrated(REFORMA);
    await db().employee.update({ where: { userId: p.joao }, data: { displayName: 'João Pedro' } });
    const absent = await seed(false);
    expect((await firstStep(REFORMA)).defaultAssigneeUserId).toBeNull();
    expect(absent.join('\n')).toMatch(/nenhum funcionário ativo chamado João/);
    // Repetido: dois funcionários ativos chamados Thiago.
    await resetToMigrated(CABECEIRA);
    const role = await db().role.findUniqueOrThrow({ where: { key: 'cabeceiras_qualidade' } });
    await db().user.create({
      data: {
        displayName: 'Thiago',
        roles: { create: { roleId: role.id } },
        employee: {
          create: {
            fullName: 'Thiago Segundo',
            displayName: 'Thiago',
            jobTitle: 'Cabeceiras',
            color: '#111111',
          },
        },
      },
    });
    const twice = await seed(false);
    expect((await firstStep(CABECEIRA)).defaultAssigneeUserId).toBeNull();
    expect(twice.join('\n')).toMatch(/mais de um funcionário ativo chamado Thiago/);
    // Com um único João novamente, a configuração inicial é aplicada (modelo ainda na versão 1).
    await db().employee.update({ where: { userId: p.joao }, data: { displayName: 'João' } });
    await seed(false);
    expect((await firstStep(REFORMA)).defaultAssigneeUserId).toBe(p.joao);
    expect((await firstStep(CABECEIRA)).defaultAssigneeUserId).toBeNull();
  });
});
