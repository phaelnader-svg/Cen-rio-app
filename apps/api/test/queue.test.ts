import { mondayOf, onlyReassignableBlockers, zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { releaseDueTasks } from '../src/modules/production/common';
import type { Client } from './helpers';
import { WsClient, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { openServiceOrder } from './measurement-helpers';
import {
  act,
  addOs,
  createPlan,
  publish,
  serviceOrderWith,
  tabletOf,
  today,
  userIdOf,
} from './production-helpers';

/**
 * Evolução, Fase 2 — planejamento semanal em fila contínua (FILA_SEMANAL), com os planos
 * anteriores (LEGADO) preservados. Relógio controlado (core/clock) para virada de dia/semana.
 */
let app: App;
const sockets: WsClient[] = [];
const track = (w: WsClient) => (sockets.push(w), w);
const TZ = 'America/Sao_Paulo';
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const MONDAY = () => mondayOf(today());
/** Fixa o relógio da aplicação num dia da semana do plano (0 = segunda) e horário locais. */
const clockAt = (weekday: number, hhmm: string) =>
  setClock(() => zonedDateTime(addDays(MONDAY(), weekday), hhmm, TZ));

beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  setClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
  await db().companySettings.update({
    where: { id: 1 },
    data: { workingDays: [0, 1, 2, 3, 4, 5, 6], arrivalWindowStart: '07:00' },
  });
  clockAt(0, '08:00');
});
afterEach(async () => {
  setClock();
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

type T = {
  id: string;
  code: string;
  status: string;
  version: number;
  scheduledAt: string | null;
  queuePosition: number | null;
  blockers: string[];
  carriedFromWeek: string | null;
  plan: { id: string; mode: string } | null;
};
type Queue = {
  current: T | null;
  next: T | null;
  blockedAhead: number;
  total: number;
  items: { position: number; executable: boolean; task: T }[];
};

const post = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.post(url, body, { 'idempotency-key': key });
const put = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.req('PUT', url, body, { 'idempotency-key': key });

/** Plano em fila com N tarefas independentes do João (sem data/horário), publicado. */
async function queuePlan(n: number, opts: { weekOf?: string; publish?: boolean } = {}) {
  const admin = await loginAdmin(app);
  const so = await openServiceOrder(
    admin,
    `Cliente Fila ${Math.random().toString(36).slice(2, 7)}`,
  );
  const joao = await userIdOf('João');
  const plan = await createPlan(admin, opts.weekOf ?? today(), 'FILA_SEMANAL');
  expect(plan.mode).toBe('FILA_SEMANAL');
  expect(
    (
      await addOs(admin, plan.id, {
        serviceOrderId: so.id,
        principalUserId: await userIdOf('Ricardo'),
        generate: false,
      })
    ).status,
  ).toBe(201);
  const tasks: T[] = [];
  for (let i = 0; i < n; i++) {
    const r = await post(admin, `/api/v1/production-plans/${plan.id}/tasks`, {
      serviceOrderId: so.id,
      activity: 'PREPARACAO',
      title: `Fila ${String(i + 1).padStart(2, '0')}`,
      assigneeUserId: joao,
    });
    expect(r.status).toBe(201);
    tasks.push(r.body);
  }
  let current = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
  if (opts.publish !== false) current = await publish(admin, current);
  return { admin, so, joao, plan: current, tasks };
}
const queueOf = async (c: Client) =>
  (await c.get('/api/v1/production-tasks/mine/queue')).body as Queue;

describe('LEGADO preservado (CA2-01)', () => {
  it('horário futuro/ausente segue impedindo o início; passado libera; relógio de teste vale', async () => {
    const admin = await loginAdmin(app);
    const { so } = await serviceOrderWith(admin, 'none');
    const joao = await userIdOf('João');
    const plan = await createPlan(admin, today(), 'LEGADO');
    expect(plan.mode).toBe('LEGADO');
    await addOs(admin, plan.id, {
      serviceOrderId: so.id,
      principalUserId: await userIdOf('Ricardo'),
      generate: false,
    });
    const mk = async (date: string | null, time: string | null, title: string) =>
      (
        await post(admin, `/api/v1/production-plans/${plan.id}/tasks`, {
          serviceOrderId: so.id,
          activity: 'PREPARACAO',
          title,
          assigneeUserId: joao,
          date,
          time,
        })
      ).body as T;
    const today0 = addDays(MONDAY(), 0);
    const past = await mk(today0, '07:00', 'Passado');
    const future = await mk(today0, '10:00', 'Futuro');
    const absent = await mk(null, null, 'Sem horário');
    const published = await publish(
      admin,
      (await admin.get(`/api/v1/production-plans/${plan.id}`)).body,
    );
    const st = (id: string) => published.tasks.find((t: T) => t.id === id).status;
    expect([st(past.id), st(future.id), st(absent.id)]).toEqual([
      'LIBERADA',
      'PROGRAMADA',
      'PROGRAMADA',
    ]);
    expect(published.conflicts.map((c: { kind: string }) => c.kind)).toContain('SEM_HORARIO');
    const tablet = await tabletOf(app, admin, 'João', '271828');
    const f = await act(tablet, future.id, 'start');
    expect(f.status).toBe(422);
    expect(f.body.error.message).toMatch(/horário programado/);
    expect((await act(tablet, absent.id, 'start')).status).toBe(422);
    // LEGADO não tem exclusividade: comportamento anterior (duas em execução) preservado.
    expect((await act(tablet, past.id, 'start')).status).toBe(200);
    // Relógio de teste chega à liberação (defeito corrigido): 10:01 libera a de 10:00.
    clockAt(0, '10:01');
    expect(await releaseDueTasks(db())).toBeGreaterThan(0);
    expect((await db().productionTask.findUniqueOrThrow({ where: { id: future.id } })).status).toBe(
      'LIBERADA',
    );
    expect((await act(tablet, future.id, 'start')).status).toBe(200);
    expect(
      await db().productionTask.count({ where: { assigneeUserId: joao, status: 'EM_EXECUCAO' } }),
    ).toBe(2);
    // Fila do tablet ignora planos LEGADO.
    expect((await queueOf(tablet)).total).toBe(0);
  });

  it('defeito HORARIO: a redistribuição simples aceita só DEPENDENCIAS', () => {
    expect(onlyReassignableBlockers(['DEPENDENCIAS'])).toBe(true);
    expect(onlyReassignableBlockers([])).toBe(true);
    expect(onlyReassignableBlockers(['HORARIO'])).toBe(false);
    expect(onlyReassignableBlockers(['DEPENDENCIAS', 'MATERIAIS'])).toBe(false);
  });
});

describe('FILA_SEMANAL', () => {
  it('CA2-02: padrão da API é fila; 42 tarefas publicadas sem horário; data recusada', async () => {
    const admin = await loginAdmin(app);
    const dflt = await post(admin, '/api/v1/production-plans', {
      weekStart: addDays(MONDAY(), 14),
    });
    expect(dflt.status).toBe(201);
    expect(dflt.body.mode).toBe('FILA_SEMANAL');

    const { plan, so, tasks } = await queuePlan(42);
    expect(plan.status).toBe('PUBLICADO');
    expect(plan.tasks).toHaveLength(42);
    expect(plan.tasks.every((t: T) => t.scheduledAt === null && t.status === 'LIBERADA')).toBe(
      true,
    );
    expect(plan.conflicts.map((c: { kind: string }) => c.kind)).not.toContain('SEM_HORARIO');
    // Horário não existe no modo fila: criação e alteração com data/horário são recusadas.
    const withDate = await post(admin, `/api/v1/production-plans/${plan.id}/tasks`, {
      serviceOrderId: so.id,
      activity: 'PREPARACAO',
      date: today(),
      time: '09:00',
      reason: 'teste',
    });
    expect(withDate.status).toBe(422);
    const upd = await admin.put(`/api/v1/production-tasks/${tasks[0]!.id}`, {
      date: today(),
      version: plan.tasks[0].version,
      reason: 'teste',
    });
    expect(upd.status).toBe(422);
    const dbRows = await db().productionTask.findMany({ where: { planId: plan.id } });
    expect(dbRows.every((t) => t.scheduledAt === null && t.queueExclusive)).toBe(true);
  });

  it('CA2-03/04: sem horário, mas dependência e materiais seguem exigidos; início explícito', async () => {
    const admin = await loginAdmin(app);
    const { so } = await serviceOrderWith(admin, 'missing', 'Cliente Materiais');
    const joao = await userIdOf('João');
    const plan = await createPlan(admin, today(), 'FILA_SEMANAL');
    await addOs(admin, plan.id, {
      serviceOrderId: so.id,
      principalUserId: await userIdOf('Ricardo'),
      generate: false,
    });
    const mk = async (body: Record<string, unknown>) =>
      (
        await post(admin, `/api/v1/production-plans/${plan.id}/tasks`, {
          serviceOrderId: so.id,
          activity: 'PREPARACAO',
          assigneeUserId: joao,
          ...body,
        })
      ).body as T;
    const a = await mk({ title: 'A' });
    const b = await mk({ title: 'B (depende de A)', dependsOn: [a.id] });
    const m = await mk({ title: 'M (materiais)', requiresMaterials: true });
    const pub = await publish(admin, (await admin.get(`/api/v1/production-plans/${plan.id}`)).body);
    const s = (id: string) => pub.tasks.find((t: T) => t.id === id);
    expect(s(a.id).status).toBe('LIBERADA');
    expect(s(b.id)).toMatchObject({ status: 'BLOQUEADA', blockers: ['DEPENDENCIAS'] });
    expect(s(m.id)).toMatchObject({ status: 'BLOQUEADA', blockers: ['MATERIAIS'] });
    const tablet = await tabletOf(app, admin, 'João', '271828');
    expect((await act(tablet, b.id, 'start')).status).toBe(422);
    expect((await act(tablet, m.id, 'start')).status).toBe(422);
    expect((await act(tablet, a.id, 'start')).status).toBe(200);
    expect((await act(tablet, a.id, 'complete')).status).toBe(200);
    // B fica disponível na hora, mas NÃO inicia sozinha.
    const q = await queueOf(tablet);
    expect(q.current).toBeNull();
    expect(q.next!.id).toBe(b.id);
    expect(q.next!.status).toBe('LIBERADA');
    expect(
      (await db().productionTask.findUniqueOrThrow({ where: { id: b.id } })).startedAt,
    ).toBeNull();
    // Horários reais do servidor no início/conclusão.
    const done = await db().productionTask.findUniqueOrThrow({ where: { id: a.id } });
    expect(done.startedAt).toBeInstanceOf(Date);
    expect(done.completedAt).toBeInstanceOf(Date);
  });

  it('CA2-05: 20 tarefas, 4 concluídas na segunda; a 5ª aparece na terça, sem duplicar nem zerar', async () => {
    const { admin, tasks, joao } = await queuePlan(20);
    const tablet = await tabletOf(app, admin, 'João', '271828');
    clockAt(0, '09:00');
    for (const t of tasks.slice(0, 4)) {
      expect((await act(tablet, t.id, 'start')).status).toBe(200);
      expect((await act(tablet, t.id, 'complete')).status).toBe(200);
    }
    const before = await db().productionTask.findMany({
      where: { assigneeUserId: joao },
      orderBy: { number: 'asc' },
      select: { id: true, status: true, version: true, scheduledAt: true, planId: true },
    });
    // Virada do dia: 23:59 → 00:01 → terça 08:00, com os ciclos automáticos rodando.
    for (const [wd, hhmm] of [
      [0, '23:59'],
      [1, '00:01'],
      [1, '08:00'],
    ] as const) {
      clockAt(wd, hhmm);
      await releaseDueTasks(db());
    }
    const after = await db().productionTask.findMany({
      where: { assigneeUserId: joao },
      orderBy: { number: 'asc' },
      select: { id: true, status: true, version: true, scheduledAt: true, planId: true },
    });
    expect(after).toEqual(before); // nada duplicado, concluído, transferido ou alterado
    const q = await queueOf(tablet);
    expect(q.total).toBe(16);
    expect(q.next!.id).toBe(tasks[4]!.id);
    expect(q.items[0]!.position).toBe(1);
    const mine = (await tablet.get('/api/v1/production-tasks/mine')).body;
    expect(mine.today.filter((t: T) => t.status === 'LIBERADA')).toHaveLength(16);
  });

  it('CA2-06/07: 1ª bloqueada → próxima executável sem reordenar; desbloqueio não interrompe', async () => {
    const { admin, tasks } = await queuePlan(4);
    const tablet = await tabletOf(app, admin, 'João', '271828');
    const [t1, t2] = [tasks[0]!, tasks[1]!];
    expect(
      (
        await post(admin, `/api/v1/production-tasks/${t1.id}/block`, {
          reason: 'Falta a grampeadeira',
        })
      ).status,
    ).toBe(200);
    let q = await queueOf(tablet);
    expect(q.items[0]!.task.id).toBe(t1.id); // mantém o lugar
    expect(q.items[0]!.executable).toBe(false);
    expect(q.next!.id).toBe(t2.id);
    expect(q.blockedAhead).toBe(1);
    const positions = await db().productionTask.findMany({
      where: { id: { in: tasks.map((t) => t.id) } },
      select: { id: true, queuePosition: true, priority: true },
    });
    expect(positions.every((p) => p.queuePosition === null && p.priority === 'NORMAL')).toBe(true);
    expect((await act(tablet, t2.id, 'start')).status).toBe(200);
    // A ferramenta chegou: desbloqueio NÃO interrompe a tarefa em execução.
    expect(
      (await post(admin, `/api/v1/production-tasks/${t1.id}/unblock`, { reason: 'Chegou' })).status,
    ).toBe(200);
    expect((await db().productionTask.findUniqueOrThrow({ where: { id: t2.id } })).status).toBe(
      'EM_EXECUCAO',
    );
    q = await queueOf(tablet);
    expect(q.current!.id).toBe(t2.id);
    expect(q.next!.id).toBe(t1.id); // volta a ser elegível na posição original
    expect(q.items.map((e) => e.task.id)).toEqual(tasks.map((t) => t.id));
    // Iniciar a desbloqueada enquanto há outra em execução: recusado (D-6).
    const second = await act(tablet, t1.id, 'start');
    expect(second.status).toBe(409);
    expect((await db().productionTask.findUniqueOrThrow({ where: { id: t1.id } })).status).toBe(
      'LIBERADA',
    );
  });

  it('impedimento com João presente: indica a próxima da fila sem antecipar nem iniciar', async () => {
    const { admin, tasks, joao } = await queuePlan(3);
    const tablet = await tabletOf(app, admin, 'João', '271828');
    clockAt(0, '08:00');
    expect((await post(tablet, '/api/v1/attendance/me/arrive', {})).status).toBe(200);
    await post(admin, `/api/v1/production-tasks/${tasks[0]!.id}/block`, {
      reason: 'Sem ferramenta',
    });
    const notes = await db().notification.findMany({
      where: { userId: joao, kind: 'TAREFA_ALTERNATIVA_LIBERADA' },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toMatch(/próxima da sua fila/);
    const rows = await db().productionTask.findMany({
      where: { id: { in: tasks.map((t) => t.id) } },
    });
    expect(rows.every((r) => r.scheduledAt === null && r.status !== 'EM_EXECUCAO')).toBe(true);
    expect(await db().planningAction.count({ where: { kind: 'TAREFA_ANTECIPADA' } })).toBe(0);
  });

  it('CA2-08: inícios concorrentes deixam no máximo uma principal ativa; apoio é exceção', async () => {
    const { admin, tasks, joao } = await queuePlan(6);
    const tablet = await tabletOf(app, admin, 'João', '271828');
    const results = await Promise.all(tasks.map((t) => act(tablet, t.id, 'start')));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(
      await db().productionTask.count({ where: { assigneeUserId: joao, status: 'EM_EXECUCAO' } }),
    ).toBe(1);
    const active = await db().productionTask.findFirstOrThrow({
      where: { assigneeUserId: joao, status: 'EM_EXECUCAO' },
    });
    // Pausar e retomar outra ao mesmo tempo: só uma vence.
    expect(
      (
        await act(tablet, active.id, 'pause', {
          reason: 'AGUARDANDO_ORIENTACAO',
          impediment: false,
        })
      ).status,
    ).toBe(200);
    const other = tasks.find((t) => t.id !== active.id)!;
    const race = await Promise.all([
      act(tablet, active.id, 'resume'),
      act(tablet, other.id, 'start'),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await db().productionTask.count({ where: { assigneeUserId: joao, status: 'EM_EXECUCAO' } }),
    ).toBe(1);
    // Garantia no banco (mesmo fora da aplicação): segunda principal em execução é recusada.
    const spare = tasks.filter((t) => t.id !== active.id && t.id !== other.id);
    await expect(
      db().productionTask.update({
        where: { id: spare[0]!.id },
        data: { status: 'EM_EXECUCAO', startedAt: new Date() },
      }),
    ).rejects.toThrow(/Unique constraint/);
    // Apoio a um colega (supportForTaskId) não é segunda tarefa principal: pode iniciar.
    const ricardo = await userIdOf('Ricardo');
    const main = await db().productionTask.findUniqueOrThrow({ where: { id: spare[1]!.id } });
    await db().productionTask.update({ where: { id: main.id }, data: { assigneeUserId: ricardo } });
    const support = await db().productionTask.create({
      data: {
        planId: main.planId,
        serviceOrderId: main.serviceOrderId,
        activity: 'PREPARACAO',
        title: 'Apoio ao Ricardo',
        role: 'APOIO',
        assigneeUserId: joao,
        priority: 'NORMAL',
        sequence: 999,
        status: 'LIBERADA',
        supportForTaskId: main.id,
      },
    });
    expect(support.queueExclusive).toBe(false);
    expect((await act(tablet, support.id, 'start')).status).toBe(200);
    expect(
      await db().productionTask.count({ where: { assigneeUserId: joao, status: 'EM_EXECUCAO' } }),
    ).toBe(2);
    // O apoio não entra na fila de tarefas principais nem transfere responsabilidade.
    const q = await queueOf(tablet);
    expect(q.items.some((e) => e.task.id === support.id)).toBe(false);
    expect(
      (await db().productionTask.findUniqueOrThrow({ where: { id: main.id } })).assigneeUserId,
    ).toBe(ricardo);
  });

  it('CA2-09: reordenação com motivo, versão (CAS), histórico e aviso ao tablet; funcionário proibido', async () => {
    const { admin, plan, tasks, joao } = await queuePlan(4);
    const tablet = await tabletOf(app, admin, 'João', '271828');
    const wsTablet = track(await WsClient.connect(app, tablet));
    const order = [tasks[2]!, tasks[0]!, tasks[1]!, tasks[3]!].map((t) => t.id);
    const url = `/api/v1/production-plans/${plan.id}/queue`;
    // Publicado: sem motivo → 400.
    expect(
      (await put(admin, url, { userId: joao, taskIds: order, version: plan.version })).status,
    ).toBe(400);
    // Versão antiga → 409.
    expect(
      (
        await put(admin, url, {
          userId: joao,
          taskIds: order,
          version: plan.version - 1,
          reason: 'x123',
        })
      ).status,
    ).toBe(409);
    // Lista incompleta → 422.
    expect(
      (
        await put(admin, url, {
          userId: joao,
          taskIds: order.slice(1),
          version: plan.version,
          reason: 'x123',
        })
      ).status,
    ).toBe(422);
    // Funcionário não reordena a própria fila.
    expect(
      (
        await put(tablet, url, {
          userId: joao,
          taskIds: order,
          version: plan.version,
          reason: 'quero',
        })
      ).status,
    ).toBe(403);
    // Duas reordenações concorrentes com a mesma versão: uma vence, a outra recebe 409.
    const rev = [tasks[3]!, tasks[2]!, tasks[1]!, tasks[0]!].map((t) => t.id);
    const both = await Promise.all([
      put(admin, url, {
        userId: joao,
        taskIds: order,
        version: plan.version,
        reason: 'Cliente pediu urgência',
      }),
      put(admin, url, { userId: joao, taskIds: rev, version: plan.version, reason: 'Outra ordem' }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = both.find((r) => r.status === 200)!;
    const expected = both[0]!.status === 200 ? order : rev;
    expect((winner.body as Queue).items.map((e) => e.task.id)).toEqual(expected);
    expect((await queueOf(tablet)).items.map((e) => e.task.id)).toEqual(expected);
    const p2 = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
    expect(p2.revision).toBe(2);
    const events = await db().productionTaskEvent.findMany({ where: { kind: 'FILA_REORDENADA' } });
    expect(events.length).toBeGreaterThan(0);
    expect(await db().auditLog.count({ where: { action: 'production.queue_reordered' } })).toBe(1);
    await wsTablet.waitFor((m) => m.event?.type === 'production.queue_reordered');
    // Mesma ordem repetida: nada muda (sem nova revisão nem versão).
    const same = await put(admin, url, {
      userId: joao,
      taskIds: expected,
      version: p2.version,
      reason: 'repetição',
    });
    expect(same.status).toBe(200);
    expect((await admin.get(`/api/v1/production-plans/${plan.id}`)).body.version).toBe(p2.version);
    // Faixa de prioridade e dependência são respeitadas.
    await admin.put(`/api/v1/production-tasks/${tasks[3]!.id}`, {
      priority: 'URGENTE',
      version: (await db().productionTask.findUniqueOrThrow({ where: { id: tasks[3]!.id } }))
        .version,
      reason: 'Prazo do cliente',
    });
    const p3 = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
    const urgentLast = [tasks[0]!, tasks[1]!, tasks[2]!, tasks[3]!].map((t) => t.id);
    const bad = await put(admin, url, {
      userId: joao,
      taskIds: urgentLast,
      version: p3.version,
      reason: 'teste',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/prioridade/);
  });

  it('CA2-09b: dependência não pode ficar depois da dependente', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Dep');
    const joao = await userIdOf('João');
    const plan = await createPlan(admin, today(), 'FILA_SEMANAL');
    await addOs(admin, plan.id, {
      serviceOrderId: so.id,
      principalUserId: await userIdOf('Ricardo'),
      generate: false,
    });
    const a = (
      await post(admin, `/api/v1/production-plans/${plan.id}/tasks`, {
        serviceOrderId: so.id,
        activity: 'PREPARACAO',
        assigneeUserId: joao,
      })
    ).body;
    const b = (
      await post(admin, `/api/v1/production-plans/${plan.id}/tasks`, {
        serviceOrderId: so.id,
        activity: 'PREPARACAO',
        assigneeUserId: joao,
        dependsOn: [a.id],
      })
    ).body;
    const draft = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
    const r = await put(admin, `/api/v1/production-plans/${plan.id}/queue`, {
      userId: joao,
      taskIds: [b.id, a.id],
      version: draft.version,
    });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/depende/);
    // Rascunho: sem motivo e sem revisão, mas com versão.
    const okR = await put(admin, `/api/v1/production-plans/${plan.id}/queue`, {
      userId: joao,
      taskIds: [a.id, b.id],
      version: draft.version,
    });
    expect(okR.status).toBe(200);
    const after = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
    expect(after.version).toBe(draft.version + 1);
    expect(after.revisions).toHaveLength(0);
  });

  it('CA2-10/13: semana encerrada mostra pendências; transferência só autorizada, idempotente', async () => {
    const { admin, plan, tasks, joao } = await queuePlan(5);
    const tablet = await tabletOf(app, admin, 'João', '271828');
    for (const t of tasks.slice(0, 2)) {
      await act(tablet, t.id, 'start');
      await act(tablet, t.id, 'complete');
    }
    await act(tablet, tasks[2]!.id, 'start'); // em execução: não transfere
    const next = await queuePlan(1, { weekOf: addDays(MONDAY(), 7) });
    // Sexta: semana não terminou → transferência recusada.
    clockAt(4, '17:00');
    const body = {
      toPlanId: next.plan.id,
      taskIds: [tasks[3]!.id, tasks[4]!.id],
      reason: 'Sobrou da semana',
    };
    expect((await post(admin, `/api/v1/production-plans/${plan.id}/carry-over`, body)).status).toBe(
      422,
    );
    // Sábado: pendências visíveis ao gestor; nada muda sozinho.
    clockAt(5, '09:00');
    await releaseDueTasks(db());
    const p = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
    expect(p).toMatchObject({ weekEnded: true, pendingCount: 3 });
    expect(await db().productionTask.count({ where: { planId: plan.id } })).toBe(5);
    // Funcionário não transfere.
    expect(
      (await post(tablet, `/api/v1/production-plans/${plan.id}/carry-over`, body)).status,
    ).toBe(403);
    // Em execução não é transferível.
    expect(
      (
        await post(admin, `/api/v1/production-plans/${plan.id}/carry-over`, {
          ...body,
          taskIds: [tasks[2]!.id],
        })
      ).status,
    ).toBe(422);
    const key = idemKey();
    const r1 = await post(admin, `/api/v1/production-plans/${plan.id}/carry-over`, body, key);
    expect(r1.status).toBe(200);
    expect(r1.body.moved).toBe(2);
    // Mesma chave: mesma resposta; outra chave: nada a mover (sem duplicar).
    const r2 = await post(admin, `/api/v1/production-plans/${plan.id}/carry-over`, body, key);
    expect(r2.body).toEqual(r1.body);
    const r3 = await post(admin, `/api/v1/production-plans/${plan.id}/carry-over`, body);
    expect(r3.status).toBe(200);
    expect(r3.body.moved).toBe(0);
    const moved = await db().productionTask.findMany({ where: { id: { in: body.taskIds } } });
    expect(moved.every((t) => t.planId === next.plan.id && t.carriedFromPlanId === plan.id)).toBe(
      true,
    );
    expect(moved.every((t) => t.assigneeUserId === joao)).toBe(true);
    expect(await db().productionTask.count({ where: { assigneeUserId: joao } })).toBe(6);
    expect(await db().productionTaskEvent.count({ where: { kind: 'TRANSFERIDA_SEMANA' } })).toBe(2);
    const q = await queueOf(tablet);
    const carried = q.items.filter((e) => e.task.carriedFromWeek === MONDAY());
    expect(carried).toHaveLength(2);
    expect((await admin.get(`/api/v1/production-plans/${plan.id}`)).body.pendingCount).toBe(1);
  });

  it('CA2-13: duplo clique em iniciar/concluir não duplica eventos', async () => {
    const { admin, tasks } = await queuePlan(2);
    const tablet = await tabletOf(app, admin, 'João', '271828');
    const k = idemKey();
    const [s1, s2] = await Promise.all([
      act(tablet, tasks[0]!.id, 'start', {}, k),
      act(tablet, tasks[0]!.id, 'start', {}, k),
    ]);
    // Mesma chave em paralelo: a repetição recebe a resposta gravada ou 409 "em andamento".
    expect([s1.status, s2.status]).toContain(200);
    expect([s1.status, s2.status].every((x) => x === 200 || x === 409)).toBe(true);
    expect((await act(tablet, tasks[0]!.id, 'start')).status).toBe(200); // repetição: nada muda
    const c = await Promise.all([
      act(tablet, tasks[0]!.id, 'complete'),
      act(tablet, tasks[0]!.id, 'complete'),
    ]);
    expect(c.every((r) => r.status === 200)).toBe(true);
    const kinds = (
      await db().productionTaskEvent.findMany({ where: { taskId: tasks[0]!.id } })
    ).map((e) => e.kind);
    expect(kinds.filter((x) => x === 'INICIADA')).toHaveLength(1);
    expect(kinds.filter((x) => x === 'CONCLUIDA')).toHaveLength(1);
  });

  it('WebSocket: publicação, desbloqueio e reordenação chegam; a reconexão recupera o perdido', async () => {
    const { admin, plan, tasks, joao } = await queuePlan(3, { publish: false });
    const tablet = await tabletOf(app, admin, 'João', '271828');
    let w = track(await WsClient.connect(app, tablet));
    const published = await publish(admin, plan);
    await w.waitFor((m) => m.event?.type === 'production.plan_published');
    await post(admin, `/api/v1/production-tasks/${tasks[0]!.id}/block`, { reason: 'Sem cola' });
    await post(admin, `/api/v1/production-tasks/${tasks[0]!.id}/unblock`, { reason: 'Chegou' });
    const rel = await w.waitFor(
      (m) => m.event?.type === 'production.task_released' && m.event.payload.id === tasks[0]!.id,
    );
    const lastSeq = rel.event.seq as string;
    // Queda do tablet; o gestor reordena enquanto ele está desconectado.
    await w.close();
    const r = await put(admin, `/api/v1/production-plans/${plan.id}/queue`, {
      userId: joao,
      taskIds: [tasks[2]!.id, tasks[1]!.id, tasks[0]!.id],
      version: (await admin.get(`/api/v1/production-plans/${plan.id}`)).body.version,
      reason: 'Prioridade do cliente',
    });
    expect(r.status).toBe(200);
    w = track(await WsClient.connect(app, tablet, lastSeq));
    await w.waitFor((m) => m.kind === 'replay.done');
    expect(w.events('production.queue_reordered')).toHaveLength(1);
    expect((await queueOf(tablet)).items.map((e) => e.task.id)).toEqual(
      [2, 1, 0].map((i) => tasks[i]!.id),
    );
    void published;
  });

  it('CA2-14: acesso cruzado e nenhum valor financeiro na fila nem no WebSocket do tablet', async () => {
    const { admin, tasks, joao } = await queuePlan(2);
    const joaoTab = await tabletOf(app, admin, 'João', '271828');
    const thiagoTab = await tabletOf(app, admin, 'Thiago', '314159');
    const ws = track(await WsClient.connect(app, joaoTab));
    // Thiago não inicia tarefa do João nem vê a fila dele.
    expect((await act(thiagoTab, tasks[0]!.id, 'start')).status).toBe(403);
    expect((await thiagoTab.get(`/api/v1/production-queue/${joao}`)).status).toBe(403);
    expect((await queueOf(thiagoTab)).total).toBe(0);
    // Gestão vê a fila de qualquer funcionário.
    expect(((await admin.get(`/api/v1/production-queue/${joao}`)).body as Queue).total).toBe(2);
    await act(joaoTab, tasks[0]!.id, 'start');
    await act(joaoTab, tasks[0]!.id, 'complete');
    await ws.waitFor((m) => m.event?.type === 'production.task_completed');
    const text = JSON.stringify(await queueOf(joaoTab)) + JSON.stringify(ws.messages);
    expect(text).not.toMatch(/Cents"|"(price|unitPrice|laborValue|cost|amount|valor|preco)"/i);
  });
});
