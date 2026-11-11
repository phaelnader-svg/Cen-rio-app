import { zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import { processHelpQueue } from '../src/modules/help/queue';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import {
  addOs,
  assign,
  createPlan,
  day,
  publish,
  serviceOrderWith,
  sofaTask,
  tabletOf,
  today,
  userIdOf,
} from './production-helpers';
import { qualityKit } from './quality-helpers';

/**
 * Reformulação, Fase 0 — simulação completa da reversibilidade dos pedidos de ajuda, medindo o que
 * o religamento cria (avisos e tarefas) para que nada aconteça "sozinho" sem estar documentado.
 */
let app: App;
const kit = qualityKit(() => app);
const TZ = 'America/Sao_Paulo';
const at = (hhmm: string) => zonedDateTime(today(), hhmm, TZ);
const setClock = (hhmm: string) => setAttendanceClock(() => at(hhmm));
const PINS: Record<string, string> = { Ricardo: '482915', Márcio: '736152', João: '121212' };

beforeAll(async () => {
  app = await createTestApp();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  setAttendanceClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  await db().companySettings.update({
    where: { id: 1 },
    data: {
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      arrivalWindowStart: '07:00',
      workdayStart: '08:30',
    },
  });
  setClock('08:00');
});
afterEach(() => setAttendanceClock());

async function setHelp(admin: Client, enabled: boolean) {
  const m = (
    (await admin.get('/api/company/modules')).body as { key: string; version: number }[]
  ).find((x) => x.key === 'ajuda')!;
  const r = await admin.put(
    '/api/company/modules/ajuda',
    { enabled, version: m.version },
    { 'idempotency-key': idemKey() },
  );
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const counts = async () => ({
  notifications: await db().notification.count(),
  supportTasks: await db().productionTask.count({ where: { supportForTaskId: { not: null } } }),
  tasks: await db().productionTask.count(),
  helpEvents: await db().helpRequestEvent.count(),
});

describe('Reversibilidade dos pedidos de ajuda (simulação completa)', () => {
  it('ligado → pedido → desligado (bloqueio, cancelamento do antigo) → religado: só o pedido ainda aberto volta à fila', async () => {
    const admin = await loginAdmin(app);
    const { so } = await serviceOrderWith(admin, 'complete', 'Cliente Reversão');
    const ricardo = await userIdOf('Ricardo');
    const joao = await userIdOf('João');
    const plan = await createPlan(admin);
    const added = (
      await addOs(admin, plan.id, {
        serviceOrderId: so.id,
        principalUserId: ricardo,
        date: day(-1),
      })
    ).body;
    for (const a of ['DESMONTAGEM', 'PREPARACAO'])
      await assign(admin, sofaTask(added, so.items[0].id, a), joao);
    const published = await publish(
      admin,
      (await admin.get(`/api/v1/production-plans/${plan.id}`)).body,
    );
    const main = sofaTask(published, so.items[0].id, 'CORTE_TECIDO') as { id: string };
    const tabs: Record<string, Client> = {};
    for (const n of ['Ricardo', 'João']) tabs[n] = await tabletOf(app, admin, n, PINS[n]!);
    setClock('08:30');
    await tabs.Ricardo!.post('/api/v1/attendance/me/arrive', {}, { 'idempotency-key': idemKey() });
    setClock('09:00');

    // 1–2. Ligado (padrão): pedido criado; ninguém disponível (João não chegou), fica pendente.
    const r1 = await tabs.Ricardo!.post(
      '/api/v1/help-requests',
      { taskId: main.id, kind: 'PARAFUSAR' },
      { 'idempotency-key': idemKey() },
    );
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body.status).toBe('PENDENTE');
    // 3. Desligar.
    await setHelp(admin, false);
    const off = await counts();

    // 4. Bloqueio e ocultação.
    expect(
      (
        await tabs.Ricardo!.post(
          '/api/v1/help-requests',
          { taskId: main.id, kind: 'PARAFUSAR' },
          { 'idempotency-key': idemKey() },
        )
      ).body.error.code,
    ).toBe('MODULE_DISABLED');
    expect(JSON.stringify((await admin.get('/api/v1/attention')).body)).not.toContain(r1.body.id);
    // João chega durante o desligamento (a chegada dispara a fila): nada é atribuído nem avisado.
    setClock('09:30');
    await tabs.João!.post('/api/v1/attendance/me/arrive', {}, { 'idempotency-key': idemKey() });
    expect(await processHelpQueue(app.ctx.prisma, at('11:30'))).toBe(0);
    const offAfter = await counts();
    expect(offAfter.supportTasks).toBe(off.supportTasks);
    expect(offAfter.helpEvents).toBe(off.helpEvents);

    // 6. Histórico consultável.
    expect((await admin.get(`/api/v1/help-requests/${r1.body.id}`)).status).toBe(200);

    // 7. Cancelar um pedido antigo com o módulo desligado (limpeza antes de religar) é permitido.
    const cancel = await admin.post(
      `/api/v1/help-requests/${r1.body.id}/cancel`,
      { reason: 'Ajuda desativada' },
      { 'idempotency-key': idemKey() },
    );
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.status).toBe('CANCELADA');

    // 5. Religar horas depois: o pedido cancelado NÃO volta; nada nasce sozinho.
    await setHelp(admin, true);
    const before = await counts();
    expect(await processHelpQueue(app.ctx.prisma, at('13:00'))).toBe(0);
    const after = await counts();
    expect(after.supportTasks).toBe(before.supportTasks);
    expect(after.tasks).toBe(before.tasks);
    expect(after.notifications).toBe(before.notifications);
    // Novos pedidos voltam a funcionar (João presente: atribuído na hora).
    const r2 = await tabs.Ricardo!.post(
      '/api/v1/help-requests',
      { taskId: main.id, kind: 'PARAFUSAR' },
      { 'idempotency-key': idemKey() },
    );
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    expect(r2.body.status).toBe('ATRIBUIDA');
  });

  it('religar com pedido antigo AINDA pendente: ele é atribuído na primeira passada da fila (efeito documentado), sem duplicar avisos ao gestor', async () => {
    const admin = await loginAdmin(app);
    const { so } = await serviceOrderWith(admin, 'complete', 'Cliente Pendente Antigo');
    const ricardo = await userIdOf('Ricardo');
    const plan = await createPlan(admin);
    const added = (
      await addOs(admin, plan.id, {
        serviceOrderId: so.id,
        principalUserId: ricardo,
        date: day(-1),
      })
    ).body;
    const joao = await userIdOf('João');
    for (const a of ['DESMONTAGEM', 'PREPARACAO'])
      await assign(admin, sofaTask(added, so.items[0].id, a), joao);
    const published = await publish(
      admin,
      (await admin.get(`/api/v1/production-plans/${plan.id}`)).body,
    );
    const main = sofaTask(published, so.items[0].id, 'CORTE_TECIDO') as { id: string };
    const tabs: Record<string, Client> = {};
    for (const n of ['Ricardo', 'João']) tabs[n] = await tabletOf(app, admin, n, PINS[n]!);
    setClock('08:30');
    await tabs.Ricardo!.post('/api/v1/attendance/me/arrive', {}, { 'idempotency-key': idemKey() });
    setClock('09:00');
    const old = await tabs.Ricardo!.post(
      '/api/v1/help-requests',
      { taskId: main.id, kind: 'PARAFUSAR' },
      { 'idempotency-key': idemKey() },
    );
    expect(old.body.status).toBe('PENDENTE');
    await setHelp(admin, false);
    await tabs.João!.post('/api/v1/attendance/me/arrive', {}, { 'idempotency-key': idemKey() });
    const gestor = (await admin.get('/api/auth/me')).body.user.id as string;
    const gestorHelpBefore = await db().notification.count({
      where: { userId: gestor, kind: { startsWith: 'AJUDA_' } },
    });

    await setHelp(admin, true);
    const before = await counts();
    await processHelpQueue(app.ctx.prisma, at('12:00'));
    const after = await counts();
    const req = await db().helpRequest.findUniqueOrThrow({ where: { id: old.body.id } });
    // Efeito do religamento: o pedido antigo, ainda aberto, ganha ajudante e tarefa de apoio.
    expect(req.status).toBe('ATRIBUIDA');
    expect(after.supportTasks - before.supportTasks).toBe(1);
    // Aviso só para quem pediu e para o ajudante; o gestor não recebe aviso novo de ajuda.
    const created = await db().notification.findMany({
      where: { kind: { startsWith: 'AJUDA_' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(
      await db().notification.count({ where: { userId: gestor, kind: { startsWith: 'AJUDA_' } } }),
    ).toBe(gestorHelpBefore);
    expect(new Set(created.map((n) => n.userId)).has(joao)).toBe(true);
  });

  it('qualidade e produção funcionam do começo ao fim com a ajuda desligada', async () => {
    const s = await kit.scenario();
    await setHelp(s.admin, false);
    await kit.ready(s, 'sofa');
    expect(await kit.stage(s.sofa.id)).toBe('PRONTA_ENTREGA');
    // Correção: reprovar a poltrona gera a tarefa de correção, concluí-la reabre a inspeção.
    await kit.finish(s.tablets.Márcio!, s.poltronaTask.id);
    const open = (await kit.openOf(s.poltronas.id))!;
    const checked = await kit.checkAll(s.tablets.Thiago!, open.id, 'Costura aberta');
    const rej = await s.tablets.Thiago!.post(
      `/api/v1/quality/inspections/${open.id}/reject`,
      { reason: 'Costura aberta no braço', version: checked.version },
      { 'idempotency-key': idemKey() },
    );
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(await kit.stage(s.poltronas.id)).toBe('EM_CORRECAO');
    const fix = await db().productionTask.findFirstOrThrow({
      where: { activity: 'CORRECAO', inspectionId: open.id },
    });
    await kit.finish(s.tablets.Márcio!, fix.id, 'Costura refeita');
    expect(await kit.stage(s.poltronas.id)).toBe('AGUARDANDO_INSPECAO');
  });
});
