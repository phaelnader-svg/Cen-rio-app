import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { refreshOperationalAlerts } from '../src/modules/management/today';
import type { Client } from './helpers';
import {
  createTestApp,
  db,
  employeeByName,
  idemKey,
  loginAdmin,
  naEmpresa1,
  resetDatabase,
} from './helpers';
import { openServiceOrder } from './measurement-helpers';
import { createPlan, addOs, publish, userIdOf } from './production-helpers';

/**
 * Oficina sem tablet (2026-11-24): o gestor marca o andamento pela OS, um clique por etapa,
 * e cada clique grava pelos mesmos caminhos do tablet, da qualidade e da entrega.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterEach(() => setClock());
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
});

const step = (c: Client, id: string, body: Record<string, unknown>) =>
  c.post(`/api/v1/service-orders/${id}/next-step`, body, { 'idempotency-key': idemKey() });

async function osWithLead(admin: Client, name = 'Cliente Sem Tablet') {
  const so = await openServiceOrder(admin, name);
  const ricardo = await employeeByName('Ricardo');
  const full = (await admin.get(`/api/v1/service-orders/${so.id}`)).body;
  const r = await admin.put(`/api/v1/service-orders/${so.id}`, {
    technicalInstructions: full.technicalInstructions,
    notes: full.notes,
    promisedDate: full.promisedDate,
    priority: full.priority,
    technicalLeadId: ricardo.id,
    reason: 'Tapeceiro da OS',
    version: full.version,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return so;
}

async function setModule(admin: Client, on: boolean) {
  const list = (await admin.get('/api/company/modules')).body as { key: string; version: number }[];
  const m = list.find((x) => x.key === 'oficina_sem_tablet')!;
  const r = await admin.put(
    `/api/company/modules/oficina_sem_tablet`,
    {
      enabled: on,
      version: m.version,
    },
    { 'idempotency-key': idemKey() },
  );
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

const listed = async (admin: Client, id: string) =>
  (
    (await admin.get('/api/v1/service-orders?status=ABERTA')).body.items as {
      id: string;
      nextStep: string | null;
      operationalState: string;
    }[]
  ).find((s) => s.id === id)!;

describe('botão da próxima etapa', () => {
  it('leva a OS de "Começou" até "Entregue" sem tablet, no nome do tapeceiro', async () => {
    const admin = await loginAdmin(app);
    await setModule(admin, true);
    const so = await osWithLead(admin);
    const ricardo = await userIdOf('Ricardo');
    expect((await listed(admin, so.id)).nextStep).toBe('COMECOU');

    let r = await step(admin, so.id, { step: 'COMECOU' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      done: 'COMECOU',
      next: 'PRONTA',
      state: 'EM_PRODUCAO',
      upholsterer: 'Ricardo',
    });
    const task = await db().productionTask.findFirstOrThrow({ where: { serviceOrderId: so.id } });
    expect(task).toMatchObject({
      title: 'Serviço completo',
      status: 'EM_EXECUCAO',
      assigneeUserId: ricardo,
    });
    const ev = await db().productionTaskEvent.findFirstOrThrow({
      where: { taskId: task.id, kind: 'INICIADA' },
    });
    expect(ev.note).toMatch(/Marcado por .* \(sem tablet\)/);

    // Clique repetido (duas abas): nada é gravado de novo.
    r = await step(admin, so.id, { step: 'COMECOU' });
    expect(r.body.done).toBeNull();

    r = await step(admin, so.id, { step: 'PRONTA' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      done: 'PRONTA',
      next: 'APROVADA',
      state: 'AGUARDANDO_QUALIDADE',
    });
    expect(r.body.photoTarget?.entityType).toBe('QUALITY_INSPECTION');
    const done = await db().productionTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(done).toMatchObject({ status: 'CONCLUIDA', completedById: ricardo });

    r = await step(admin, so.id, { step: 'APROVADA' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ done: 'APROVADA', next: 'SAIU', state: 'PRONTA_PARA_ENTREGA' });

    r = await step(admin, so.id, { step: 'SAIU' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ done: 'SAIU', next: 'ENTREGUE', state: 'EM_ENTREGA' });

    r = await step(admin, so.id, { step: 'ENTREGUE' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ done: 'ENTREGUE', next: null, state: 'ENTREGUE' });
    const d = await db().delivery.findFirstOrThrow({});
    expect(d).toMatchObject({ origin: 'DIRETA', status: 'CONCLUIDA' });
    expect(d.departedAt).not.toBeNull();
  });

  it('não pula etapa e respeita "Material comprado"', async () => {
    const admin = await loginAdmin(app);
    const so = await osWithLead(admin);
    const r = await step(admin, so.id, { step: 'APROVADA' });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/próxima etapa é "Começou"/);
    await db().serviceOrder.update({ where: { id: so.id }, data: { materialPurchasedAt: null } });
    expect((await listed(admin, so.id)).nextStep).toBeNull();
    const r2 = await step(admin, so.id, { step: 'COMECOU' });
    expect(r2.status).toBe(422);
    expect(r2.body.error.message).toMatch(/Material comprado/);
  });

  it('"Cliente buscou" entrega direto de "Pronta para entrega"', async () => {
    const admin = await loginAdmin(app);
    await setModule(admin, true);
    const so = await osWithLead(admin);
    for (const s of ['COMECOU', 'PRONTA', 'APROVADA'])
      expect((await step(admin, so.id, { step: s })).status).toBe(200);
    const r = await step(admin, so.id, { step: 'ENTREGUE', pickedUpByCustomer: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.state).toBe('ENTREGUE');
  });

  it('com a semana publicada, começa e termina as etapas planejadas (pausa a outra do tapeceiro)', async () => {
    const admin = await loginAdmin(app);
    await setModule(admin, true);
    const a = await osWithLead(admin, 'Cliente A');
    const b = await osWithLead(admin, 'Cliente B');
    const plan = await createPlan(admin, undefined, 'FILA_SEMANAL');
    const ricardo = await userIdOf('Ricardo');
    for (const so of [a, b]) {
      const r = await addOs(admin, plan.id, { serviceOrderId: so.id, upholstererUserId: ricardo });
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    }
    const fresh = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
    await publish(admin, fresh);
    const tasksOf = (id: string) =>
      db().productionTask.findMany({ where: { serviceOrderId: id, status: { not: 'CANCELADA' } } });
    expect((await tasksOf(a.id)).length).toBeGreaterThan(0);

    expect((await step(admin, a.id, { step: 'COMECOU' })).status).toBe(200);
    expect((await step(admin, b.id, { step: 'COMECOU' })).status).toBe(200);
    // Só uma principal em andamento por pessoa: a primeira ficou pausada, sem erro.
    const running = await db().productionTask.count({
      where: { assigneeUserId: ricardo, status: 'EM_EXECUCAO', queueExclusive: true },
    });
    expect(running).toBeLessThanOrEqual(1);

    const r = await step(admin, a.id, { step: 'PRONTA' });
    expect(r.status, JSON.stringify([r.body, await tasksOf(a.id)])).toBe(200);
    expect(r.body.state).toBe('AGUARDANDO_QUALIDADE');
    expect((await tasksOf(a.id)).every((t) => t.status === 'CONCLUIDA')).toBe(true);
  });

  it('sem a chave ligada, a etapa que pede foto não é pulada', async () => {
    const admin = await loginAdmin(app);
    const so = await osWithLead(admin);
    expect((await step(admin, so.id, { step: 'COMECOU' })).status).toBe(200);
    await db().productionTask.updateMany({
      where: { serviceOrderId: so.id },
      data: { completionRequirement: 'FOTO' },
    });
    const r = await step(admin, so.id, { step: 'PRONTA' });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/pede uma foto/);
    await setModule(admin, true);
    expect((await step(admin, so.id, { step: 'PRONTA' })).status).toBe(200);
  });

  it('sem permissão da qualidade não aprova', async () => {
    const admin = await loginAdmin(app);
    await setModule(admin, true);
    const so = await osWithLead(admin);
    await step(admin, so.id, { step: 'COMECOU' });
    await step(admin, so.id, { step: 'PRONTA' });
    const r = await step(admin, so.id, { step: 'PRONTA' });
    expect(r.body.done).toBeNull();
  });
});

describe('chave "Oficina sem tablet"', () => {
  it('aparece em Funcionalidades, desligada por padrão', async () => {
    const admin = await loginAdmin(app);
    const list = (await admin.get('/api/company/modules')).body as {
      key: string;
      enabled: boolean;
      configurable: boolean;
    }[];
    expect(list.find((m) => m.key === 'oficina_sem_tablet')).toMatchObject({
      enabled: false,
      configurable: true,
    });
  });
});

describe('Hoje na oficina e serviço parado', () => {
  it('agrupa por tapeceiro e avisa o serviço parado há 3 dias', async () => {
    const admin = await loginAdmin(app);
    await setModule(admin, true);
    const so = await osWithLead(admin);
    await step(admin, so.id, { step: 'COMECOU' });
    const floor = (await admin.get('/api/v1/shop-floor')).body;
    expect(floor.withoutTablet).toBe(true);
    const group = floor.groups.find(
      (g: { upholsterer: { displayName: string } | null }) =>
        g.upholsterer?.displayName === 'Ricardo',
    );
    expect(group.services[0]).toMatchObject({
      id: so.id,
      next: 'PRONTA',
      state: 'EM_PRODUCAO',
      stoppedDays: 0,
    });

    // Quatro dias sem movimento.
    setClock(() => new Date(Date.now() + 4 * 86_400_000 + 3_600_000));
    await naEmpresa1(() => refreshOperationalAlerts(app.ctx.prisma));
    const n = await db().notification.findFirst({
      where: { kind: 'SERVICO_PARADO', resolvedAt: null },
    });
    expect(n?.body).toMatch(/parada há 4 dias/);
    // Ficou pronta: o aviso some.
    setClock();
    await step(admin, so.id, { step: 'PRONTA' });
    await naEmpresa1(() => refreshOperationalAlerts(app.ctx.prisma));
    expect(
      await db().notification.count({ where: { kind: 'SERVICO_PARADO', resolvedAt: null } }),
    ).toBe(0);
  });
});

describe('semana sem publicar', () => {
  it('com a chave ligada, planejar em "A planejar" já publica a semana', async () => {
    const admin = await loginAdmin(app);
    await setModule(admin, true);
    const so = await osWithLead(admin);
    const ricardo = await userIdOf('Ricardo');
    const full = (await admin.get(`/api/v1/service-orders/${so.id}`)).body;
    const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
      new Date(Date.now() + 86_400_000),
    );
    const r = await admin.post(
      '/api/v1/production/plan-services',
      {
        entries: [
          {
            serviceOrderId: so.id,
            startDate: tomorrow,
            pieces: full.items.map((i: { id: string }) => ({
              serviceOrderItemId: i.id,
              upholstererUserId: ricardo,
            })),
          },
        ],
      },
      { 'idempotency-key': idemKey() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const drafts = await db().productionTask.count({
      where: { serviceOrderId: so.id, status: 'RASCUNHO' },
    });
    expect(drafts).toBe(0);
    const plan = await db().productionPlan.findFirstOrThrow({});
    expect(plan.status).toBe('PUBLICADO');
  });
});
