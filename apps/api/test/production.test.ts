import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { releaseDueTasks } from '../src/modules/production/common';
import { panelUserWith } from './commercial-helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import {
  act,
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
  type Task,
} from './production-helpers';
import { confirmedFabricPurchase, createSupplier, ok, receive } from './purchasing-helpers';

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

/** Sofá com Ricardo como principal e João no apoio; publica a semana. */
async function publishedSofa(materials: 'none' | 'missing' | 'complete', date = day(-1)) {
  const admin = await loginAdmin(app);
  const { so, reqs } = await serviceOrderWith(admin, materials);
  const ricardo = await userIdOf('Ricardo');
  const joao = await userIdOf('João');
  const plan = await createPlan(admin);
  const added = await addOs(admin, plan.id, {
    serviceOrderId: so.id,
    principalUserId: ricardo,
    date,
  });
  expect(added.status).toBe(201);
  for (const a of ['DESMONTAGEM', 'PREPARACAO'])
    await assign(admin, sofaTask(added.body, so.items[0].id, a), joao);
  const draft = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
  const published = await publish(admin, draft);
  const t = (a: string) => sofaTask(published, so.items[0].id, a);
  return { admin, so, reqs, plan: published, ricardo, joao, t };
}

describe('Planejamento semanal', () => {
  it('sexta-feira (dia configurado): rascunho, modelos, publicação e revisão 1', async () => {
    const admin = await loginAdmin(app);
    // Torna "hoje" o dia de planejamento para registrar uma publicação dentro da rotina.
    const wd = new Date(`${today()}T12:00:00Z`).getUTCDay();
    await db().companySettings.update({ where: { id: 1 }, data: { planningWeekday: wd } });
    const { so } = await serviceOrderWith(admin, 'none');
    const plan = await createPlan(admin);
    expect(plan.status).toBe('RASCUNHO');
    expect(new Date(`${plan.weekStart}T12:00:00Z`).getUTCDay()).toBe(1);
    // Mesma semana não tem dois planejamentos.
    const dup = await admin.post(
      '/api/v1/production-plans',
      { weekStart: today() },
      { 'idempotency-key': idemKey() },
    );
    expect(dup.status).toBe(409);

    const cands = (await admin.get(`/api/v1/production-plans/${plan.id}/candidates`)).body;
    expect(cands[0]).toMatchObject({
      serviceOrder: { code: so.code },
      materialsState: 'SEM_LEVANTAMENTO',
      inPlan: false,
    });

    const ricardo = await userIdOf('Ricardo');
    const added = (
      await addOs(admin, plan.id, {
        serviceOrderId: so.id,
        principalUserId: ricardo,
        date: today(),
      })
    ).body;
    const sofa = added.tasks.filter((t: Task) => t.serviceOrderItem?.id === so.items[0].id);
    expect(sofa.map((t: Task) => t.activity)).toEqual([
      'DESMONTAGEM',
      'PREPARACAO',
      'CORTE_TECIDO',
      'COSTURA',
      'MONTAGEM',
      'ACABAMENTO',
    ]);
    // Montagem depende da preparação E da costura (grafo, não sequência rígida).
    const montagem = sofaTask(added, so.items[0].id, 'MONTAGEM');
    expect(montagem.dependsOn.map((d) => d.id).sort()).toEqual(
      [
        sofaTask(added, so.items[0].id, 'PREPARACAO').id,
        sofaTask(added, so.items[0].id, 'COSTURA').id,
      ].sort(),
    );
    // Corte e costura do sofá ficam com o tapeceiro principal.
    expect(sofaTask(added, so.items[0].id, 'COSTURA').assignee!.userId).toBe(ricardo);
    expect(added.tasks.every((t: Task) => t.status === 'RASCUNHO')).toBe(true);
    expect(added.conflicts.map((c: { kind: string }) => c.kind)).toEqual(
      expect.arrayContaining(['SEM_RESPONSAVEL']),
    );

    // Rascunho não chega aos tablets.
    const ricardoTablet = await tabletOf(app, admin, 'Ricardo', '482915');
    expect((await ricardoTablet.get('/api/v1/production-tasks/mine')).body.today).toEqual([]);
    expect(
      (await act(ricardoTablet, sofaTask(added, so.items[0].id, 'CORTE_TECIDO').id, 'start'))
        .status,
    ).toBe(422);

    const published = await publish(admin, added);
    expect(published).toMatchObject({ status: 'PUBLICADO', revision: 1 });
    expect(published.revisions[0]).toMatchObject({ revision: 1, offSchedule: false });
    expect(published.tasks.every((t: Task) => t.status === 'BLOQUEADA')).toBe(true);
    expect(
      (await ricardoTablet.get('/api/v1/production-tasks/mine')).body.today.length,
    ).toBeGreaterThan(0);
    // Publicar de novo: recusado (alterações viram revisões).
    const again = await admin.post(
      `/api/v1/production-plans/${plan.id}/publish`,
      { version: published.version },
      { 'idempotency-key': idemKey() },
    );
    expect(again.status).toBe(422);
  });

  it('em outro dia: permitido e registrado como fora da rotina; revisão preserva a versão anterior', async () => {
    const wd = new Date(`${today()}T12:00:00Z`).getUTCDay();
    await db().companySettings.update({
      where: { id: 1 },
      data: { planningWeekday: (wd + 1) % 7 },
    });
    const { admin, plan, t, joao } = await publishedSofa('none');
    expect(plan.revisions[0]).toMatchObject({ revision: 1, offSchedule: true });
    const marcio = await userIdOf('Márcio');
    // Alteração depois da publicação exige motivo.
    const noReason = await admin.put(`/api/v1/production-tasks/${t('PREPARACAO').id}`, {
      assigneeUserId: await userIdOf('Thiago'),
      version: t('PREPARACAO').version,
    });
    expect(noReason.status).toBe(400);
    const revised = await assign(
      admin,
      t('PREPARACAO'),
      await userIdOf('Thiago'),
      'João em outra OS na terça',
    );
    expect(revised.assignee!.userId).not.toBe(joao);
    const after = (await admin.get(`/api/v1/production-plans/${plan.id}`)).body;
    expect(after.revision).toBe(2);
    expect(
      after.revisions.map((r: { revision: number; reason: string }) => [r.revision, r.reason]),
    ).toEqual([
      [2, 'João em outra OS na terça'],
      [1, 'Semana fictícia'],
    ]);
    const r1 = await db().productionPlanRevision.findFirstOrThrow({
      where: { planId: plan.id, revision: 1 },
    });
    const prep1 = (r1.snapshot as { id: string; assigneeUserId: string }[]).find(
      (x) => x.id === t('PREPARACAO').id,
    )!;
    expect(prep1.assigneeUserId).toBe(joao);
    await expect(db().$executeRawUnsafe('DELETE FROM production_plan_revisions')).rejects.toThrow();
    // Corte/costura não podem sair do tapeceiro principal.
    const wrong = await admin.put(`/api/v1/production-tasks/${t('COSTURA').id}`, {
      assigneeUserId: marcio,
      version: t('COSTURA').version,
      reason: 'teste',
    });
    expect(wrong.status).toBe(422);
    const events = await db().productionTaskEvent.findMany({
      where: { taskId: t('PREPARACAO').id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['PUBLICADA', 'REPROGRAMADA']),
    );
  });

  it('responsável principal do sofá: obrigatório e tapeceiro', async () => {
    const admin = await loginAdmin(app);
    const { so } = await serviceOrderWith(admin, 'none');
    const plan = await createPlan(admin);
    const none = await addOs(admin, plan.id, { serviceOrderId: so.id, principalUserId: null });
    expect(none.status).toBe(422);
    const helper = await addOs(admin, plan.id, {
      serviceOrderId: so.id,
      principalUserId: await userIdOf('João'),
    });
    expect(helper.status).toBe(422);
    expect(helper.body.error.message).toMatch(/tapeceiro/);
    const okRes = await addOs(admin, plan.id, {
      serviceOrderId: so.id,
      principalUserId: await userIdOf('Márcio'),
    });
    expect(okRes.status).toBe(201);
    // Troca de principal leva junto as tarefas do principal.
    const item = okRes.body.items[0];
    const changed = await admin.put(`/api/v1/production-plans/${plan.id}/items/${item.id}`, {
      principalUserId: await userIdOf('Ricardo'),
    });
    expect(sofaTask(changed.body, so.items[0].id, 'CORTE_TECIDO').assignee?.userId).toBe(
      await userIdOf('Ricardo'),
    );
  });

  it('dependência circular é recusada', async () => {
    const { admin, t } = await publishedSofa('none');
    const desmontagem = t('DESMONTAGEM');
    const cyc = await admin.put(`/api/v1/production-tasks/${desmontagem.id}/dependencies`, {
      dependsOn: [t('ACABAMENTO').id],
      version: desmontagem.version,
      reason: 'teste',
    });
    expect(cyc.status).toBe(422);
    expect(cyc.body.error.message).toMatch(/circular/);
    const self = await admin.put(`/api/v1/production-tasks/${desmontagem.id}/dependencies`, {
      dependsOn: [desmontagem.id],
      version: desmontagem.version,
      reason: 'teste',
    });
    expect(self.status).toBe(422);
  });
});

describe('Liberação e materiais', () => {
  it('material incompleto bloqueia corte/costura; desmontagem segue liberada; chegada libera', async () => {
    const { admin, reqs, t } = await publishedSofa('missing');
    expect(t('DESMONTAGEM').status).toBe('LIBERADA');
    expect(t('CORTE_TECIDO')).toMatchObject({ status: 'BLOQUEADA', blockers: ['MATERIAIS'] });
    expect(t('COSTURA').blockers).toEqual(expect.arrayContaining(['DEPENDENCIAS', 'MATERIAIS']));
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482915');
    const early = await act(ricardo, t('CORTE_TECIDO').id, 'start');
    expect(early.status).toBe(422);
    expect(early.body.error.message).toMatch(/Materiais/);

    // Materiais chegam (Fase 4) → a prontidão completa reavalia e libera o corte.
    const supplier = await createSupplier(admin);
    const po = await confirmedFabricPurchase(admin, supplier.id, reqs[0]!);
    await receive(admin, po.id, [ok(po.items[0].id, 12)]);
    const corte = (await admin.get(`/api/v1/production-tasks/${t('CORTE_TECIDO').id}`)).body;
    expect(corte).toMatchObject({ status: 'LIBERADA', blockers: [] });
    expect(corte.events.map((e: { kind: string }) => e.kind)).toContain('LIBERADA');
  });

  it('material completo: corte liberado na publicação; antes do horário só programada', async () => {
    const { admin, t } = await publishedSofa('complete', day(2));
    expect(t('CORTE_TECIDO').status).toBe('PROGRAMADA');
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482915');
    const early = await act(ricardo, t('CORTE_TECIDO').id, 'start');
    expect(early.status).toBe(422);
    expect(early.body.error.message).toMatch(/horário/);
    // O relógio chega ao horário programado → liberação periódica (idempotente).
    const future = new Date(Date.now() + 3 * 86_400_000);
    expect(await releaseDueTasks(app.ctx.prisma, future)).toBeGreaterThan(0);
    const released = (await admin.get(`/api/v1/production-tasks/${t('CORTE_TECIDO').id}`)).body;
    expect(released.status).toBe('LIBERADA');
    await releaseDueTasks(app.ctx.prisma, future);
    expect(
      await db().domainEvent.count({
        where: { type: 'production.task_released', aggregateId: t('CORTE_TECIDO').id },
      }),
    ).toBe(1);
  });
});

describe('Execução pelos tablets', () => {
  it('João e Ricardo em paralelo; montagem depende de preparação e costura; liberação automática', async () => {
    const { admin, t } = await publishedSofa('complete');
    const joao = await tabletOf(app, admin, 'João', '121212');
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482915');

    // Tarefas do dia, ordenadas (liberadas antes das bloqueadas).
    const mine = (await joao.get('/api/v1/production-tasks/mine')).body.today;
    expect(mine.map((x: Task) => x.activity)).toEqual(['DESMONTAGEM', 'PREPARACAO']);
    expect(JSON.stringify(mine)).not.toMatch(/agreedValue|paymentTerms|Cents/);

    // Execução simultânea.
    expect((await act(joao, t('DESMONTAGEM').id, 'start')).body.status).toBe('EM_EXECUCAO');
    expect((await act(ricardo, t('CORTE_TECIDO').id, 'start')).body.status).toBe('EM_EXECUCAO');
    // Ninguém mexe na tarefa de outro.
    expect((await act(ricardo, t('DESMONTAGEM').id, 'complete')).status).toBe(403);
    expect((await ricardo.get(`/api/v1/production-tasks/${t('DESMONTAGEM').id}`)).status).toBe(403);

    // Pausa e retomada preservam o andamento.
    const pauseNoNote = await act(joao, t('DESMONTAGEM').id, 'pause', { reason: 'OUTRO' });
    expect(pauseNoNote.status).toBe(400);
    await act(joao, t('DESMONTAGEM').id, 'progress', { note: 'Braços desmontados', percent: 60 });
    const paused = await act(joao, t('DESMONTAGEM').id, 'pause', { reason: 'FIM_EXPEDIENTE' });
    expect(paused.body).toMatchObject({ status: 'PAUSADA', pauseReason: 'FIM_EXPEDIENTE' });
    expect((await act(joao, t('DESMONTAGEM').id, 'complete')).status).toBe(422);
    const resumed = await act(joao, t('DESMONTAGEM').id, 'resume');
    expect(resumed.body).toMatchObject({
      status: 'EM_EXECUCAO',
      lastProgress: { note: 'Braços desmontados', percent: 60 },
    });
    await act(joao, t('DESMONTAGEM').id, 'complete');

    // Preparação liberada pela desmontagem.
    let prep = (await joao.get(`/api/v1/production-tasks/${t('PREPARACAO').id}`)).body;
    expect(prep.status).toBe('LIBERADA');
    await act(joao, prep.id, 'start');
    await act(joao, prep.id, 'complete');
    prep = (await joao.get(`/api/v1/production-tasks/${t('PREPARACAO').id}`)).body;
    expect(prep.status).toBe('CONCLUIDA');

    // Montagem ainda espera a costura (dependência de duas tarefas).
    let montagem = (await admin.get(`/api/v1/production-tasks/${t('MONTAGEM').id}`)).body;
    expect(montagem).toMatchObject({ status: 'BLOQUEADA', blockers: ['DEPENDENCIAS'] });
    await act(ricardo, t('CORTE_TECIDO').id, 'complete');
    await act(ricardo, t('COSTURA').id, 'start');
    // A conclusão do apoio não conclui a tarefa principal.
    expect((await admin.get(`/api/v1/production-tasks/${t('COSTURA').id}`)).body.status).toBe(
      'EM_EXECUCAO',
    );
    const done = await act(ricardo, t('COSTURA').id, 'complete');
    expect(done.body.status).toBe('CONCLUIDA');
    montagem = (await ricardo.get(`/api/v1/production-tasks/${t('MONTAGEM').id}`)).body;
    expect(montagem.status).toBe('LIBERADA');
    expect(montagem.can.start).toBe(true);
    const doneRow = await db().productionTask.findUniqueOrThrow({ where: { id: t('COSTURA').id } });
    expect(doneRow.completedDeviceId).not.toBeNull();
    expect(await db().auditLog.count({ where: { action: 'production.task_completed' } })).toBe(4);
  });

  it('conclusão duplicada e concluções simultâneas não duplicam eventos nem liberações', async () => {
    const { admin, t } = await publishedSofa('complete');
    const joao = await tabletOf(app, admin, 'João', '121212');
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482915');
    for (const [c, a] of [
      [joao, 'DESMONTAGEM'],
      [joao, 'PREPARACAO'],
      [ricardo, 'CORTE_TECIDO'],
    ] as const) {
      await act(c, t(a).id, 'start');
      if (a !== 'PREPARACAO') await act(c, t(a).id, 'complete');
    }
    await act(ricardo, t('COSTURA').id, 'start');
    // Mesma chave (rede instável) e chave diferente: só um efeito.
    const key = idemKey();
    const first = await act(joao, t('PREPARACAO').id, 'complete', {}, key);
    const replay = await act(joao, t('PREPARACAO').id, 'complete', {}, key);
    expect(replay.body.version).toBe(first.body.version);
    // Concluções simultâneas das duas dependências da montagem.
    const [a, b] = await Promise.all([
      act(ricardo, t('COSTURA').id, 'complete'),
      act(joao, t('PREPARACAO').id, 'complete'),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const completed = await db().domainEvent.count({
      where: { type: 'production.task_completed', aggregateId: t('PREPARACAO').id },
    });
    expect(completed).toBe(1);
    const released = await db().domainEvent.count({
      where: { type: 'production.task_released', aggregateId: t('MONTAGEM').id },
    });
    expect(released).toBe(1);
    // Dois "iniciar" simultâneos da montagem: um só início registrado.
    await Promise.all([
      act(ricardo, t('MONTAGEM').id, 'start'),
      act(ricardo, t('MONTAGEM').id, 'start'),
    ]);
    expect(
      await db().productionTaskEvent.count({
        where: { taskId: t('MONTAGEM').id, kind: 'INICIADA' },
      }),
    ).toBe(1);
  });
});

describe('Permissões e integridade com fases anteriores', () => {
  it('somente o gestor planeja; funcionários só as próprias tarefas', async () => {
    const { admin, so, t, plan } = await publishedSofa('complete');
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482915');
    const marcio = await tabletOf(app, admin, 'Márcio', '736152');
    expect((await ricardo.get('/api/v1/production-board')).status).toBe(403);
    expect(
      (
        await ricardo.put(`/api/v1/production-tasks/${t('CORTE_TECIDO').id}`, {
          priority: 'URGENTE',
          version: 1,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await ricardo.post(
          '/api/v1/production-plans',
          { weekStart: today() },
          { 'idempotency-key': idemKey() },
        )
      ).status,
    ).toBe(403);
    expect((await act(marcio, t('CORTE_TECIDO').id, 'start')).status).toBe(403);
    expect((await marcio.get('/api/v1/production-tasks/mine')).body.today).toEqual([]);
    const viewer = await panelUserWith(app, admin, 'consulta', ['producao.ver']);
    expect((await viewer.get('/api/v1/production-board')).status).toBe(200);
    expect((await viewer.get(`/api/v1/production-plans/${plan.id}`)).status).toBe(200);
    expect(
      (
        await viewer.post(`/api/v1/production-tasks/${t('CORTE_TECIDO').id}/block`, {
          reason: 'x teste',
        })
      ).status,
    ).toBe(403);
    // Gestor bloqueia: a tarefa não pode começar.
    const blocked = await admin.post(`/api/v1/production-tasks/${t('CORTE_TECIDO').id}/block`, {
      reason: 'Aguardar cliente',
    });
    expect(blocked.body).toMatchObject({ status: 'BLOQUEADA', blockers: ['BLOQUEIO'] });
    expect((await act(ricardo, t('CORTE_TECIDO').id, 'start')).status).toBe(422);
    await admin.post(`/api/v1/production-tasks/${t('CORTE_TECIDO').id}/unblock`, {});
    expect((await act(ricardo, t('CORTE_TECIDO').id, 'start')).status).toBe(200);
    // Fotos da OS: o responsável pela tarefa pode ver; quem não tem tarefa na OS, não.
    expect(
      (await ricardo.get(`/api/v1/attachments?entityType=SERVICE_ORDER&entityId=${so.id}`)).status,
    ).toBe(200);
    expect(
      (await marcio.get(`/api/v1/attachments?entityType=SERVICE_ORDER&entityId=${so.id}`)).status,
    ).toBe(403);
    // Atualizações simultâneas do gestor com a mesma versão: só uma é aceita.
    const acab = (await admin.get(`/api/v1/production-tasks/${t('ACABAMENTO').id}`)).body;
    const edits = await Promise.all(
      (['ALTA', 'URGENTE'] as const).map((priority) =>
        admin.put(`/api/v1/production-tasks/${acab.id}`, {
          priority,
          reason: 'Ajuste de prioridade',
          version: acab.version,
        }),
      ),
    );
    expect(edits.map((e) => e.status).sort()).toEqual([200, 409]);
  });

  it('OS cancelada: tarefas canceladas, reservas liberadas, nada pode começar', async () => {
    const { admin, so, t } = await publishedSofa('complete');
    const ricardo = await tabletOf(app, admin, 'Ricardo', '482915');
    const os = (await admin.get(`/api/v1/service-orders/${so.id}`)).body;
    const cancel = await admin.post(`/api/v1/service-orders/${so.id}/cancel`, {
      reason: 'Cliente desistiu',
      version: os.version,
    });
    expect(cancel.status).toBe(200);
    const corte = await db().productionTask.findUniqueOrThrow({
      where: { id: t('CORTE_TECIDO').id },
    });
    expect(corte.status).toBe('CANCELADA');
    expect((await act(ricardo, t('CORTE_TECIDO').id, 'start')).status).toBe(422);
    expect((await ricardo.get('/api/v1/production-tasks/mine')).body.today).toEqual([]);
    // Nenhuma rota inicia produção fora das tarefas publicadas (nada além de start/pause/resume/progress/complete).
    expect(app.app.printRoutes()).not.toMatch(/start-production|iniciar-producao/);
  });
});
