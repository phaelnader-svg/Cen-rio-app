import {
  EVENT_TYPES,
  PRINCIPAL_ACTIVITIES,
  PAUSE_REASON_LABEL,
  PRIORITY_LABEL,
  PRODUCTION_ACTIVITY_LABEL,
  RELEASE_BLOCKER_LABEL,
  TASK_WAITING,
  boardQuerySchema,
  compareTasks,
  createTaskSchema,
  evaluateRelease,
  findCycle,
  formatServiceOrderItemCode,
  localParts,
  completeTaskSchema,
  pauseTaskSchema,
  progressTaskSchema,
  taskMaterialsSchema,
  taskCode,
  taskDependenciesSchema,
  taskReasonSchema,
  updateTaskSchema,
  zonedDateTime,
  type MeasurementDto,
  type ProductionTaskDetailDto,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { Errors } from '../../lib/errors';
import { parseDateOnly } from '../commercial/common';
import { idParams } from '../presenters';
import { notify, taskNotice } from '../notifications/notify';
import { readinessOf } from '../purchasing/common';
import {
  EXECUTE,
  PLAN,
  READ_TASK,
  VIEW,
  canManage,
  canViewAll,
  company,
  domainTaskEvent,
  lockTasks,
  reevaluateTasks,
  taskEvent,
  taskInclude,
  taskMaterialsReady,
  toTaskDto,
} from './common';
import { announceAssignments, assertWorker, reviseIfPublished } from './plans';

const deviceOf = (request: FastifyRequest) => request.auth?.deviceId ?? null;

/** Campos técnicos da OS que podem aparecer no histórico do tablet. */
const TECHNICAL_FIELDS = new Set([
  'description',
  'quantity',
  'serviceType',
  'fabricName',
  'fabricColor',
  'fabricReference',
  'foamSpecs',
  'technicalNotes',
  'technicalInstructions',
  'measurements',
  'measurementNotes',
  'promisedDate',
  'priority',
  'technicalLeadId',
  'notes',
  'added',
  'removed',
  'status',
]);

function eventExtra(kind: string, changes: Prisma.JsonValue | null) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return null;
  const c = changes as Record<string, unknown>;
  if (kind !== 'ANDAMENTO' && kind !== 'CONCLUIDA') return null;
  return {
    percent: typeof c.percent === 'number' ? c.percent : null,
    step: typeof c.step === 'string' ? c.step : null,
    nextStep: typeof c.nextStep === 'string' ? c.nextStep : null,
    attachmentIds: Array.isArray(c.attachmentIds) ? (c.attachmentIds as string[]) : [],
  };
}

async function loadTask(db: Tx | PrismaClient, id: string) {
  const t = await db.productionTask.findUnique({ where: { id }, include: taskInclude });
  if (!t) throw Errors.notFound('Tarefa');
  return t;
}

/** As fotos citadas num registro precisam ser anexos desta tarefa. */
async function assertTaskPhotos(tx: Tx, taskId: string, ids: string[]) {
  if (!ids.length) return;
  const found = await tx.attachment.count({
    where: { id: { in: ids }, entityType: 'PRODUCTION_TASK', entityId: taskId, deletedAt: null },
  });
  if (found !== new Set(ids).size) throw Errors.business('Foto não pertence a esta tarefa.');
}

/** Corte e costura do sofá ficam com o tapeceiro principal da OS na semana. */
async function assertPrincipalRule(
  tx: Tx,
  t: {
    planId: string | null;
    serviceOrderId: string;
    activity: string;
    assigneeUserId: string | null;
  },
) {
  if (!t.planId || !(PRINCIPAL_ACTIVITIES as readonly string[]).includes(t.activity)) return;
  const item = await tx.productionPlanItem.findUnique({
    where: { planId_serviceOrderId: { planId: t.planId, serviceOrderId: t.serviceOrderId } },
  });
  if (item?.principalUserId && t.assigneeUserId && t.assigneeUserId !== item.principalUserId) {
    throw Errors.business(
      `${PRODUCTION_ACTIVITY_LABEL[t.activity as keyof typeof PRODUCTION_ACTIVITY_LABEL]} fica com o tapeceiro principal da OS.`,
    );
  }
}

/** Valida as dependências (mesma OS, sem ciclo) e as grava. */
async function setDependencies(
  tx: Tx,
  task: { id: string; serviceOrderId: string },
  dependsOn: string[],
) {
  const unique = [...new Set(dependsOn)];
  if (unique.includes(task.id)) throw Errors.business('Uma tarefa não pode depender de si mesma.');
  const deps = await tx.productionTask.findMany({ where: { id: { in: unique } } });
  if (deps.length !== unique.length) throw Errors.notFound('Tarefa de dependência');
  if (deps.some((d) => d.serviceOrderId !== task.serviceOrderId)) {
    throw Errors.business('Dependências só entre tarefas da mesma OS.');
  }
  // Grafo da OS com a alteração proposta: recusa qualquer ciclo.
  const all = await tx.taskDependency.findMany({
    where: { task: { serviceOrderId: task.serviceOrderId } },
  });
  const edges = new Map<string, string[]>();
  for (const e of all)
    if (e.taskId !== task.id) edges.set(e.taskId, [...(edges.get(e.taskId) ?? []), e.dependsOnId]);
  edges.set(task.id, unique);
  const cycle = findCycle(edges);
  if (cycle) {
    const codes = await tx.productionTask.findMany({
      where: { id: { in: cycle } },
      select: { id: true, number: true },
    });
    const label = cycle
      .map((c) => taskCode(codes.find((x) => x.id === c)?.number ?? 0))
      .join(' → ');
    throw Errors.business(`Dependência circular recusada: ${label}.`);
  }
  await tx.taskDependency.deleteMany({ where: { taskId: task.id } });
  for (const d of unique)
    await tx.taskDependency.create({ data: { taskId: task.id, dependsOnId: d } });
}

async function scheduledFrom(
  db: Tx | PrismaClient,
  date: string | null | undefined,
  time: string | null | undefined,
  current: Date | null,
) {
  if (date === undefined && time === undefined) return current;
  if (!date) return null;
  const { timezone, workdayStart } = await company(db);
  const cur = current ? localParts(current, timezone) : null;
  return zonedDateTime(date, time ?? cur?.time ?? workdayStart, timezone);
}

export async function productionTaskRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  // ─────────────────────────── Gestão ───────────────────────────

  /** Inclui uma etapa avulsa (adaptação do modelo à OS). */
  app.post(
    '/api/v1/production-plans/:id/tasks',
    { config: { access: PLAN, idempotent: true } },
    async (request, reply) => {
      const { id: planId } = idParams.parse(request.params);
      const input = createTaskSchema.parse(request.body);
      const actor = actorFrom(request);
      const taskId = await prisma.$transaction(async (tx) => {
        const plan = await tx.productionPlan.findUnique({ where: { id: planId } });
        if (!plan) throw Errors.notFound('Planejamento');
        await tx.$queryRaw`SELECT id FROM production_plans WHERE id = ${planId}::uuid FOR UPDATE`;
        const item = await tx.productionPlanItem.findUnique({
          where: { planId_serviceOrderId: { planId, serviceOrderId: input.serviceOrderId } },
          include: { serviceOrder: { include: { items: true } } },
        });
        if (!item) throw Errors.business('Inclua a OS no planejamento antes de criar tarefas.');
        if (
          input.serviceOrderItemId &&
          !item.serviceOrder.items.some((i) => i.id === input.serviceOrderItemId)
        ) {
          throw Errors.business('A peça não pertence a esta OS.');
        }
        if (input.assigneeUserId) await assertWorker(tx, input.assigneeUserId);
        const piece = item.serviceOrder.items.find((i) => i.id === input.serviceOrderItemId);
        const data = {
          planId,
          serviceOrderId: input.serviceOrderId,
          serviceOrderItemId: input.serviceOrderItemId ?? null,
          activity: input.activity,
          title:
            input.title ??
            `${PRODUCTION_ACTIVITY_LABEL[input.activity]}${piece ? ` — ${formatServiceOrderItemCode(item.serviceOrder.number, piece.position)}` : ''}`,
          role: input.role,
          assigneeUserId: input.assigneeUserId ?? null,
          priority: input.priority,
          sequence: (piece?.position ?? 0) * 100 + 50,
          scheduledAt: await scheduledFrom(tx, input.date, input.time, null),
          dueDate: parseDateOnly(input.dueDate ?? null),
          instructions: input.instructions ?? null,
          requiresMaterials: input.requiresMaterials,
          status: plan.status === 'PUBLICADO' ? ('BLOQUEADA' as const) : ('RASCUNHO' as const),
        };
        await assertPrincipalRule(tx, data);
        const t = await tx.productionTask.create({ data });
        await setDependencies(tx, t, input.dependsOn);
        if (plan.status === 'PUBLICADO') {
          await taskEvent(tx, actor, null, t, {
            kind: 'PUBLICADA',
            to: 'BLOQUEADA',
            note: input.reason ?? null,
          });
          await reviseIfPublished(
            tx,
            request,
            planId,
            input.reason,
            `nova tarefa ${taskCode(t.number)}`,
          );
          await reevaluateTasks(tx, actor, [t.id]);
          await announceAssignments(tx, actor, [t.id]);
        }
        return t.id;
      });
      const { timezone } = await company(prisma);
      return reply.status(201).send(toTaskDto(await loadTask(prisma, taskId), timezone));
    },
  );

  /** Reprogramar, trocar responsável/prioridade, instruções. Após publicar: com motivo e revisão. */
  app.put('/api/v1/production-tasks/:id', { config: { access: PLAN } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = updateTaskSchema.parse(request.body);
    const actor = actorFrom(request);
    await prisma.$transaction(async (tx) => {
      await lockTasks(tx, [id]);
      const t = await tx.productionTask.findUnique({ where: { id } });
      if (!t) throw Errors.notFound('Tarefa');
      if (t.version !== input.version) throw Errors.versionConflict(t.version);
      if (t.status === 'CONCLUIDA' || t.status === 'CANCELADA') {
        throw Errors.business('Tarefa concluída ou cancelada não pode ser alterada.');
      }
      const started = t.status === 'EM_EXECUCAO' || t.status === 'PAUSADA';
      if (
        started &&
        input.assigneeUserId !== undefined &&
        input.assigneeUserId !== t.assigneeUserId
      ) {
        throw Errors.business('A tarefa já começou: o responsável não pode ser trocado.');
      }
      if (input.assigneeUserId) await assertWorker(tx, input.assigneeUserId);
      const data: Prisma.ProductionTaskUncheckedUpdateInput = {
        ...(input.title !== undefined ? { title: input.title ?? t.title } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(input.assigneeUserId !== undefined ? { assigneeUserId: input.assigneeUserId } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.date !== undefined || input.time !== undefined
          ? { scheduledAt: await scheduledFrom(tx, input.date, input.time, t.scheduledAt) }
          : {}),
        ...(input.dueDate !== undefined ? { dueDate: parseDateOnly(input.dueDate) } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...(input.requiresMaterials !== undefined
          ? { requiresMaterials: input.requiresMaterials }
          : {}),
        ...(input.completionRequirement
          ? { completionRequirement: input.completionRequirement }
          : {}),
        version: { increment: 1 },
      };
      await assertPrincipalRule(tx, {
        ...t,
        assigneeUserId:
          input.assigneeUserId !== undefined ? input.assigneeUserId : t.assigneeUserId,
      });
      const updated = await tx.productionTask.update({ where: { id }, data });
      if (t.status !== 'RASCUNHO') {
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const k of [
          'assigneeUserId',
          'priority',
          'scheduledAt',
          'dueDate',
          'requiresMaterials',
          'completionRequirement',
          'title',
        ] as const) {
          const a = t[k] instanceof Date ? (t[k] as Date).toISOString() : t[k];
          const b = updated[k] instanceof Date ? (updated[k] as Date).toISOString() : updated[k];
          if (a !== b) changes[k] = { from: a, to: b };
        }
        await taskEvent(tx, actor, null, t, {
          kind: 'REPROGRAMADA',
          note: input.reason ?? null,
          changes,
        });
        await reviseIfPublished(
          tx,
          request,
          t.planId,
          input.reason,
          `alteração de ${taskCode(t.number)}`,
        );
        await reevaluateTasks(tx, actor, [id]);
        if (changes.assigneeUserId) await announceAssignments(tx, actor, [id]);
        const after = await tx.productionTask.findUniqueOrThrow({ where: { id } });
        // Avisos ao funcionário: quem saiu da tarefa, reprogramação e prioridade.
        if (changes.assigneeUserId && t.assigneeUserId) {
          await notify(
            tx,
            actor,
            taskNotice(t, 'TAREFA_REMOVIDA', 'passou para outro responsável.'),
          );
        }
        if (!changes.assigneeUserId) {
          const { timezone } = await company(tx);
          const when = after.scheduledAt ? localParts(after.scheduledAt, timezone) : null;
          if (changes.scheduledAt || changes.dueDate) {
            await notify(
              tx,
              actor,
              taskNotice(
                after,
                'TAREFA_REPROGRAMADA',
                when
                  ? `agora em ${when.date.split('-').reverse().join('/')} às ${when.time}.`
                  : 'sem horário definido.',
              ),
            );
          }
          if (changes.priority) {
            await notify(
              tx,
              actor,
              taskNotice(
                after,
                'PRIORIDADE_ALTERADA',
                `prioridade ${PRIORITY_LABEL[after.priority].toLowerCase()}.`,
              ),
            );
          }
        }
        await domainTaskEvent(
          tx,
          actor,
          EVENT_TYPES.PRODUCTION_DEPENDENCIES_UPDATED,
          after,
          { changed: Object.keys(changes) },
          [t.assigneeUserId],
        );
      }
    });
    const { timezone } = await company(prisma);
    return toTaskDto(await loadTask(prisma, id), timezone);
  });

  app.put(
    '/api/v1/production-tasks/:id/dependencies',
    { config: { access: PLAN } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = taskDependenciesSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        // Bloqueia as tarefas da OS para validar o grafo sem corrida.
        const t0 = await tx.productionTask.findUnique({ where: { id } });
        if (!t0) throw Errors.notFound('Tarefa');
        const ofOs = await tx.productionTask.findMany({
          where: { serviceOrderId: t0.serviceOrderId },
          select: { id: true },
        });
        await lockTasks(
          tx,
          ofOs.map((x) => x.id),
        );
        const t = await tx.productionTask.findUniqueOrThrow({ where: { id } });
        if (t.version !== input.version) throw Errors.versionConflict(t.version);
        if (!['RASCUNHO', ...TASK_WAITING].includes(t.status)) {
          throw Errors.business(
            'Só tarefas que ainda não começaram podem ter dependências alteradas.',
          );
        }
        await setDependencies(tx, t, input.dependsOn);
        await tx.productionTask.update({ where: { id }, data: { version: { increment: 1 } } });
        if (t.status !== 'RASCUNHO') {
          await taskEvent(tx, actor, null, t, {
            kind: 'DEPENDENCIAS',
            note: input.reason ?? null,
            changes: { dependsOn: input.dependsOn },
          });
          await reviseIfPublished(
            tx,
            request,
            t.planId,
            input.reason,
            `dependências de ${taskCode(t.number)}`,
          );
          await reevaluateTasks(tx, actor, [id]);
          const after = await tx.productionTask.findUniqueOrThrow({ where: { id } });
          await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_DEPENDENCIES_UPDATED, after);
        }
      });
      const { timezone } = await company(prisma);
      return toTaskDto(await loadTask(prisma, id), timezone);
    },
  );

  /**
   * Fase 6: materiais aprovados de que a tarefa depende. Com vínculos, a tarefa é
   * liberada quando ESSES materiais estão cobertos (ex.: corte só com o tecido);
   * sem vínculos, continua dependendo da OS inteira. Nunca começa sem eles.
   */
  app.put(
    '/api/v1/production-tasks/:id/materials',
    { config: { access: PLAN } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = taskMaterialsSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        await lockTasks(tx, [id]);
        const t = await tx.productionTask.findUnique({ where: { id } });
        if (!t) throw Errors.notFound('Tarefa');
        if (t.version !== input.version) throw Errors.versionConflict(t.version);
        if (!(TASK_WAITING as readonly string[]).includes(t.status) && t.status !== 'RASCUNHO') {
          throw Errors.business(
            'Só tarefas que ainda não começaram podem ter os materiais alterados.',
          );
        }
        const ids = [...new Set(input.requirementIds)];
        const valid = await tx.materialRequirement.count({
          where: {
            id: { in: ids },
            serviceOrderId: t.serviceOrderId,
            origin: 'SOLICITACAO_APROVADA',
          },
        });
        if (valid !== ids.length) {
          throw Errors.business('Use somente materiais aprovados desta OS.');
        }
        const before = await tx.productionTaskMaterial.findMany({ where: { taskId: id } });
        await tx.productionTaskMaterial.deleteMany({ where: { taskId: id } });
        if (ids.length) {
          await tx.productionTaskMaterial.createMany({
            data: ids.map((requirementId) => ({ taskId: id, requirementId })),
          });
        }
        await tx.productionTask.update({
          where: { id },
          // Vincular materiais implica exigir materiais.
          data: { ...(ids.length ? { requiresMaterials: true } : {}), version: { increment: 1 } },
        });
        if (t.status !== 'RASCUNHO') {
          await taskEvent(tx, actor, null, t, {
            kind: 'MATERIAIS',
            note: input.reason ?? null,
            changes: { from: before.map((b) => b.requirementId), to: ids },
          });
          await reviseIfPublished(
            tx,
            request,
            t.planId,
            input.reason,
            `materiais de ${taskCode(t.number)}`,
          );
          await reevaluateTasks(tx, actor, [id]);
          const after = await tx.productionTask.findUniqueOrThrow({ where: { id } });
          await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_DEPENDENCIES_UPDATED, after, {
            changed: ['materials'],
          });
        }
      });
      const { timezone } = await company(prisma);
      return toTaskDto(await loadTask(prisma, id), timezone);
    },
  );

  async function adminTransition(request: FastifyRequest, kind: 'cancel' | 'block' | 'unblock') {
    const { id } = idParams.parse(request.params);
    const input =
      kind === 'unblock'
        ? { reason: (request.body as { reason?: string })?.reason ?? 'Desbloqueada' }
        : taskReasonSchema.parse(request.body);
    const actor = actorFrom(request);
    await prisma.$transaction(async (tx) => {
      await lockTasks(tx, [id]);
      const t = await tx.productionTask.findUnique({
        where: { id },
        include: { dependents: true },
      });
      if (!t) throw Errors.notFound('Tarefa');
      if (t.status === 'CONCLUIDA' || t.status === 'CANCELADA')
        throw Errors.business('Tarefa já encerrada.');
      if (kind === 'cancel') {
        if (t.status === 'RASCUNHO') {
          await tx.productionTask.delete({ where: { id } });
          return;
        }
        const u = await tx.productionTask.update({
          where: { id },
          data: {
            status: 'CANCELADA',
            cancelReason: input.reason,
            pauseImpediment: false,
            version: { increment: 1 },
          },
        });
        await notify(tx, actor, taskNotice(u, 'TAREFA_CANCELADA', input.reason));
        await taskEvent(tx, actor, null, t, {
          kind: 'CANCELADA',
          from: t.status,
          to: 'CANCELADA',
          note: input.reason,
        });
        await reviseIfPublished(
          tx,
          request,
          t.planId,
          input.reason,
          `cancelamento de ${taskCode(t.number)}`,
        );
        await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_CANCELLED, u);
        await reevaluateTasks(
          tx,
          actor,
          t.dependents.map((d) => d.taskId),
        );
        return;
      }
      if (!(TASK_WAITING as readonly string[]).includes(t.status)) {
        throw Errors.business(
          'Só tarefas que ainda não começaram podem ser bloqueadas ou desbloqueadas.',
        );
      }
      await tx.productionTask.update({
        where: { id },
        data: { blockedReason: kind === 'block' ? input.reason : null, version: { increment: 1 } },
      });
      await taskEvent(tx, actor, null, t, {
        kind: kind === 'block' ? 'BLOQUEIO' : 'DESBLOQUEIO',
        note: input.reason,
      });
      if (kind === 'block') {
        const b = await tx.productionTask.findUniqueOrThrow({ where: { id } });
        await notify(tx, actor, taskNotice(b, 'TAREFA_BLOQUEADA', input.reason));
      }
      await reevaluateTasks(tx, actor, [id]);
    });
    if (kind === 'cancel' && !(await prisma.productionTask.findUnique({ where: { id } })))
      return { deleted: true };
    const { timezone } = await company(prisma);
    return toTaskDto(await loadTask(prisma, id), timezone);
  }
  app.post('/api/v1/production-tasks/:id/cancel', { config: { access: PLAN } }, (r) =>
    adminTransition(r, 'cancel'),
  );
  app.post('/api/v1/production-tasks/:id/block', { config: { access: PLAN } }, (r) =>
    adminTransition(r, 'block'),
  );
  app.post('/api/v1/production-tasks/:id/unblock', { config: { access: PLAN } }, (r) =>
    adminTransition(r, 'unblock'),
  );

  /** Quadro de produção (filtros por pessoa, OS, etapa, status e período). */
  app.get('/api/v1/production-board', { config: { access: VIEW } }, async (request) => {
    const q = boardQuerySchema.parse(request.query);
    const { timezone } = await company(prisma);
    const range =
      q.from || q.to
        ? {
            scheduledAt: {
              ...(q.from ? { gte: zonedDateTime(q.from, '00:00', timezone) } : {}),
              ...(q.to ? { lte: zonedDateTime(q.to, '23:59', timezone) } : {}),
            },
          }
        : {};
    const rows = await prisma.productionTask.findMany({
      where: {
        ...range,
        status: q.status?.length ? { in: q.status } : { not: 'RASCUNHO' },
        ...(q.assigneeUserId ? { assigneeUserId: q.assigneeUserId } : {}),
        ...(q.serviceOrderId ? { serviceOrderId: q.serviceOrderId } : {}),
        ...(q.planId ? { planId: q.planId } : {}),
        ...(q.activity ? { activity: q.activity } : {}),
      },
      include: taskInclude,
      orderBy: [{ scheduledAt: 'asc' }, { sequence: 'asc' }],
      take: 1000,
    });
    return rows.map((t) => toTaskDto(t, timezone)).sort(compareTasks);
  });

  /** Tarefas da OS (aba Produção). */
  app.get(
    '/api/v1/service-orders/:id/production',
    {
      config: {
        access: { session: 'WEB', anyPermissions: ['producao.ver', 'producao.planejar', 'os.ver'] },
      },
    },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { timezone } = await company(prisma);
      const rows = await prisma.productionTask.findMany({
        where: { serviceOrderId: id, status: { not: 'RASCUNHO' } },
        include: taskInclude,
        orderBy: [{ sequence: 'asc' }, { number: 'asc' }],
      });
      return rows.map((t) => toTaskDto(t, timezone));
    },
  );

  // ─────────────────────────── Funcionário ───────────────────────────

  /** Minhas tarefas: as do dia (e atrasadas/em andamento), em ordem de prioridade; e as próximas. */
  app.get('/api/v1/production-tasks/mine', { config: { access: EXECUTE } }, async (request) => {
    const { timezone } = await company(prisma);
    const today = localParts(new Date(), timezone).date;
    const endOfToday = zonedDateTime(today, '23:59', timezone);
    const startOfToday = zonedDateTime(today, '00:00', timezone);
    const rows = await prisma.productionTask.findMany({
      where: {
        assigneeUserId: request.auth!.userId,
        status: { notIn: ['RASCUNHO', 'CANCELADA'] },
        OR: [
          { status: { in: ['EM_EXECUCAO', 'PAUSADA', 'LIBERADA'] } },
          { scheduledAt: { lte: endOfToday }, status: { notIn: ['CONCLUIDA'] } },
          { scheduledAt: { gte: startOfToday, lte: endOfToday } },
          { completedAt: { gte: startOfToday } },
          { scheduledAt: { gt: endOfToday, lte: new Date(endOfToday.getTime() + 7 * 86_400_000) } },
        ],
      },
      include: taskInclude,
    });
    const dtos = rows.map((t) => toTaskDto(t, timezone)).sort(compareTasks);
    return {
      today: dtos.filter(
        (t) =>
          !t.scheduledDate ||
          t.scheduledDate <= today ||
          ['EM_EXECUCAO', 'PAUSADA', 'LIBERADA'].includes(t.status),
      ),
      upcoming: dtos.filter(
        (t) =>
          t.scheduledDate &&
          t.scheduledDate > today &&
          !['EM_EXECUCAO', 'PAUSADA', 'LIBERADA'].includes(t.status),
      ),
    };
  });

  /** Detalhe: gestão vê todas; o funcionário, só as próprias (com a OS correspondente, sem valores). */
  app.get(
    '/api/v1/production-tasks/:id',
    { config: { access: READ_TASK } },
    async (request): Promise<ProductionTaskDetailDto> => {
      const { id } = idParams.parse(request.params);
      const t = await loadTask(prisma, id);
      const me = request.auth!.userId;
      if (!canViewAll(request) && t.assigneeUserId !== me) {
        throw Errors.forbidden('Esta tarefa é de outra pessoa.');
      }
      const { timezone } = await company(prisma);
      const [events, so, readiness, osTasks, links, revisions] = await Promise.all([
        prisma.productionTaskEvent.findMany({
          where: { taskId: id },
          include: { actor: { select: { displayName: true } } },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.serviceOrder.findUniqueOrThrow({
          where: { id: t.serviceOrderId },
          include: { items: { orderBy: { position: 'asc' } } },
        }),
        readinessOf(prisma, t.serviceOrderId),
        prisma.productionTask.findMany({
          where: { serviceOrderId: t.serviceOrderId, status: { not: 'RASCUNHO' } },
          select: {
            id: true,
            number: true,
            title: true,
            status: true,
            assignee: { select: { displayName: true } },
          },
          orderBy: [{ sequence: 'asc' }, { number: 'asc' }],
        }),
        prisma.productionTaskMaterial.findMany({
          where: { taskId: id },
          select: { requirementId: true },
        }),
        prisma.serviceOrderRevision.findMany({
          where: { serviceOrderId: t.serviceOrderId, scope: { not: 'CRIACAO' } },
          include: { changedBy: { select: { displayName: true } } },
          orderBy: { revision: 'desc' },
          take: 30,
        }),
      ]);
      const own = t.assigneeUserId === me && request.auth!.permissions.has('producao.executar');
      const materialIds = links.map((l) => l.requirementId);
      const itemCode = (itemId: string | null) => {
        const it = itemId ? so.items.find((i) => i.id === itemId) : null;
        return it ? formatServiceOrderItemCode(so.number, it.position) : null;
      };
      return {
        ...toTaskDto(t, timezone),
        events: events.map((e) => ({
          id: e.id,
          kind: e.kind,
          fromStatus: e.fromStatus,
          toStatus: e.toStatus,
          note: e.note,
          actor: e.actor?.displayName ?? (e.actorId ? null : 'Sistema'),
          createdAt: e.createdAt.toISOString(),
          extra: eventExtra(e.kind, e.changes),
        })),
        serviceOrderInfo: {
          technicalInstructions: so.technicalInstructions,
          items: so.items.map((i) => ({
            id: i.id,
            code: formatServiceOrderItemCode(so.number, i.position),
            pieceType: i.pieceType,
            description: i.description,
            quantity: i.quantity,
            fabricName: i.fabricName,
            fabricColor: i.fabricColor,
            foamSpecs: i.foamSpecs,
            technicalNotes: i.technicalNotes,
            measurements: Array.isArray(i.measurements)
              ? (i.measurements as unknown as MeasurementDto[])
              : [],
          })),
        },
        materials: readiness.lines,
        materialsState: readiness.state,
        materialIds,
        taskMaterials: !t.requiresMaterials
          ? 'NAO_EXIGE'
          : (await taskMaterialsReady(prisma, t, new Map([[t.serviceOrderId, readiness]])))
            ? 'DISPONIVEIS'
            : 'FALTANDO',
        // Só os nomes dos campos alterados (sem valores): nada comercial chega ao tablet.
        technicalHistory: revisions.map((r) => ({
          revision: r.revision,
          scope: r.scope,
          itemCode: itemCode(r.itemId),
          fields:
            r.changes && typeof r.changes === 'object' && !Array.isArray(r.changes)
              ? Object.keys(r.changes as object).filter((k) => TECHNICAL_FIELDS.has(k))
              : [],
          reason: r.reason,
          changedBy: r.changedBy?.displayName ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
        osTasks: osTasks.map((x) => ({
          id: x.id,
          code: taskCode(x.number),
          title: x.title,
          status: x.status,
          assignee: x.assignee?.displayName ?? null,
        })),
        can: {
          start: own && t.status === 'LIBERADA',
          pause: own && t.status === 'EM_EXECUCAO',
          resume: own && t.status === 'PAUSADA',
          progress: own && (t.status === 'EM_EXECUCAO' || t.status === 'PAUSADA'),
          complete: own && t.status === 'EM_EXECUCAO',
          manage: canManage(request),
        },
      };
    },
  );

  /**
   * Execução pelo próprio responsável. Tudo é revalidado no servidor, com a tarefa
   * bloqueada; repetir a mesma ação não gera novos registros nem eventos.
   */
  async function execute(
    request: FastifyRequest,
    action: 'start' | 'pause' | 'resume' | 'progress' | 'complete',
  ) {
    const { id } = idParams.parse(request.params);
    const pause = action === 'pause' ? pauseTaskSchema.parse(request.body) : null;
    const progress = action === 'progress' ? progressTaskSchema.parse(request.body) : null;
    const completion = action === 'complete' ? completeTaskSchema.parse(request.body ?? {}) : null;
    const actor = actorFrom(request);
    const device = deviceOf(request);
    await prisma.$transaction(async (tx) => {
      await lockTasks(tx, [id]);
      const t = await tx.productionTask.findUnique({
        where: { id },
        include: {
          plan: { select: { status: true } },
          serviceOrder: {
            select: {
              status: true,
              items: { select: { id: true, orderItem: { select: { receivedQuantity: true } } } },
            },
          },
          dependsOn: { include: { dependsOn: { select: { status: true } } } },
          dependents: true,
        },
      });
      if (!t) throw Errors.notFound('Tarefa');
      if (t.assigneeUserId !== request.auth!.userId) {
        throw Errors.forbidden('Esta tarefa é de outra pessoa.');
      }
      if (t.serviceOrder.status !== 'ABERTA') throw Errors.business('A OS não está ativa.');
      const now = new Date();

      if (action === 'start') {
        if (t.status === 'EM_EXECUCAO') return; // repetição: nada muda
        if (!(TASK_WAITING as readonly string[]).includes(t.status)) {
          throw Errors.business('Esta tarefa não pode ser iniciada agora.');
        }
        // Verificação completa no momento do início (não confia no estado salvo nem no tablet).
        const items = t.serviceOrderItemId
          ? t.serviceOrder.items.filter((i) => i.id === t.serviceOrderItemId)
          : t.serviceOrder.items;
        const check = evaluateRelease({
          osActive: true,
          pieceReceived: items.length > 0 && items.every((i) => i.orderItem.receivedQuantity > 0),
          published: t.plan?.status === 'PUBLICADO',
          assigned: true,
          dependenciesDone: t.dependsOn.every(
            (d) => d.dependsOn.status === 'CONCLUIDA' || d.dependsOn.status === 'CANCELADA',
          ),
          materialsReady: await taskMaterialsReady(tx, t),
          requiresMaterials: t.requiresMaterials,
          manuallyBlocked: Boolean(t.blockedReason),
          scheduledAt: t.scheduledAt,
          now,
        });
        if (check.status !== 'LIBERADA') {
          const why = check.blockers.length
            ? check.blockers.map((b) => RELEASE_BLOCKER_LABEL[b]).join('; ')
            : 'o horário programado ainda não chegou';
          throw Errors.business(`A tarefa ainda não está liberada: ${why}.`);
        }
        const u = await tx.productionTask.update({
          where: { id },
          data: {
            status: 'EM_EXECUCAO',
            startedAt: t.startedAt ?? now,
            blockers: [],
            version: { increment: 1 },
          },
        });
        await taskEvent(tx, actor, device, t, {
          kind: 'INICIADA',
          from: t.status,
          to: 'EM_EXECUCAO',
        });
        await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_STARTED, u);
        return;
      }
      if (action === 'pause') {
        if (t.status === 'PAUSADA') return;
        if (t.status !== 'EM_EXECUCAO')
          throw Errors.business('Só tarefas em execução podem ser pausadas.');
        const u = await tx.productionTask.update({
          where: { id },
          data: {
            status: 'PAUSADA',
            pauseReason: pause!.reason,
            pauseNote: pause!.note ?? null,
            pauseImpediment: pause!.impediment,
            version: { increment: 1 },
          },
        });
        await taskEvent(tx, actor, device, t, {
          kind: 'PAUSADA',
          from: 'EM_EXECUCAO',
          to: 'PAUSADA',
          note: pause!.note ?? PAUSE_REASON_LABEL[pause!.reason],
          changes: { reason: pause!.reason, impediment: pause!.impediment },
        });
        await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_PAUSED, u, {
          reason: pause!.reason,
          impediment: pause!.impediment,
        });
        // Impedimento real: evento próprio, pronto para a futura central de atenção (Fase 7+).
        if (pause!.impediment) {
          await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_IMPEDIMENT, u, {
            reason: pause!.reason,
            note: pause!.note ?? null,
          });
        }
        return;
      }
      if (action === 'resume') {
        if (t.status === 'EM_EXECUCAO') return;
        if (t.status !== 'PAUSADA')
          throw Errors.business('Só tarefas pausadas podem ser retomadas.');
        const u = await tx.productionTask.update({
          where: { id },
          data: {
            status: 'EM_EXECUCAO',
            pauseReason: null,
            pauseNote: null,
            pauseImpediment: false,
            version: { increment: 1 },
          },
        });
        await taskEvent(tx, actor, device, t, {
          kind: 'RETOMADA',
          from: 'PAUSADA',
          to: 'EM_EXECUCAO',
        });
        await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_RESUMED, u);
        return;
      }
      if (action === 'progress') {
        if (t.status !== 'EM_EXECUCAO' && t.status !== 'PAUSADA') {
          throw Errors.business('Registre andamento de tarefas iniciadas.');
        }
        await assertTaskPhotos(tx, id, progress!.attachmentIds);
        const u = await tx.productionTask.update({
          where: { id },
          data: {
            progressNote: progress!.note ?? null,
            progressPercent: progress!.percent ?? t.progressPercent,
            progressStep: progress!.step ?? null,
            progressNext: progress!.nextStep ?? null,
            progressAt: now,
            version: { increment: 1 },
          },
        });
        await taskEvent(tx, actor, device, t, {
          kind: 'ANDAMENTO',
          note: progress!.note ?? null,
          changes: {
            percent: progress!.percent ?? null,
            step: progress!.step ?? null,
            nextStep: progress!.nextStep ?? null,
            attachmentIds: progress!.attachmentIds,
          },
        });
        await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_PROGRESS, u);
        return;
      }
      // Conclusão
      if (t.status === 'CONCLUIDA') return; // conclusão repetida: sem novos eventos nem liberações
      if (t.status !== 'EM_EXECUCAO')
        throw Errors.business('Só tarefas em execução podem ser concluídas.');
      // Registro adicional só quando a etapa exige (regra técnica definida pelo gestor).
      if (t.completionRequirement === 'OBSERVACAO' && !completion!.note) {
        throw Errors.business('Esta tarefa exige uma observação de conclusão.');
      }
      await assertTaskPhotos(tx, id, completion!.attachmentIds);
      if (t.completionRequirement === 'FOTO') {
        const photos = await tx.attachment.count({
          where: { entityType: 'PRODUCTION_TASK', entityId: id, deletedAt: null },
        });
        if (photos === 0) throw Errors.business('Esta tarefa exige uma foto antes de concluir.');
      }
      const u = await tx.productionTask.update({
        where: { id },
        data: {
          status: 'CONCLUIDA',
          completedAt: now,
          completedById: actor.userId,
          completedDeviceId: device,
          completionNote: completion!.note ?? null,
          progressPercent: 100,
          version: { increment: 1 },
        },
      });
      await taskEvent(tx, actor, device, t, {
        kind: 'CONCLUIDA',
        from: 'EM_EXECUCAO',
        to: 'CONCLUIDA',
        note: completion!.note ?? null,
        changes: completion!.attachmentIds.length
          ? { attachmentIds: completion!.attachmentIds }
          : undefined,
      });
      await audit(tx, actor, {
        action: 'production.task_completed',
        entityType: 'production_task',
        entityId: id,
        summary: `Tarefa ${taskCode(t.number)} (${t.title}) concluída.`,
      });
      await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_COMPLETED, u);
      // Reavalia as dependentes (bloqueadas): as elegíveis são liberadas e o responsável é avisado.
      await reevaluateTasks(
        tx,
        actor,
        t.dependents.map((d) => d.taskId),
        now,
      );
      // Quem depende desta e ainda não foi liberado fica sabendo do avanço
      // (os liberados já recebem "Tarefa liberada" do motor de liberação).
      const dependents = await tx.productionTask.findMany({
        where: { id: { in: t.dependents.map((d) => d.taskId) } },
      });
      for (const d of dependents) {
        if (d.status === 'LIBERADA' || !d.assigneeUserId) continue;
        await notify(tx, actor, [
          {
            userId: d.assigneeUserId,
            kind: 'DEPENDENCIA_CONCLUIDA',
            dedupeKey: `DEPENDENCIA_CONCLUIDA:${d.id}:${id}`,
            body: `${taskCode(d.number)} · ${d.title} — ${t.title} foi concluída.`,
            taskId: d.id,
            serviceOrderId: d.serviceOrderId,
          },
        ]);
      }
    });
    const { timezone } = await company(prisma);
    return toTaskDto(await loadTask(prisma, id), timezone);
  }
  app.post(
    '/api/v1/production-tasks/:id/start',
    { config: { access: EXECUTE, idempotent: true } },
    (r) => execute(r, 'start'),
  );
  app.post('/api/v1/production-tasks/:id/pause', { config: { access: EXECUTE } }, (r) =>
    execute(r, 'pause'),
  );
  app.post('/api/v1/production-tasks/:id/resume', { config: { access: EXECUTE } }, (r) =>
    execute(r, 'resume'),
  );
  app.post('/api/v1/production-tasks/:id/progress', { config: { access: EXECUTE } }, (r) =>
    execute(r, 'progress'),
  );
  app.post(
    '/api/v1/production-tasks/:id/complete',
    { config: { access: EXECUTE, idempotent: true } },
    (r) => execute(r, 'complete'),
  );
}
