import {
  ISSUE_OPEN,
  anyPermissionAudience,
  issueCategory,
  issueCode,
  taskCode,
  type EventType,
  type IssueDto,
  type IssueImpact,
  type IssueImpactDto,
  type IssueKind,
  type IssueStatus,
  type MaterialUnit,
  type NotificationKind,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import { appendEvent } from '../../core/events/append';
import { loadUserPermissions } from '../../core/permissions';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { attendanceConfig, clock } from '../attendance/common';
import { dateOnly, serviceOrderCode } from '../commercial/common';
import { notify } from '../notifications/notify';

// ─────────────────────────── Acesso ───────────────────────────

/** Funcionário registra problemas nas próprias tarefas (tablet ou painel). */
export const REPORT = { session: 'any', permissions: ['ocorrencias.registrar'] } as const;
/** Consulta individual: quem registrou, quem resolve ou a gestão (verificado na rota). */
export const READ = {
  session: 'any',
  anyPermissions: [
    'ocorrencias.registrar',
    'ocorrencias.ver',
    'ocorrencias.gerenciar',
    'producao.executar',
  ],
} as const;
export const VIEW = {
  session: 'WEB',
  anyPermissions: ['ocorrencias.ver', 'ocorrencias.gerenciar'],
} as const;
export const MANAGE = { session: 'WEB', permissions: ['ocorrencias.gerenciar'] } as const;

export const ISSUE_AUDIENCE = anyPermissionAudience('ocorrencias.ver', 'ocorrencias.gerenciar');
export const issueAudience = (...users: (string | null | undefined)[]) =>
  [ISSUE_AUDIENCE, ...[...new Set(users.filter(Boolean))].map((u) => `user:${u}`)].join(
    '|',
  ) as typeof ISSUE_AUDIENCE;

export const OPEN_STATUSES = [...ISSUE_OPEN] as IssueStatus[];

export type IssueRow = Prisma.ProductionIssueGetPayload<object>;

export async function lockIssue(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM production_issues WHERE id = ${id}::uuid FOR UPDATE`;
  if (!rows.length) throw Errors.notFound('Ocorrência');
  return tx.productionIssue.findUniqueOrThrow({ where: { id } });
}

/** Quem decide as ocorrências (avisos que exigem ação). */
export async function issueManagers(db: Tx | PrismaClient) {
  const users = await db.user.findMany({ where: { active: true }, select: { id: true } });
  const out: string[] = [];
  for (const u of users) {
    if ((await loadUserPermissions(db, u.id)).has('ocorrencias.gerenciar')) out.push(u.id);
  }
  return out;
}

export async function notifyIssueManagers(
  tx: Tx,
  actor: ActorContext,
  kind: NotificationKind,
  dedupeKey: string,
  body: string,
  issue: { taskId: string; serviceOrderId: string },
  includeActor = false,
) {
  await notify(
    tx,
    actor,
    (await issueManagers(tx)).map((userId) => ({
      userId,
      kind,
      dedupeKey,
      body,
      taskId: issue.taskId,
      serviceOrderId: issue.serviceOrderId,
      includeActor,
    })),
  );
}

export async function issueEvent(
  tx: Tx,
  actor: ActorContext,
  issue: { id: string },
  entry: {
    kind: string;
    from?: string | null;
    to?: string | null;
    note?: string | null;
    data?: unknown;
    deviceId?: string | null;
  },
) {
  await tx.productionIssueEvent.create({
    data: {
      issueId: issue.id,
      kind: entry.kind,
      fromStatus: entry.from ?? null,
      toStatus: entry.to ?? null,
      note: entry.note?.slice(0, 1000) ?? null,
      data: (entry.data as Prisma.InputJsonValue | undefined) ?? undefined,
      actorId: actor.userId,
      deviceId: entry.deviceId ?? null,
      createdAt: clock(),
    },
  });
}

export async function issueDomainEvent(
  tx: Tx,
  actor: ActorContext,
  type: EventType,
  issue: IssueRow,
) {
  await appendEvent(tx, actor, {
    type,
    aggregateType: 'production_issue',
    aggregateId: issue.id,
    payload: {
      id: issue.id,
      code: issueCode(issue.number),
      status: issue.status,
      taskId: issue.taskId,
      serviceOrderId: issue.serviceOrderId,
      actionTaskId: issue.actionTaskId,
    },
    audience: issueAudience(issue.reporterUserId, issue.assigneeUserId),
  });
}

// ─────────────────────────── Impactos ───────────────────────────

const PRIORITY_IMPORTANT = ['ALTA', 'URGENTE'];
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Tarefas afetadas: a própria tarefa e, em cadeia, as que dependem dela (com responsáveis e
 * prazos). Risco de prazo: prazo interno até amanhã (na tarefa ou numa dependente), entrega
 * prometida ao cliente em até 2 dias ou tarefa urgente.
 */
export async function impactOf(db: Tx | PrismaClient, taskId: string): Promise<IssueImpactDto> {
  const task = await db.productionTask.findUniqueOrThrow({
    where: { id: taskId },
    include: {
      assignee: { select: { displayName: true } },
      serviceOrder: { select: { promisedDate: true } },
    },
  });
  const cfg = await attendanceConfig(db);
  const tomorrow = addDays(cfg.today, 1);
  const dependents: IssueImpactDto['dependents'] = [];
  const seen = new Set<string>([task.id]);
  let frontier = [task.id];
  for (let depth = 1; frontier.length && depth <= 10; depth += 1) {
    const links = await db.taskDependency.findMany({
      where: { dependsOnId: { in: frontier } },
      include: {
        task: {
          include: { assignee: { select: { displayName: true } } },
        },
      },
    });
    frontier = [];
    for (const l of links) {
      const t = l.task;
      if (seen.has(t.id) || ['CONCLUIDA', 'CANCELADA', 'RASCUNHO'].includes(t.status)) continue;
      seen.add(t.id);
      frontier.push(t.id);
      dependents.push({
        id: t.id,
        code: taskCode(t.number),
        title: t.title,
        status: t.status,
        assignee: t.assignee?.displayName ?? null,
        dueDate: dateOnly(t.dueDate),
        scheduledAt: t.scheduledAt?.toISOString() ?? null,
        depth,
      });
    }
  }
  const reasons: string[] = [];
  const due = dateOnly(task.dueDate);
  if (due && due <= tomorrow)
    reasons.push(
      `Prazo interno de ${taskCode(task.number)} em ${due.split('-').reverse().join('/')}.`,
    );
  const promised = dateOnly(task.serviceOrder.promisedDate);
  if (promised && promised <= addDays(cfg.today, 2))
    reasons.push(`Entrega prometida ao cliente em ${promised.split('-').reverse().join('/')}.`);
  if (task.priority === 'URGENTE') reasons.push(`${taskCode(task.number)} é urgente.`);
  const lateDeps = dependents.filter((d) => d.dueDate && d.dueDate <= tomorrow);
  if (lateDeps.length)
    reasons.push(`Dependentes com prazo próximo: ${lateDeps.map((d) => d.code).join(', ')}.`);
  const people = [
    ...new Set(
      dependents
        .map((d) => d.assignee)
        .filter((a): a is string => Boolean(a) && a !== task.assignee?.displayName),
    ),
  ];
  return {
    task: {
      id: task.id,
      code: taskCode(task.number),
      title: task.title,
      status: task.status,
      assignee: task.assignee?.displayName ?? null,
      dueDate: due,
      priority: task.priority,
    },
    dependents,
    people,
    promisedDate: promised,
    deadlineRisk: reasons.length > 0,
    reasons,
  };
}

export const isImportantPriority = (p: string) => PRIORITY_IMPORTANT.includes(p);

// ─────────────────────────── DTO ───────────────────────────

const taskRef = {
  select: {
    id: true,
    number: true,
    title: true,
    status: true,
    priority: true,
    dueDate: true,
    assignee: { select: { displayName: true } },
  },
} as const;

export const issueInclude = {
  task: taskRef,
  actionTask: taskRef,
  serviceOrder: { select: { id: true, number: true, promisedDate: true } },
  reporter: { select: { id: true, displayName: true } },
  assignee: { select: { id: true, displayName: true } },
  resolvedBy: { select: { displayName: true } },
} as const;
export type IssueWithRefs = Prisma.ProductionIssueGetPayload<{ include: typeof issueInclude }>;

const ref = (t: {
  id: string;
  number: number;
  title: string;
  status: string;
  assignee: { displayName: string } | null;
}) => ({
  id: t.id,
  code: taskCode(t.number),
  title: t.title,
  status: t.status as IssueDto['task']['status'],
  assignee: t.assignee?.displayName ?? null,
});

/** Risco de prazo sem varrer dependentes (lista da central); o detalhe usa `impactOf`. */
export function quickDeadlineRisk(r: IssueWithRefs, today: string) {
  const due = dateOnly(r.task.dueDate);
  const promised = dateOnly(r.serviceOrder.promisedDate);
  return Boolean(
    (due && due <= addDays(today, 1)) ||
      (promised && promised <= addDays(today, 2)) ||
      r.task.priority === 'URGENTE',
  );
}

export function issueDto(
  r: IssueWithRefs,
  today: string,
  extra: { photos?: number; deadlineRisk?: boolean } = {},
): IssueDto {
  const deadlineRisk = extra.deadlineRisk ?? quickDeadlineRisk(r, today);
  const now = clock();
  return {
    id: r.id,
    number: r.number,
    code: issueCode(r.number),
    kind: r.kind as IssueKind,
    status: r.status,
    impact: r.impact as IssueImpact,
    blocksTask: r.blocksTask,
    priority: r.priority,
    description: r.description,
    task: ref(r.task),
    serviceOrder: {
      id: r.serviceOrder.id,
      code: serviceOrderCode(r.serviceOrder.number),
      promisedDate: dateOnly(r.serviceOrder.promisedDate),
    },
    reporter: { userId: r.reporter.id, displayName: r.reporter.displayName },
    material:
      r.kind === 'MATERIAL' && r.materialQuantity && r.materialUnit
        ? {
            requirementId: r.materialRequirementId,
            stockItemId: r.stockItemId,
            description: r.materialDescription ?? '',
            quantity: Number(r.materialQuantity),
            unit: r.materialUnit as MaterialUnit,
          }
        : null,
    assignee: r.assignee ? { userId: r.assignee.id, displayName: r.assignee.displayName } : null,
    actionTask: r.actionTask ? ref(r.actionTask) : null,
    requiredSkill: r.requiredSkill,
    dueAt: r.dueAt?.toISOString() ?? null,
    resultNote: r.resultNote,
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    resolvedBy: r.resolvedBy?.displayName ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancelReason: r.cancelReason,
    reopenCount: r.reopenCount,
    category: issueCategory({
      status: r.status,
      blocksTask: r.blocksTask,
      deadlineRisk,
      resolutionOverdue: Boolean(
        r.dueAt && r.dueAt < now && (OPEN_STATUSES as string[]).includes(r.status),
      ),
    }),
    deadlineRisk,
    photos: extra.photos ?? 0,
    createdAt: r.createdAt.toISOString(),
    version: r.version,
  };
}
