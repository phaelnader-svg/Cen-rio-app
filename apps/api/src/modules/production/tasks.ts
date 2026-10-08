import {
  EVENT_TYPES,
  PRINCIPAL_ACTIVITIES,
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
  pauseTaskSchema,
  progressTaskSchema,
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
  toTaskDto,
} from './common';
import { announceAssignments, assertWorker, reviseIfPublished } from './plans';

const deviceOf = (request: FastifyRequest) => request.auth?.deviceId ?? null;

async function loadTask(db: Tx | PrismaClient, id: string) {
  const t = await db.productionTask.findUnique({ where: { id }, include: taskInclude });
  if (!t) throw Errors.notFound('Tarefa');
  return t;
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
          data: { status: 'CANCELADA', cancelReason: input.reason, version: { increment: 1 } },
        });
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
      const [events, so, readiness, osTasks] = await Promise.all([
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
      ]);
      const own = t.assigneeUserId === me && request.auth!.permissions.has('producao.executar');
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
          materialsReady:
            !t.requiresMaterials || (await readinessOf(tx, t.serviceOrderId)).state === 'COMPLETO',
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
            version: { increment: 1 },
          },
        });
        await taskEvent(tx, actor, device, t, {
          kind: 'PAUSADA',
          from: 'EM_EXECUCAO',
          to: 'PAUSADA',
          note: pause!.note ?? pause!.reason,
          changes: { reason: pause!.reason },
        });
        await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_PAUSED, u);
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
        const u = await tx.productionTask.update({
          where: { id },
          data: {
            progressNote: progress!.note,
            progressPercent: progress!.percent ?? t.progressPercent,
            progressAt: now,
            version: { increment: 1 },
          },
        });
        await taskEvent(tx, actor, device, t, {
          kind: 'ANDAMENTO',
          note: progress!.note,
          changes: { percent: progress!.percent ?? null },
        });
        await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_PROGRESS, u);
        return;
      }
      // Conclusão
      if (t.status === 'CONCLUIDA') return; // conclusão repetida: sem novos eventos nem liberações
      if (t.status !== 'EM_EXECUCAO')
        throw Errors.business('Só tarefas em execução podem ser concluídas.');
      const u = await tx.productionTask.update({
        where: { id },
        data: {
          status: 'CONCLUIDA',
          completedAt: now,
          completedById: actor.userId,
          completedDeviceId: device,
          progressPercent: 100,
          version: { increment: 1 },
        },
      });
      await taskEvent(tx, actor, device, t, {
        kind: 'CONCLUIDA',
        from: 'EM_EXECUCAO',
        to: 'CONCLUIDA',
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
