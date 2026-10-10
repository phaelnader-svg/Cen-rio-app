import { zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { openServiceOrder } from './measurement-helpers';
import { addOs, createPlan, userIdOf } from './production-helpers';
import { approvedNeeds, staples } from './purchasing-helpers';

/**
 * Evolução, Fase 8 — relógio e fuso da oficina (causa raiz do “−3 h fixo”).
 * Os períodos e prazos financeiros usavam um deslocamento fixo de −3 h (`finance/common.ts`
 * `period`, `finance/results.ts` produtividade, `labor-review.ts` semanal) e o planejamento de
 * materiais usava meia-noite UTC. A regra correta: dias LOCAIS no fuso configurado da oficina
 * (`company_settings.timezone`). “Hoje” segue o relógio operacional (o mesmo do resto da API).
 * Horários de borda: 20h59, 21h, 23h59, 00h01; sexta/sábado; virada de mês.
 */
let app: App;
let admin: Client;
const F = (p: string) => `/api/v1/finance${p}`;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  admin = await loginAdmin(app);
});
afterEach(() => setClock());

const setTz = (timezone: string) =>
  db().companySettings.update({ where: { id: 1 }, data: { timezone } });

/** Tarefas concluídas de Ricardo com dia programado e horário de conclusão (instantes UTC). */
async function completedTasks(rows: { scheduled: Date; completed: Date; title: string }[]) {
  const ricardo = await userIdOf('Ricardo');
  const so = await openServiceOrder(admin, 'Cliente Fuso');
  const plan = await createPlan(admin, '2026-10-09', 'FILA_SEMANAL');
  expect(
    (
      await addOs(admin, plan.id, {
        serviceOrderId: so.id,
        principalUserId: ricardo,
        generate: false,
      })
    ).status,
  ).toBe(201);
  for (const r of rows) {
    const t = await admin.post(
      `/api/v1/production-plans/${plan.id}/tasks`,
      { serviceOrderId: so.id, activity: 'OUTRA', title: r.title, assigneeUserId: ricardo },
      { 'idempotency-key': idemKey() },
    );
    expect(t.status).toBe(201);
    await db().productionTask.update({
      where: { id: t.body.id },
      data: {
        status: 'CONCLUIDA',
        scheduledAt: r.scheduled,
        dueDate: null,
        startedAt: new Date(r.completed.getTime() - 3_600_000),
        completedAt: r.completed,
      },
    });
  }
  return ricardo;
}
const ricardoRow = async (from: string, to: string, id: string) =>
  (await admin.get(F(`/productivity?from=${from}&to=${to}`))).body.rows.find(
    (r: { userId: string }) => r.userId === id,
  );

describe('Produtividade: prazo e período em dias locais', () => {
  it('São Paulo: 20h59, 21h, 23h59 de sexta no prazo; 00h01 de sábado atrasada; período fecha na meia-noite local', async () => {
    const tz = 'America/Sao_Paulo';
    const fri = (hhmm: string) => zonedDateTime('2026-10-09', hhmm, tz);
    const id = await completedTasks([
      { title: 'A', scheduled: fri('08:00'), completed: fri('20:59') },
      { title: 'B', scheduled: fri('08:00'), completed: fri('21:00') },
      { title: 'C', scheduled: fri('08:00'), completed: fri('23:59') },
      { title: 'D', scheduled: fri('08:00'), completed: zonedDateTime('2026-10-10', '00:01', tz) },
    ]);
    // Só sexta: as três de sexta (até 23h59 local); a de 00h01 é de sábado.
    expect(await ricardoRow('2026-10-09', '2026-10-09', id)).toMatchObject({
      withDueDate: 3,
      onTime: 3,
      late: 0,
    });
    expect(await ricardoRow('2026-10-09', '2026-10-10', id)).toMatchObject({
      withDueDate: 4,
      onTime: 3,
      late: 1,
    });
    expect(await ricardoRow('2026-10-10', '2026-10-10', id)).toMatchObject({ late: 1, onTime: 0 });
  });

  it('virada de mês: 31/10 23h59 no mês de outubro; 01/11 00h01 em novembro', async () => {
    const tz = 'America/Sao_Paulo';
    const id = await completedTasks([
      {
        title: 'Out',
        scheduled: zonedDateTime('2026-10-31', '08:00', tz),
        completed: zonedDateTime('2026-10-31', '23:59', tz),
      },
      {
        title: 'Nov',
        scheduled: zonedDateTime('2026-10-31', '08:00', tz),
        completed: zonedDateTime('2026-11-01', '00:01', tz),
      },
    ]);
    expect(await ricardoRow('2026-10-01', '2026-10-31', id)).toMatchObject({ onTime: 1, late: 0 });
    expect(await ricardoRow('2026-11-01', '2026-11-30', id)).toMatchObject({ onTime: 0, late: 1 });
  });

  it('fuso configurado (Manaus, UTC−4): 23h30 local de sexta é sexta — sem −3 h fixo', async () => {
    const tz = 'America/Manaus';
    await setTz(tz);
    const id = await completedTasks([
      {
        title: 'Manaus',
        scheduled: zonedDateTime('2026-10-09', '08:00', tz),
        completed: zonedDateTime('2026-10-09', '23:30', tz), // 03:30 UTC de sábado
      },
    ]);
    expect(await ricardoRow('2026-10-09', '2026-10-09', id)).toMatchObject({
      withDueDate: 1,
      onTime: 1,
      late: 0,
    });
  });
});

describe('Mão de obra semanal e materiais: limites locais', () => {
  it('semanal da mão de obra usa o fuso configurado (liberação às 23h30 em Manaus)', async () => {
    const tz = 'America/Manaus';
    await setTz(tz);
    const ricardo = await userIdOf('Ricardo');
    const so = await openServiceOrder(admin, 'Cliente Semanal Fuso');
    await admin.req(
      'PUT',
      `/api/v1/service-order-items/${so.items[0].id}/upholsterer`,
      { userId: ricardo, expectedUserId: null },
      { 'idempotency-key': idemKey() },
    );
    const mo = await admin.post(
      F('/labor'),
      {
        professionalUserId: ricardo,
        serviceOrderId: so.id,
        serviceOrderItemId: so.items[0].id,
        service: 'Mão de obra',
        agreedCents: 50000,
        eligibility: 'QUALIDADE_APROVADA',
      },
      { 'idempotency-key': idemKey() },
    );
    expect(mo.status).toBe(201);
    await db().productionPayable.update({
      where: { id: mo.body.id },
      data: {
        status: 'LIBERADO',
        eligibleAt: zonedDateTime('2026-10-11', '23:30', tz), // domingo 23h30 local = segunda UTC
        createdAt: zonedDateTime('2026-10-11', '23:30', tz),
      },
    });
    const w = (await admin.get(F('/labor-weekly?from=2026-10-05&to=2026-10-11'))).body;
    const row = w.rows.find(
      (r: { professionalUserId: string }) => r.professionalUserId === ricardo,
    );
    expect(row).toMatchObject({ weekStart: '2026-10-05', releasedCents: 50000 });
  });

  it('materiais aprovados: aprovação às 22h30 local entra no dia local (antes: meia-noite UTC)', async () => {
    const tz = 'America/Sao_Paulo';
    const { reqs } = await approvedNeeds(admin, 'Cliente Materiais Fuso', () => [staples()]);
    await db().materialRequirement.updateMany({
      where: { id: { in: reqs.map((r) => r.id) } },
      data: { approvedAt: zonedDateTime('2026-10-09', '22:30', tz) },
    });
    const lines = (await admin.get('/api/v1/materials/consolidated?from=2026-10-09&to=2026-10-09'))
      .body.lines;
    expect(lines.length).toBeGreaterThan(0);
    const next = (await admin.get('/api/v1/materials/consolidated?from=2026-10-10&to=2026-10-10'))
      .body.lines;
    expect(next).toHaveLength(0);
  });
});

describe('“Hoje” segue o relógio operacional', () => {
  it('planejamento e financeiro: sexta 23h59 → sexta; sábado 00h01 → sábado (prazo de sexta recusado)', async () => {
    const tz = 'America/Sao_Paulo';
    setClock(() => zonedDateTime('2026-10-09', '23:59', tz));
    const plan1 = (await admin.get('/api/v1/materials/planning')).body;
    expect(plan1.period.from).toBe('2026-10-09');
    expect((await admin.get(F('/productivity'))).body.to).toBe('2026-10-09');
    setClock(() => zonedDateTime('2026-10-10', '00:01', tz));
    const plan2 = (await admin.get('/api/v1/materials/planning')).body;
    expect(plan2.period.from).toBe('2026-10-10');
    expect((await admin.get(F('/productivity'))).body.to).toBe('2026-10-10');
    // Prazo calculado antes da meia-noite (sexta) enviado depois dela: recusado com mensagem clara.
    const so = await openServiceOrder(admin, 'Cliente Meia-noite');
    const gestor = (await db().user.findFirstOrThrow({ where: { email: 'gestor@teste.local' } }))
      .id;
    const r = await admin.post(
      '/api/v1/measurements',
      { serviceOrderId: so.id, kind: 'ROTINA', assigneeUserId: gestor, dueDate: '2026-10-09' },
      { 'idempotency-key': idemKey() },
    );
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('passado');
  });
});
