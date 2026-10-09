import {
  EVENT_TYPES,
  addPlanItemSchema,
  createPlanSchema,
  formatServiceOrderItemCode,
  localParts,
  mondayOf,
  PLAN_MODE_LABEL,
  publishPlanSchema,
  taskCode,
  templateSchema,
  updatePlanItemSchema,
  updateTemplateSchema,
  zonedDateTime,
  type PlanCandidateDto,
  type PlanConflictDto,
  type ProductionPlanDto,
  type ProductionTemplateDto,
  type WorkerDto,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { loadUserPermissions } from '../../core/permissions';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { now as clockNow } from '../../core/clock';
import { dateOnly, parseDateOnly, serviceOrderCode } from '../commercial/common';
import { idParams } from '../presenters';
import { notify, taskNotice } from '../notifications/notify';
import { readinessOf } from '../purchasing/common';
import {
  MANAGEMENT,
  PLAN,
  VIEW,
  company,
  domainTaskEvent,
  lockPlan,
  reevaluateTasks,
  taskEvent,
  taskInclude,
  taskMaterialsReady,
  toTaskDto,
} from './common';

// ─────────────────────────── Pessoas ───────────────────────────

/** Funcionários ativos que executam tarefas (permissão `producao.executar`). */
export async function workers(db: Tx | PrismaClient): Promise<WorkerDto[]> {
  const users = await db.user.findMany({
    where: { active: true, employee: { isNot: null } },
    include: { employee: true, roles: { include: { role: { select: { key: true } } } } },
    orderBy: { displayName: 'asc' },
  });
  const out: WorkerDto[] = [];
  for (const u of users) {
    if (!u.employee?.active) continue;
    const perms = await loadUserPermissions(db, u.id);
    if (!perms.has('producao.executar')) continue;
    out.push({
      userId: u.id,
      displayName: u.displayName,
      jobTitle: u.employee.jobTitle,
      color: u.employee.color,
      isTapeceiro: u.roles.some((r) => r.role.key === 'tapeceiro'),
    });
  }
  return out;
}

export async function assertWorker(db: Tx | PrismaClient, userId: string, what = 'Responsável') {
  const w = (await workers(db)).find((x) => x.userId === userId);
  if (!w) throw Errors.business(`${what}: a pessoa escolhida não executa tarefas de produção.`);
  return w;
}

// ─────────────────────────── Snapshot e revisão ───────────────────────────

async function snapshot(tx: Tx, planId: string) {
  const tasks = await tx.productionTask.findMany({
    where: { planId },
    include: { dependsOn: { select: { dependsOnId: true } } },
    orderBy: { number: 'asc' },
  });
  return tasks.map((t) => ({
    id: t.id,
    code: taskCode(t.number),
    serviceOrderId: t.serviceOrderId,
    activity: t.activity,
    title: t.title,
    assigneeUserId: t.assigneeUserId,
    priority: t.priority,
    queuePosition: t.queuePosition,
    scheduledAt: t.scheduledAt?.toISOString() ?? null,
    dueDate: dateOnly(t.dueDate),
    status: t.status,
    dependsOn: t.dependsOn.map((d) => d.dependsOnId),
  }));
}

/**
 * Toda alteração depois da publicação gera uma nova revisão (cópia completa,
 * imutável) com o motivo, quem alterou e quando — a anterior é preservada.
 */
export async function reviseIfPublished(
  tx: Tx,
  request: FastifyRequest,
  planId: string | null,
  reason: string | null | undefined,
  summary: string,
) {
  await reviseIfPublishedBy(tx, actorFrom(request), planId, reason, summary);
}

/** Mesma revisão, para mudanças sem requisição (automáticas ou aprovadas pelo gestor — Fase 8). */
export async function reviseIfPublishedBy(
  tx: Tx,
  actor: ActorContext,
  planId: string | null,
  reason: string | null | undefined,
  summary: string,
) {
  if (!planId) return;
  const plan = await lockPlan(tx, planId);
  if (plan.status !== 'PUBLICADO') return;
  if (!reason || reason.trim().length < 3) {
    throw Errors.validation(
      [{ path: 'reason', message: 'Informe o motivo da alteração da programação publicada.' }],
      'Informe o motivo da alteração da programação publicada.',
    );
  }
  const { planningWeekday, timezone } = await company(tx);
  const revision = plan.revision + 1;
  await tx.productionPlanRevision.create({
    data: {
      planId,
      revision,
      reason: reason.slice(0, 500),
      offSchedule: weekdayIn(timezone) !== planningWeekday,
      snapshot: (await snapshot(tx, planId)) as Prisma.InputJsonValue,
      createdById: actor.userId,
    },
  });
  await tx.productionPlan.update({
    where: { id: planId },
    data: { revision, version: { increment: 1 } },
  });
  await audit(tx, actor, {
    action: 'production.plan_revised',
    entityType: 'production_plan',
    entityId: planId,
    summary: `Programação da semana ${dateOnly(plan.weekStart)} revisada (revisão ${revision}): ${summary}. Motivo: ${reason}`,
  });
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.PRODUCTION_PLAN_REVISED,
    aggregateType: 'production_plan',
    aggregateId: planId,
    payload: { id: planId, revision },
    audience: 'all',
  });
}

export function weekdayIn(timeZone: string, d = clockNow()) {
  const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(d);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day);
}

// ─────────────────────────── Leitura do plano ───────────────────────────

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export async function loadPlan(db: Tx | PrismaClient, id: string): Promise<ProductionPlanDto> {
  const plan = await db.productionPlan.findUnique({
    where: { id },
    include: {
      createdBy: { select: { displayName: true } },
      items: {
        include: {
          serviceOrder: {
            include: {
              customer: { select: { name: true } },
              items: { select: { pieceType: true } },
            },
          },
          principal: { select: { id: true, displayName: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
      revisions: {
        include: { createdBy: { select: { displayName: true } } },
        orderBy: { revision: 'desc' },
      },
    },
  });
  if (!plan) throw Errors.notFound('Planejamento');
  const { timezone } = await company(db);
  const tasks = await db.productionTask.findMany({
    where: { planId: id },
    include: taskInclude,
    orderBy: [{ serviceOrderId: 'asc' }, { sequence: 'asc' }, { number: 'asc' }],
  });
  const readinessCache = new Map<string, Awaited<ReturnType<typeof readinessOf>>>();
  const states = new Map<string, Awaited<ReturnType<typeof readinessOf>>['state']>();
  for (const it of plan.items) {
    const r = await readinessOf(db, it.serviceOrderId);
    readinessCache.set(it.serviceOrderId, r);
    states.set(it.serviceOrderId, r.state);
  }
  const weekStart = dateOnly(plan.weekStart)!;
  const weekEnd = addDays(weekStart, 6);
  const dtos = tasks.map((t) => toTaskDto(t, timezone));

  // Conflitos (avisos para o gestor; as regras de integridade são impostas nas rotas).
  const conflicts: PlanConflictDto[] = [];
  const open = dtos.filter((t) => t.status !== 'CANCELADA' && t.status !== 'CONCLUIDA');
  const noAssignee = open.filter((t) => !t.assignee);
  if (noAssignee.length)
    conflicts.push({
      kind: 'SEM_RESPONSAVEL',
      message: `${noAssignee.length} tarefa(s) sem responsável.`,
      taskIds: noAssignee.map((t) => t.id),
    });
  // Fila semanal: sem horário por desenho — nenhum aviso baseado em horário.
  const queue = plan.mode === 'FILA_SEMANAL';
  const noTime = queue ? [] : open.filter((t) => !t.scheduledAt);
  if (noTime.length)
    conflicts.push({
      kind: 'SEM_HORARIO',
      message: `${noTime.length} tarefa(s) sem data/horário.`,
      taskIds: noTime.map((t) => t.id),
    });
  const slots = new Map<string, string[]>();
  for (const t of open) {
    if (!t.assignee || !t.scheduledAt) continue;
    const k = `${t.assignee.userId}|${t.scheduledAt}`;
    slots.set(k, [...(slots.get(k) ?? []), t.id]);
  }
  for (const [k, ids] of slots) {
    if (ids.length < 2) continue;
    const t = dtos.find((x) => x.id === ids[0])!;
    conflicts.push({
      kind: 'HORARIO_COINCIDENTE',
      message: `${t.assignee!.displayName} tem ${ids.length} tarefas no mesmo horário (${t.scheduledDate} ${t.scheduledTime}).`,
      taskIds: ids,
    });
    void k;
  }
  for (const t of open) {
    for (const d of tasks.find((x) => x.id === t.id)!.dependsOn) {
      const dep = dtos.find((x) => x.id === d.dependsOnId);
      if (dep?.scheduledAt && t.scheduledAt && t.scheduledAt < dep.scheduledAt) {
        conflicts.push({
          kind: 'ANTES_DA_DEPENDENCIA',
          message: `${t.code} está programada antes de ${dep.code}, de que depende.`,
          taskIds: [t.id, dep.id],
        });
      }
    }
    const it = plan.items.find((i) => i.serviceOrderId === t.serviceOrder.id);
    if (
      t.requiresMaterials &&
      !(await taskMaterialsReady(
        db,
        { id: t.id, serviceOrderId: t.serviceOrder.id, requiresMaterials: true },
        readinessCache,
      ))
    ) {
      conflicts.push({
        kind: 'MATERIAIS',
        message: `${t.code} (${t.serviceOrder.code}) exige materiais, que ainda não estão completos — ficará bloqueada.`,
        taskIds: [t.id],
      });
    }
    const promised = it ? dateOnly(it.serviceOrder.promisedDate) : null;
    if (promised && t.scheduledDate && t.scheduledDate > promised) {
      conflicts.push({
        kind: 'APOS_PRAZO',
        message: `${t.code} está após o prazo prometido da ${t.serviceOrder.code}.`,
        taskIds: [t.id],
      });
    }
    if (t.scheduledDate && (t.scheduledDate < weekStart || t.scheduledDate > weekEnd)) {
      conflicts.push({
        kind: 'FORA_DA_SEMANA',
        message: `${t.code} está fora da semana do planejamento.`,
        taskIds: [t.id],
      });
    }
  }
  // A semana de trabalho (seg–sex) terminou: pendências ficam visíveis para o gestor transferir.
  const today = localParts(clockNow(), timezone).date;
  const pending = dtos.filter(
    (t) => !['CONCLUIDA', 'CANCELADA', 'RASCUNHO'].includes(t.status) && !t.supportFor,
  );
  return {
    id: plan.id,
    weekStart,
    weekEnd,
    status: plan.status,
    mode: plan.mode,
    weekEnded: today > addDays(weekStart, 4),
    pendingCount: plan.status === 'PUBLICADO' ? pending.length : 0,
    revision: plan.revision,
    notes: plan.notes,
    createdBy: plan.createdBy?.displayName ?? null,
    createdAt: plan.createdAt.toISOString(),
    publishedAt: plan.publishedAt?.toISOString() ?? null,
    items: plan.items.map((i) => ({
      id: i.id,
      serviceOrder: {
        id: i.serviceOrder.id,
        code: serviceOrderCode(i.serviceOrder.number),
        promisedDate: dateOnly(i.serviceOrder.promisedDate),
        priority: i.serviceOrder.priority,
        status: i.serviceOrder.status,
      },
      customerName: i.serviceOrder.customer.name,
      principal: i.principal
        ? { userId: i.principal.id, displayName: i.principal.displayName }
        : null,
      priority: i.priority,
      materialsState: states.get(i.serviceOrderId)!,
      hasSofa: i.serviceOrder.items.some((x) => x.pieceType === 'SOFA'),
    })),
    tasks: dtos,
    conflicts,
    revisions: plan.revisions.map((r) => ({
      id: r.id,
      revision: r.revision,
      reason: r.reason,
      offSchedule: r.offSchedule,
      createdBy: r.createdBy?.displayName ?? null,
      createdAt: r.createdAt.toISOString(),
      taskCount: Array.isArray(r.snapshot) ? r.snapshot.length : 0,
    })),
    version: plan.version,
  };
}

// ─────────────────────────── Geração de tarefas ───────────────────────────

/**
 * Gera as tarefas sugeridas pelos modelos para cada peça da OS. Etapas opcionais
 * (desmontagem) não são criadas em fabricação; dependências de etapas omitidas
 * passam para as anteriores (sem criar tarefas desnecessárias).
 */
async function generateTasks(
  tx: Tx,
  planId: string,
  so: {
    id: string;
    number: number;
    items: {
      id: string;
      position: number;
      pieceType: string;
      serviceType: string;
      description: string;
    }[];
  },
  principalUserId: string | null,
  priority: Prisma.ProductionTaskCreateInput['priority'],
  scheduledAt: Date | null,
) {
  const templates = await tx.productionTemplate.findMany({
    where: { active: true },
    include: { steps: { orderBy: { position: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
  const created: string[] = [];
  for (const item of so.items) {
    const tpl = templates.find((t) => t.pieceTypes.includes(item.pieceType as never));
    if (!tpl) continue;
    const byPosition = new Map<number, string[]>(); // posição → ids das tarefas que a "representam"
    for (const step of tpl.steps) {
      const deps = [...new Set(step.dependsOn.flatMap((p) => byPosition.get(p) ?? []))];
      if (step.optional && item.serviceType === 'FABRICACAO') {
        byPosition.set(step.position, deps);
        continue;
      }
      const task = await tx.productionTask.create({
        data: {
          planId,
          serviceOrderId: so.id,
          serviceOrderItemId: item.id,
          activity: step.activity,
          title: `${step.name} — ${formatServiceOrderItemCode(so.number, item.position)}`,
          role: step.role,
          assigneeUserId: step.role === 'PRINCIPAL' ? principalUserId : null,
          priority,
          sequence: item.position * 100 + step.position,
          requiresMaterials: step.requiresMaterials,
          completionRequirement: step.completionRequirement,
          scheduledAt,
        },
      });
      for (const d of deps)
        await tx.taskDependency.create({ data: { taskId: task.id, dependsOnId: d } });
      byPosition.set(step.position, [task.id]);
      created.push(task.id);
    }
  }
  return created;
}

async function assertPrincipal(
  tx: Tx,
  principalUserId: string | null | undefined,
  hasSofa: boolean,
) {
  if (!principalUserId) {
    if (hasSofa)
      throw Errors.business('Escolha o tapeceiro principal do sofá (Ricardo ou Márcio).');
    return;
  }
  const w = await assertWorker(tx, principalUserId, 'Tapeceiro principal');
  if (hasSofa && !w.isTapeceiro) {
    throw Errors.business('O responsável principal de um sofá deve ser um tapeceiro.');
  }
}

/** Publica os eventos de atribuição para os responsáveis das tarefas indicadas. */
export async function announceAssignments(
  tx: Tx,
  actor: ActorContext,
  ids: string[],
  /**
   * Várias tarefas de uma vez (publicação da semana ou OS incluída numa semana publicada):
   * um aviso-resumo por pessoa em vez de um por tarefa.
   */
  summary?: { key: string; lead: string },
) {
  const tasks = await tx.productionTask.findMany({
    where: { id: { in: ids }, assigneeUserId: { not: null } },
    orderBy: [{ scheduledAt: 'asc' }, { sequence: 'asc' }],
  });
  for (const t of tasks) await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_ASSIGNED, t);
  if (summary) {
    const byUser = new Map<string, typeof tasks>();
    for (const t of tasks)
      byUser.set(t.assigneeUserId!, [...(byUser.get(t.assigneeUserId!) ?? []), t]);
    for (const [userId, list] of byUser) {
      const released = list.filter((t) => t.status === 'LIBERADA').length;
      await notify(tx, actor, [
        {
          userId,
          kind: 'TAREFA_ATRIBUIDA',
          dedupeKey: `${summary.key}:${userId}`,
          body: `${summary.lead}: ${list.length} tarefa(s) para você${released ? `, ${released} liberada(s) para começar` : ''}.`,
          taskId: list.find((t) => t.status === 'LIBERADA')?.id ?? list[0]!.id,
          serviceOrderId: list[0]!.serviceOrderId,
        },
      ]);
    }
    return;
  }
  for (const t of tasks) {
    await notify(
      tx,
      actor,
      taskNotice(
        t,
        'TAREFA_ATRIBUIDA',
        t.status === 'LIBERADA' ? 'liberada para começar.' : 'programada para você.',
      ),
    );
  }
}

// ─────────────────────────── Rotas ───────────────────────────

export async function productionPlanRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  // Modelos
  const toTemplate = (
    t: Prisma.ProductionTemplateGetPayload<{ include: { steps: true } }>,
  ): ProductionTemplateDto => ({
    id: t.id,
    name: t.name,
    pieceTypes: t.pieceTypes,
    active: t.active,
    version: t.version,
    steps: [...t.steps]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        id: s.id,
        position: s.position,
        activity: s.activity,
        name: s.name,
        role: s.role,
        requiresMaterials: s.requiresMaterials,
        optional: s.optional,
        dependsOn: s.dependsOn,
        completionRequirement: s.completionRequirement,
      })),
  });

  app.get('/api/v1/production-templates', { config: { access: VIEW } }, async () =>
    (
      await prisma.productionTemplate.findMany({
        include: { steps: true },
        orderBy: { name: 'asc' },
      })
    ).map(toTemplate),
  );

  async function saveTemplate(request: FastifyRequest, id: string | null) {
    const input = id
      ? updateTemplateSchema.parse(request.body)
      : templateSchema.parse(request.body);
    const actor = actorFrom(request);
    return prisma.$transaction(async (tx) => {
      let templateId = id;
      if (id) {
        await tx.$queryRaw`SELECT id FROM production_templates WHERE id = ${id}::uuid FOR UPDATE`;
        const cur = await tx.productionTemplate.findUnique({ where: { id } });
        if (!cur) throw Errors.notFound('Modelo');
        const version = (input as unknown as { version: number }).version;
        if (cur.version !== version) throw Errors.versionConflict(cur.version);
        await tx.productionTemplateStep.deleteMany({ where: { templateId: id } });
        await tx.productionTemplate.update({
          where: { id },
          data: {
            name: input.name,
            pieceTypes: input.pieceTypes,
            active: input.active,
            version: { increment: 1 },
          },
        });
      } else {
        templateId = (
          await tx.productionTemplate.create({
            data: { name: input.name, pieceTypes: input.pieceTypes, active: input.active },
          })
        ).id;
      }
      for (const [i, s] of input.steps.entries()) {
        await tx.productionTemplateStep.create({
          data: { ...s, templateId: templateId!, position: i + 1 },
        });
      }
      await audit(tx, actor, {
        action: id ? 'production.template_updated' : 'production.template_created',
        entityType: 'production_template',
        entityId: templateId,
        summary: `Modelo de produção "${input.name}" ${id ? 'alterado' : 'criado'}.`,
      });
      await appendEvent(tx, actor, {
        type: EVENT_TYPES.PRODUCTION_TEMPLATE_CHANGED,
        aggregateType: 'production_template',
        aggregateId: templateId!,
        payload: { id: templateId },
        audience: MANAGEMENT,
      });
      return toTemplate(
        await tx.productionTemplate.findUniqueOrThrow({
          where: { id: templateId! },
          include: { steps: true },
        }),
      );
    });
  }
  app.post('/api/v1/production-templates', { config: { access: PLAN } }, async (request, reply) =>
    reply.status(201).send(await saveTemplate(request, null)),
  );
  app.put('/api/v1/production-templates/:id', { config: { access: PLAN } }, async (request) =>
    saveTemplate(request, idParams.parse(request.params).id),
  );

  app.get('/api/v1/production/workers', { config: { access: VIEW } }, async () => workers(prisma));

  // Planejamentos
  app.get('/api/v1/production-plans', { config: { access: VIEW } }, async (request) => {
    const q = z
      .object({
        week: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .parse(request.query);
    const where = q.week ? { weekStart: parseDateOnly(mondayOf(q.week))! } : {};
    const plans = await prisma.productionPlan.findMany({
      where,
      orderBy: { weekStart: 'desc' },
      take: 20,
    });
    return plans.map((p) => ({
      id: p.id,
      weekStart: dateOnly(p.weekStart),
      status: p.status,
      mode: p.mode,
      revision: p.revision,
      version: p.version,
    }));
  });

  app.get('/api/v1/production-plans/:id', { config: { access: VIEW } }, async (request) =>
    loadPlan(prisma, idParams.parse(request.params).id),
  );

  /** Cria o rascunho da semana (sexta é o padrão, mas qualquer dia é permitido). */
  app.post(
    '/api/v1/production-plans',
    { config: { access: PLAN, idempotent: true } },
    async (request, reply) => {
      const input = createPlanSchema.parse(request.body);
      const weekStart = mondayOf(input.weekStart);
      const actor = actorFrom(request);
      const id = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'plan:' + weekStart}))`;
        if (
          await tx.productionPlan.findUnique({ where: { weekStart: parseDateOnly(weekStart)! } })
        ) {
          throw Errors.conflict('Já existe um planejamento para esta semana.');
        }
        const plan = await tx.productionPlan.create({
          data: {
            weekStart: parseDateOnly(weekStart)!,
            mode: input.mode,
            notes: input.notes ?? null,
            createdById: actor.userId,
          },
        });
        await audit(tx, actor, {
          action: 'production.plan_created',
          entityType: 'production_plan',
          entityId: plan.id,
          summary: `Planejamento da semana de ${weekStart} criado (rascunho, ${PLAN_MODE_LABEL[input.mode].toLowerCase()}).`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.PRODUCTION_PLAN_CREATED,
          aggregateType: 'production_plan',
          aggregateId: plan.id,
          payload: { id: plan.id, weekStart },
          audience: MANAGEMENT,
        });
        return plan.id;
      });
      return reply.status(201).send(await loadPlan(prisma, id));
    },
  );

  /** OS abertas que podem entrar na semana (prazo, prioridade e prontidão de materiais). */
  app.get(
    '/api/v1/production-plans/:id/candidates',
    { config: { access: VIEW } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const plan = await prisma.productionPlan.findUnique({
        where: { id },
        include: { items: true },
      });
      if (!plan) throw Errors.notFound('Planejamento');
      const sos = await prisma.serviceOrder.findMany({
        where: { status: 'ABERTA' },
        include: {
          customer: { select: { name: true } },
          items: { orderBy: { position: 'asc' } },
          technicalLead: { include: { user: { select: { id: true, displayName: true } } } },
          _count: {
            select: {
              productionTasks: { where: { status: { notIn: ['CONCLUIDA', 'CANCELADA'] } } },
            },
          },
        },
        orderBy: [{ promisedDate: 'asc' }, { number: 'asc' }],
      });
      const out: PlanCandidateDto[] = [];
      for (const so of sos) {
        out.push({
          serviceOrder: {
            id: so.id,
            code: serviceOrderCode(so.number),
            promisedDate: dateOnly(so.promisedDate),
            priority: so.priority,
          },
          customerName: so.customer.name,
          materialsState: (await readinessOf(prisma, so.id)).state,
          items: so.items.map((i) => ({
            id: i.id,
            code: formatServiceOrderItemCode(so.number, i.position),
            pieceType: i.pieceType,
            description: i.description,
          })),
          technicalLead: so.technicalLead?.user
            ? { userId: so.technicalLead.user.id, displayName: so.technicalLead.user.displayName }
            : null,
          openTasks: so._count.productionTasks,
          inPlan: plan.items.some((i) => i.serviceOrderId === so.id),
        });
      }
      return out;
    },
  );

  /** Seleciona uma OS para a semana e gera as tarefas sugeridas pelos modelos. */
  app.post(
    '/api/v1/production-plans/:id/items',
    { config: { access: PLAN, idempotent: true } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = addPlanItemSchema
        .extend({
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        })
        .parse(request.body);
      const actor = actorFrom(request);
      const { timezone, workdayStart } = await company(prisma);
      await prisma.$transaction(async (tx) => {
        const plan = await lockPlan(tx, id);
        const so = await tx.serviceOrder.findUnique({
          where: { id: input.serviceOrderId },
          include: { items: { orderBy: { position: 'asc' } } },
        });
        if (!so) throw Errors.notFound('Ordem de serviço');
        if (so.status !== 'ABERTA') throw Errors.business('A OS não está aberta.');
        if (
          await tx.productionPlanItem.findUnique({
            where: { planId_serviceOrderId: { planId: id, serviceOrderId: so.id } },
          })
        ) {
          throw Errors.conflict('Esta OS já está no planejamento da semana.');
        }
        const hasSofa = so.items.some((i) => i.pieceType === 'SOFA');
        let principal = input.principalUserId ?? null;
        if (principal === null && input.principalUserId === undefined && so.technicalLeadId) {
          const lead = await tx.employee.findUnique({ where: { id: so.technicalLeadId } });
          principal = lead?.userId ?? null;
        }
        await assertPrincipal(tx, principal, hasSofa);
        const priority = input.priority ?? so.priority;
        await tx.productionPlanItem.create({
          data: { planId: id, serviceOrderId: so.id, principalUserId: principal, priority },
        });
        // Fila semanal: sem data/horário (nada fictício); a ordem é a da fila.
        if (plan.mode === 'FILA_SEMANAL' && input.date)
          throw Errors.business(
            'No planejamento em fila semanal as tarefas não têm data nem horário.',
          );
        const scheduledAt = input.date ? zonedDateTime(input.date, workdayStart, timezone) : null;
        const created = input.generate
          ? await generateTasks(tx, id, so, principal, priority, scheduledAt)
          : [];
        await audit(tx, actor, {
          action: 'production.plan_item_added',
          entityType: 'production_plan',
          entityId: id,
          summary: `${serviceOrderCode(so.number)} incluída na semana ${dateOnly(plan.weekStart)} (${created.length} tarefa(s)).`,
        });
        if (plan.status === 'PUBLICADO') {
          // Programação já publicada: as novas tarefas entram valendo, com revisão.
          await tx.productionTask.updateMany({
            where: { id: { in: created } },
            data: { status: 'BLOQUEADA' },
          });
          for (const tId of created)
            await taskEvent(
              tx,
              actor,
              null,
              { id: tId },
              { kind: 'PUBLICADA', to: 'BLOQUEADA', note: input.reason ?? null },
            );
          await reviseIfPublished(
            tx,
            request,
            id,
            input.reason,
            `inclusão da ${serviceOrderCode(so.number)}`,
          );
          await reevaluateTasks(tx, actor, created);
          await announceAssignments(tx, actor, created, {
            key: `INCLUSAO:${id}:${so.id}`,
            lead: `${serviceOrderCode(so.number)} incluída na programação da semana`,
          });
        } else {
          await appendEvent(tx, actor, {
            type: EVENT_TYPES.PRODUCTION_PLAN_UPDATED,
            aggregateType: 'production_plan',
            aggregateId: id,
            payload: { id },
            audience: MANAGEMENT,
          });
        }
      });
      return reply.status(201).send(await loadPlan(prisma, id));
    },
  );

  /** Troca o tapeceiro principal/prioridade da OS na semana (tarefas principais acompanham). */
  app.put(
    '/api/v1/production-plans/:id/items/:itemId',
    { config: { access: PLAN } },
    async (request) => {
      const { id, itemId } = z
        .object({ id: z.string().uuid(), itemId: z.string().uuid() })
        .parse(request.params);
      const input = updatePlanItemSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        await lockPlan(tx, id);
        const item = await tx.productionPlanItem.findUnique({
          where: { id: itemId },
          include: { serviceOrder: { include: { items: true } } },
        });
        if (!item || item.planId !== id) throw Errors.notFound('OS do planejamento');
        const principal =
          input.principalUserId === undefined ? item.principalUserId : input.principalUserId;
        await assertPrincipal(
          tx,
          principal,
          item.serviceOrder.items.some((i) => i.pieceType === 'SOFA'),
        );
        await tx.productionPlanItem.update({
          where: { id: itemId },
          data: { principalUserId: principal, priority: input.priority ?? item.priority },
        });
        // Tarefas do responsável principal ainda não iniciadas passam para o novo principal.
        const moved = await tx.productionTask.findMany({
          where: {
            planId: id,
            serviceOrderId: item.serviceOrderId,
            role: 'PRINCIPAL',
            status: { in: ['RASCUNHO', 'BLOQUEADA', 'PROGRAMADA', 'LIBERADA'] },
          },
        });
        for (const t of moved) {
          await tx.productionTask.update({
            where: { id: t.id },
            data: {
              assigneeUserId: principal,
              ...(input.priority ? { priority: input.priority } : {}),
              version: { increment: 1 },
            },
          });
          if (t.status !== 'RASCUNHO' && t.assigneeUserId !== principal) {
            await notify(
              tx,
              actor,
              taskNotice(t, 'TAREFA_REMOVIDA', 'passou para outro responsável.'),
            );
            await taskEvent(tx, actor, null, t, {
              kind: 'RESPONSAVEL_ALTERADO',
              note: input.reason ?? null,
              changes: { from: t.assigneeUserId, to: principal },
            });
          }
        }
        await reviseIfPublished(
          tx,
          request,
          id,
          input.reason,
          `responsável principal/prioridade da ${serviceOrderCode(item.serviceOrder.number)}`,
        );
        await reevaluateTasks(
          tx,
          actor,
          moved.map((t) => t.id),
        );
        const plan = await tx.productionPlan.findUniqueOrThrow({ where: { id } });
        if (plan.status === 'PUBLICADO')
          await announceAssignments(
            tx,
            actor,
            moved.map((t) => t.id),
          );
      });
      return loadPlan(prisma, id);
    },
  );

  /** Publica a programação: as tarefas passam a valer e vão para os tablets. */
  app.post(
    '/api/v1/production-plans/:id/publish',
    { config: { access: PLAN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = publishPlanSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const plan = await lockPlan(tx, id);
        if (plan.version !== input.version) throw Errors.versionConflict(plan.version);
        if (plan.status === 'PUBLICADO') {
          throw Errors.business('A programação já foi publicada; alterações geram revisões.');
        }
        const tasks = await tx.productionTask.findMany({
          where: { planId: id, status: 'RASCUNHO' },
        });
        if (tasks.length === 0)
          throw Errors.business('Inclua ao menos uma tarefa antes de publicar.');
        const { planningWeekday, timezone } = await company(tx);
        await tx.productionTask.updateMany({
          where: { planId: id, status: 'RASCUNHO' },
          data: { status: 'BLOQUEADA' },
        });
        const now = clockNow();
        await tx.productionPlan.update({
          where: { id },
          data: {
            status: 'PUBLICADO',
            revision: 1,
            publishedAt: now,
            publishedById: actor.userId,
            notes: input.notes ?? plan.notes,
            version: { increment: 1 },
          },
        });
        for (const t of tasks)
          await taskEvent(tx, actor, null, t, {
            kind: 'PUBLICADA',
            from: 'RASCUNHO',
            to: 'BLOQUEADA',
          });
        await tx.productionPlanRevision.create({
          data: {
            planId: id,
            revision: 1,
            reason: input.notes ?? 'Publicação inicial',
            offSchedule: weekdayIn(timezone) !== planningWeekday,
            snapshot: (await snapshot(tx, id)) as Prisma.InputJsonValue,
            createdById: actor.userId,
          },
        });
        await audit(tx, actor, {
          action: 'production.plan_published',
          entityType: 'production_plan',
          entityId: id,
          summary: `Programação da semana ${dateOnly(plan.weekStart)} publicada com ${tasks.length} tarefa(s).`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.PRODUCTION_PLAN_PUBLISHED,
          aggregateType: 'production_plan',
          aggregateId: id,
          payload: { id, weekStart: dateOnly(plan.weekStart), revision: 1 },
          audience: 'all',
        });
        await reevaluateTasks(
          tx,
          actor,
          tasks.map((t) => t.id),
          now,
        );
        await announceAssignments(
          tx,
          actor,
          tasks.map((t) => t.id),
          {
            key: `PUBLICACAO:${id}`,
            lead: `Programação da semana de ${dateOnly(plan.weekStart)!.split('-').reverse().join('/')} publicada`,
          },
        );
      });
      return loadPlan(prisma, id);
    },
  );

  /** Remove uma OS da semana: rascunho apaga as tarefas; publicada cancela (com revisão). */
  app.post(
    '/api/v1/production-plans/:id/items/:itemId/remove',
    { config: { access: PLAN } },
    async (request) => {
      const { id, itemId } = z
        .object({ id: z.string().uuid(), itemId: z.string().uuid() })
        .parse(request.params);
      const { reason } = z
        .object({ reason: z.string().trim().max(500).optional() })
        .parse(request.body ?? {});
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const plan = await lockPlan(tx, id);
        const item = await tx.productionPlanItem.findUnique({
          where: { id: itemId },
          include: { serviceOrder: true },
        });
        if (!item || item.planId !== id) throw Errors.notFound('OS do planejamento');
        const tasks = await tx.productionTask.findMany({
          where: { planId: id, serviceOrderId: item.serviceOrderId },
        });
        if (tasks.some((t) => ['EM_EXECUCAO', 'PAUSADA', 'CONCLUIDA'].includes(t.status))) {
          throw Errors.business(
            'Há tarefas desta OS já iniciadas; cancele as tarefas pendentes individualmente.',
          );
        }
        if (plan.status === 'RASCUNHO') {
          await tx.productionTask.deleteMany({ where: { id: { in: tasks.map((t) => t.id) } } });
        } else {
          if (!reason || reason.length < 3)
            throw Errors.validation(
              [{ path: 'reason', message: 'Informe o motivo.' }],
              'Informe o motivo.',
            );
          for (const t of tasks.filter((x) => x.status !== 'CANCELADA')) {
            const u = await tx.productionTask.update({
              where: { id: t.id },
              data: { status: 'CANCELADA', cancelReason: reason, version: { increment: 1 } },
            });
            await taskEvent(tx, actor, null, t, {
              kind: 'CANCELADA',
              from: t.status,
              to: 'CANCELADA',
              note: reason,
            });
            await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_CANCELLED, u);
          }
        }
        await tx.productionPlanItem.delete({ where: { id: itemId } });
        await reviseIfPublished(
          tx,
          request,
          id,
          reason,
          `retirada da ${serviceOrderCode(item.serviceOrder.number)}`,
        );
        if (plan.status === 'RASCUNHO') {
          await appendEvent(tx, actor, {
            type: EVENT_TYPES.PRODUCTION_PLAN_UPDATED,
            aggregateType: 'production_plan',
            aggregateId: id,
            payload: { id },
            audience: MANAGEMENT,
          });
        }
      });
      return loadPlan(prisma, id);
    },
  );
}
