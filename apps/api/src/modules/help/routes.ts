import {
  EVENT_TYPES,
  SKILLS,
  TASK_WAITING,
  adjustProposalSchema,
  approveProposalSchema,
  compareTasks,
  planningActionsQuerySchema,
  proposalCode,
  proposalListQuerySchema,
  transferRequestSchema,
  rejectProposalSchema,
  taskCode,
  updateSkillsSchema,
  zonedDateTime,
  type EmployeeSkillsDto,
  type PlanningActionDto,
  type PlanningActionKind,
  type ProposalAlternative,
  type ProposalKind,
  type RescheduleProposalDto,
  type Skill,
  type TaskStatus,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { Errors } from '../../lib/errors';
import { attendanceConfig, team } from '../attendance/common';
import { idParams } from '../presenters';
import { EXECUTE, company, taskInclude, toTaskDto } from '../production/common';
import { HELP_AUDIENCE } from './engine';
import { decideProposal } from './reschedule';
import { requestTransfer } from './approvals';

/**
 * Competências da equipe, reprogramação (propostas ao gestor), pedido de transferência e histórico
 * do planejamento. Os pedidos de ajuda (fila, apoio, apoio prolongado) foram removidos do sistema;
 * o histórico deles continua no banco, sem tela.
 */

// ─────────────────────────── Acesso ───────────────────────────

const VIEW = { session: 'WEB', anyPermissions: ['producao.ver', 'producao.planejar'] } as const;
const PLAN = { session: 'WEB', permissions: ['producao.planejar'] } as const;

// ─────────────────────────── DTOs ───────────────────────────

const ref = (t: { id: string; number: number; title: string; status: string }) => ({
  id: t.id,
  code: taskCode(t.number),
  title: t.title,
  status: t.status as TaskStatus,
});

async function proposalDto(
  db: Tx | PrismaClient,
  p: Prisma.RescheduleProposalGetPayload<{
    include: {
      decidedBy: { select: { displayName: true } };
    };
  }>,
): Promise<RescheduleProposalDto> {
  const tasks = await db.productionTask.findMany({
    where: { id: { in: p.affectedTaskIds } },
    select: {
      id: true,
      number: true,
      title: true,
      status: true,
      assignee: { select: { displayName: true } },
    },
    orderBy: { number: 'asc' },
  });
  return {
    id: p.id,
    number: p.number,
    code: proposalCode(p.number),
    kind: p.kind as ProposalKind,
    status: p.status,
    critical: p.critical,
    situation: p.situation,
    problem: p.problem,
    affectedTasks: tasks.map((t) => ({ ...ref(t), assignee: t.assignee?.displayName ?? null })),
    alternatives: p.alternatives as unknown as ProposalAlternative[],
    proposedAlternativeId: p.proposedAlternativeId,
    chosenAlternativeId: p.chosenAlternativeId,
    decidedBy: p.decidedBy?.displayName ?? (p.decidedAt && !p.decidedById ? 'Sistema' : null),
    decidedAt: p.decidedAt?.toISOString() ?? null,
    decisionNote: p.decisionNote,
    createdAt: p.createdAt.toISOString(),
    version: p.version,
  };
}
const proposalInclude = {
  decidedBy: { select: { displayName: true } },
} as const;

// ─────────────────────────── Rotas ───────────────────────────

export async function helpRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  /** Simplificação Fase 7: o responsável pede a transferência da própria tarefa (gestor aprova). */
  app.post(
    '/api/v1/production-tasks/:id/transfer-request',
    { config: { access: EXECUTE, idempotent: true } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = transferRequestSchema.parse(request.body ?? {});
      const actor = actorFrom(request);
      const p = await prisma.$transaction((tx) =>
        requestTransfer(tx, actor, request.auth!.userId, id, input),
      );
      return reply.status(201).send({ id: p.id, code: proposalCode(p.number), status: p.status });
    },
  );

  // ─────────────────────────── Competências ───────────────────────────

  app.get(
    '/api/v1/skills',
    { config: { access: VIEW } },
    async (): Promise<EmployeeSkillsDto[]> => {
      const members = await team(prisma);
      const skills = await prisma.employeeSkill.findMany({
        where: { employeeId: { in: members.map((m) => m.id) } },
      });
      return members.map((m) => ({
        employeeId: m.id,
        userId: m.userId,
        displayName: m.displayName,
        jobTitle: m.jobTitle,
        skills: SKILLS.filter((s) =>
          skills.some((x) => x.employeeId === m.id && x.skill === s),
        ) as Skill[],
      }));
    },
  );

  app.put('/api/v1/employees/:id/skills', { config: { access: PLAN } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = updateSkillsSchema.parse(request.body);
    const actor = actorFrom(request);
    const e = await prisma.employee.findUnique({ where: { id } });
    if (!e) throw Errors.notFound('Funcionário');
    if (!(await team(prisma)).some((m) => m.id === id))
      throw Errors.business('Competências valem só para a equipe da produção.');
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`skills:${id}`}))`;
      const before = (await tx.employeeSkill.findMany({ where: { employeeId: id } })).map(
        (s) => s.skill,
      );
      const next = [...new Set(input.skills)];
      const added = next.filter((s) => !before.includes(s));
      const removed = before.filter((s) => !(next as string[]).includes(s));
      if (!added.length && !removed.length) return;
      await tx.employeeSkill.deleteMany({ where: { employeeId: id, skill: { in: removed } } });
      await tx.employeeSkill.createMany({
        data: added.map((skill) => ({ employeeId: id, skill, grantedById: actor.userId })),
        skipDuplicates: true,
      });
      await audit(tx, actor, {
        action: 'help.skills_changed',
        entityType: 'employee',
        entityId: id,
        summary: `Competências de ${e.displayName}: ${added.length ? `+${added.join(', +')}` : ''}${added.length && removed.length ? '; ' : ''}${removed.length ? `-${removed.join(', -')}` : ''}.`,
      });
      await appendEvent(tx, actor, {
        type: EVENT_TYPES.EMPLOYEE_SKILLS_CHANGED,
        aggregateType: 'employee',
        aggregateId: id,
        payload: { employeeId: id, added, removed },
        audience: HELP_AUDIENCE,
      });
    });
    const rows = await prisma.employeeSkill.findMany({ where: { employeeId: id } });
    return { employeeId: id, skills: SKILLS.filter((s) => rows.some((r) => r.skill === s)) };
  });

  // ─────────────────────────── Reprogramação ───────────────────────────

  app.get('/api/v1/reschedule-proposals', { config: { access: VIEW } }, async (request) => {
    const q = proposalListQuerySchema.parse(request.query);
    const rows = await prisma.rescheduleProposal.findMany({
      where: q.status ? { status: q.status } : {},
      include: proposalInclude,
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    });
    const out: RescheduleProposalDto[] = [];
    for (const p of rows) out.push(await proposalDto(prisma, p));
    return out;
  });

  app.get('/api/v1/reschedule-proposals/:id', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const p = await prisma.rescheduleProposal.findUnique({
      where: { id },
      include: proposalInclude,
    });
    if (!p) throw Errors.notFound('Proposta');
    return proposalDto(prisma, p);
  });

  async function decide(id: string, run: (tx: Tx) => Promise<unknown>) {
    await prisma.$transaction(run);
    const p = await prisma.rescheduleProposal.findUniqueOrThrow({
      where: { id },
      include: proposalInclude,
    });
    return proposalDto(prisma, p);
  }

  app.post(
    '/api/v1/reschedule-proposals/:id/approve',
    { config: { access: PLAN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = approveProposalSchema.parse(request.body ?? {});
      const actor = actorFrom(request);
      return decide(id, (tx) => decideProposal(tx, actor, id, { decision: 'APROVAR', ...input }));
    },
  );

  app.post(
    '/api/v1/reschedule-proposals/:id/adjust',
    { config: { access: PLAN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = adjustProposalSchema.parse(request.body ?? {});
      const actor = actorFrom(request);
      return decide(id, (tx) => decideProposal(tx, actor, id, { decision: 'APROVAR', ...input }));
    },
  );

  app.post(
    '/api/v1/reschedule-proposals/:id/reject',
    { config: { access: PLAN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = rejectProposalSchema.parse(request.body ?? {});
      const actor = actorFrom(request);
      return decide(id, (tx) => decideProposal(tx, actor, id, { decision: 'REJEITAR', ...input }));
    },
  );

  /** Histórico de alterações automáticas e aprovadas (quem, quando e por quê). */
  app.get('/api/v1/planning-actions', { config: { access: VIEW } }, async (request) => {
    const q = planningActionsQuerySchema.parse(request.query);
    const rows = await prisma.planningAction.findMany({
      where: q.automatic ? { automatic: q.automatic === 'true' } : {},
      include: { actor: { select: { displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
    const taskIds = [...new Set(rows.map((r) => r.taskId).filter(Boolean))] as string[];
    const propIds = [...new Set(rows.map((r) => r.proposalId).filter(Boolean))] as string[];
    const [tasks, props] = await Promise.all([
      prisma.productionTask.findMany({
        where: { id: { in: taskIds } },
        select: { id: true, number: true, title: true, status: true },
      }),
      prisma.rescheduleProposal.findMany({
        where: { id: { in: propIds } },
        select: { id: true, number: true },
      }),
    ]);
    return rows.map(
      (r): PlanningActionDto => ({
        id: r.id,
        kind: r.kind as PlanningActionKind,
        automatic: r.automatic,
        reason: r.reason,
        actor: r.actor?.displayName ?? (r.actorId ? null : 'Sistema'),
        task: (() => {
          const t = tasks.find((x) => x.id === r.taskId);
          return t ? ref(t) : null;
        })(),
        proposalCode: (() => {
          const p = props.find((x) => x.id === r.proposalId);
          return p ? proposalCode(p.number) : null;
        })(),
        createdAt: r.createdAt.toISOString(),
      }),
    );
  });

  /**
   * Tarefas alternativas do próprio funcionário (quando a atual está bloqueada): já
   * liberadas ou prontas para hoje (sem bloqueio). Consulta apenas: nada é iniciado.
   */
  app.get(
    '/api/v1/production-tasks/alternatives',
    { config: { access: EXECUTE } },
    async (request) => {
      const { timezone } = await company(prisma);
      const cfg = await attendanceConfig(prisma);
      const endOfDay = zonedDateTime(cfg.today, '23:59', timezone);
      const rows = await prisma.productionTask.findMany({
        where: {
          assigneeUserId: request.auth!.userId,
          OR: [
            { status: 'LIBERADA' },
            {
              status: 'PROGRAMADA',
              blockers: { isEmpty: true },
              blockedReason: null,
              scheduledAt: { lte: endOfDay },
            },
          ],
        },
        include: taskInclude,
      });
      return rows
        .filter((t) => (TASK_WAITING as readonly string[]).includes(t.status))
        .map((t) => toTaskDto(t, timezone))
        .sort(compareTasks);
    },
  );
}
