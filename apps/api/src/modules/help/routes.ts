import {
  EVENT_TYPES,
  HELP_KIND_LABEL,
  HELP_KIND_MINUTES,
  HELP_OPEN,
  SKILLS,
  TASK_WAITING,
  adjustProposalSchema,
  approveProposalSchema,
  manualHelpAssignSchema,
  HELP_KIND_SKILL,
  cancelHelpRequestSchema,
  compareTasks,
  createHelpRequestSchema,
  helpListQuerySchema,
  helpRequestCode,
  localParts,
  planningActionsQuerySchema,
  proposalCode,
  proposalListQuerySchema,
  rejectProposalSchema,
  taskCode,
  updateSkillsSchema,
  zonedDateTime,
  type CandidateEvaluation,
  type EmployeeSkillsDto,
  type HelpKind,
  type HelpRequestDto,
  type PlanningActionDto,
  type PlanningActionKind,
  type ProposalAlternative,
  type ProposalKind,
  type RescheduleProposalDto,
  type Skill,
} from '@cenario/shared';
import { isUniqueViolation, type Prisma, type PrismaClient, type Tx } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { Errors } from '../../lib/errors';
import { attendanceConfig, clock, notifyManagers, team } from '../attendance/common';
import { serviceOrderCode } from '../commercial/common';
import { notify } from '../notifications/notify';
import { idParams } from '../presenters';
import { EXECUTE, company, taskInclude, toTaskDto } from '../production/common';
import { HELP_AUDIENCE, helpDomainEvent, helpEvent } from './engine';
import { cancelHelp, lockHelpRequest, manualAssign, processHelpQueue, tryAssign } from './queue';
import { evaluateCandidates } from './engine';
import { decideProposal } from './reschedule';

// ─────────────────────────── Acesso ───────────────────────────

const REQUEST = { session: 'any', permissions: ['ajuda.solicitar'] } as const;
const MINE = { session: 'any', anyPermissions: ['ajuda.solicitar', 'producao.executar'] } as const;
const READ = {
  session: 'any',
  anyPermissions: ['ajuda.solicitar', 'producao.executar', 'producao.ver', 'producao.planejar'],
} as const;
const VIEW = { session: 'WEB', anyPermissions: ['producao.ver', 'producao.planejar'] } as const;
const PLAN = { session: 'WEB', permissions: ['producao.planejar'] } as const;

const canSeeAll = (request: FastifyRequest) =>
  request.auth!.permissions.has('producao.ver') ||
  request.auth!.permissions.has('producao.planejar');

// ─────────────────────────── DTOs ───────────────────────────

const helpInclude = {
  task: { select: { id: true, number: true, title: true, status: true } },
  supportTask: { select: { id: true, number: true, title: true, status: true } },
  serviceOrder: { select: { id: true, number: true } },
  requester: { select: { id: true, displayName: true } },
  helper: { select: { id: true, displayName: true } },
  proposals: { select: { id: true }, orderBy: { createdAt: 'desc' }, take: 1 },
} as const;
type HelpWithRefs = Prisma.HelpRequestGetPayload<{ include: typeof helpInclude }>;

const ref = (t: { id: string; number: number; title: string; status: string }) => ({
  id: t.id,
  code: taskCode(t.number),
  title: t.title,
  status: t.status as HelpRequestDto['task']['status'],
});

function helpDto(r: HelpWithRefs, now = clock()): HelpRequestDto {
  const end = r.assignedAt ?? r.completedAt ?? r.cancelledAt ?? now;
  return {
    id: r.id,
    number: r.number,
    code: helpRequestCode(r.number),
    task: ref(r.task),
    serviceOrder: { id: r.serviceOrder.id, code: serviceOrderCode(r.serviceOrder.number) },
    requester: { userId: r.requester.id, displayName: r.requester.displayName },
    helper: r.helper ? { userId: r.helper.id, displayName: r.helper.displayName } : null,
    kind: r.kind as HelpKind,
    estimatedMinutes: r.estimatedMinutes,
    urgent: r.urgent,
    justification: r.justification,
    note: r.note,
    status: r.status,
    supportTask: r.supportTask ? ref(r.supportTask) : null,
    waitingMinutes: Math.max(0, Math.floor((end.getTime() - r.createdAt.getTime()) / 60_000)),
    proposalId: r.proposals[0]?.id ?? null,
    createdAt: r.createdAt.toISOString(),
    assignedAt: r.assignedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancelReason: r.cancelReason,
    version: r.version,
  };
}

async function loadHelp(db: Tx | PrismaClient, id: string, withEvents = false) {
  const r = await db.helpRequest.findUnique({ where: { id }, include: helpInclude });
  if (!r) throw Errors.notFound('Pedido de ajuda');
  const dto = helpDto(r);
  if (withEvents) {
    const events = await db.helpRequestEvent.findMany({
      where: { helpRequestId: id },
      include: { actor: { select: { displayName: true } } },
      orderBy: { createdAt: 'asc' },
    });
    dto.events = events.map((e) => {
      const ev = e.evaluation as { candidates?: CandidateEvaluation[] } | null;
      return {
        id: e.id,
        kind: e.kind,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        note: e.note,
        actor: e.actor?.displayName ?? (e.actorId ? null : 'Sistema'),
        candidates: ev?.candidates ?? null,
        createdAt: e.createdAt.toISOString(),
      };
    });
  }
  return { row: r, dto };
}

async function proposalDto(
  db: Tx | PrismaClient,
  p: Prisma.RescheduleProposalGetPayload<{
    include: {
      decidedBy: { select: { displayName: true } };
      helpRequest: { select: { id: true; number: true } };
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
    helpRequest: p.helpRequest
      ? { id: p.helpRequest.id, code: helpRequestCode(p.helpRequest.number) }
      : null,
    decidedBy: p.decidedBy?.displayName ?? (p.decidedAt && !p.decidedById ? 'Sistema' : null),
    decidedAt: p.decidedAt?.toISOString() ?? null,
    decisionNote: p.decisionNote,
    createdAt: p.createdAt.toISOString(),
    version: p.version,
  };
}
const proposalInclude = {
  decidedBy: { select: { displayName: true } },
  helpRequest: { select: { id: true, number: true } },
} as const;

// ─────────────────────────── Rotas ───────────────────────────

export async function helpRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  /** Mudanças de disponibilidade reavaliam a fila (depois da transação principal). */
  const requeue = () =>
    processHelpQueue(prisma).catch((err: unknown) =>
      app.log.warn({ err }, 'Falha ao reavaliar a fila de ajuda'),
    );

  /**
   * "Solicitar ajudante" / "Preciso de ajuda agora". Só em tarefa própria iniciada ou
   * liberada (não em tarefa de apoio). Um pedido aberto por tarefa: pedir "agora" com
   * um pedido normal ainda na fila apenas o torna urgente.
   */
  app.post(
    '/api/v1/help-requests',
    { config: { access: REQUEST, idempotent: true } },
    async (request, reply) => {
      const input = createHelpRequestSchema.parse(request.body);
      const actor = actorFrom(request);
      const me = request.auth!.userId;
      const now = clock();
      const id = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM production_tasks WHERE id = ${input.taskId}::uuid FOR UPDATE`;
        const task = await tx.productionTask.findUnique({
          where: { id: input.taskId },
          include: { serviceOrder: { select: { status: true } } },
        });
        if (!task) throw Errors.notFound('Tarefa');
        if (task.assigneeUserId !== me)
          throw Errors.forbidden('Só é possível pedir ajuda nas próprias tarefas.');
        if (task.supportForTaskId)
          throw Errors.business('Tarefa de apoio: peça ajuda na tarefa principal.');
        if (!['LIBERADA', 'EM_EXECUCAO', 'PAUSADA'].includes(task.status))
          throw Errors.business('Peça ajuda em uma tarefa liberada ou em andamento.');
        if (task.serviceOrder.status !== 'ABERTA') throw Errors.business('A OS não está ativa.');
        const open = await tx.helpRequest.findFirst({
          where: { taskId: task.id, requesterUserId: me, status: { in: [...HELP_OPEN] } },
        });
        if (open) {
          if (input.urgent && !open.urgent && open.status === 'PENDENTE') {
            const u = await tx.helpRequest.update({
              where: { id: open.id },
              data: {
                urgent: true,
                justification: input.justification ?? null,
                delayAlertedAt: null,
                version: { increment: 1 },
              },
            });
            await helpEvent(tx, actor, open, {
              kind: 'URGENTE',
              note: `Pedido passou a urgente: ${input.justification}`,
            });
            await audit(tx, actor, {
              action: 'help.urgent',
              entityType: 'help_request',
              entityId: open.id,
              summary: `${helpRequestCode(open.number)} passou a urgente: ${input.justification}`,
            });
            await helpDomainEvent(tx, actor, EVENT_TYPES.HELP_REQUESTED, u);
            await notifyManagers(
              tx,
              actor,
              'AJUDA_SOLICITADA',
              `AJUDA_URGENTE:${open.id}`,
              `Ajuda urgente (${helpRequestCode(open.number)}) em ${taskCode(task.number)} · ${task.title}: ${input.justification}`,
              task.id,
            );
            return open.id;
          }
          throw Errors.conflict(
            `Já existe um pedido aberto para esta tarefa (${helpRequestCode(open.number)}).`,
            { helpRequestId: open.id },
          );
        }
        const kind = input.kind as HelpKind;
        let created;
        try {
          created = await tx.helpRequest.create({
            data: {
              taskId: task.id,
              serviceOrderId: task.serviceOrderId,
              requesterUserId: me,
              kind,
              estimatedMinutes: input.estimatedMinutes ?? HELP_KIND_MINUTES[kind],
              urgent: input.urgent,
              justification: input.urgent ? (input.justification ?? null) : null,
              note: input.note ?? null,
              createdAt: now,
            },
          });
        } catch (error) {
          if (isUniqueViolation(error))
            throw Errors.conflict('Já existe um pedido aberto para esta tarefa.');
          throw error;
        }
        const code = helpRequestCode(created.number);
        await helpEvent(tx, actor, created, {
          kind: 'SOLICITADA',
          to: 'PENDENTE',
          note: `${HELP_KIND_LABEL[kind]} (${created.estimatedMinutes} min)${created.urgent ? ` — urgente: ${created.justification}` : ''}${created.note ? ` — ${created.note}` : ''}`,
        });
        await audit(tx, actor, {
          action: created.urgent ? 'help.requested_urgent' : 'help.requested',
          entityType: 'help_request',
          entityId: created.id,
          summary: `${code}: ${HELP_KIND_LABEL[kind]} em ${taskCode(task.number)}${created.urgent ? ` (urgente: ${created.justification})` : ''}.`,
        });
        await helpDomainEvent(tx, actor, EVENT_TYPES.HELP_REQUESTED, created);
        await notify(tx, actor, [
          {
            userId: me,
            kind: 'AJUDA_SOLICITADA',
            dedupeKey: `AJUDA_SOLICITADA:${created.id}`,
            body: `Pedido ${code} registrado: ${HELP_KIND_LABEL[kind]} (${created.estimatedMinutes} min). Procurando ajudante.`,
            taskId: task.id,
            includeActor: true,
          },
        ]);
        if (created.urgent) {
          await notifyManagers(
            tx,
            actor,
            'AJUDA_SOLICITADA',
            `AJUDA_URGENTE:${created.id}`,
            `Ajuda urgente (${code}) em ${taskCode(task.number)} · ${task.title}: ${created.justification}`,
            task.id,
          );
        }
        return created.id;
      });
      // Atribuição automática imediata (transação própria, serializada com as demais).
      await prisma.$transaction((tx) => tryAssign(tx, actor, id));
      reply.status(201);
      return (await loadHelp(prisma, id, true)).dto;
    },
  );

  /** Meus pedidos (abertos e os encerrados de hoje). */
  app.get('/api/v1/help-requests/mine', { config: { access: MINE } }, async (request) => {
    // `updatedAt` é gravado pelo relógio do servidor: compara com o início do dia real.
    const { timezone } = await company(prisma);
    const startOfToday = zonedDateTime(localParts(new Date(), timezone).date, '00:00', timezone);
    const rows = await prisma.helpRequest.findMany({
      where: {
        requesterUserId: request.auth!.userId,
        OR: [{ status: { in: [...HELP_OPEN] } }, { updatedAt: { gte: startOfToday } }],
      },
      include: helpInclude,
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    return rows.map((r) => helpDto(r));
  });

  app.get('/api/v1/help-requests', { config: { access: VIEW } }, async (request) => {
    const q = helpListQuerySchema.parse(request.query);
    const rows = await prisma.helpRequest.findMany({
      where: q.status ? { status: q.status } : {},
      include: helpInclude,
      orderBy: [{ urgent: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
    return rows.map((r) => helpDto(r));
  });

  app.get('/api/v1/help-requests/:id', { config: { access: READ } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { row, dto } = await loadHelp(prisma, id, true);
    const me = request.auth!.userId;
    if (!canSeeAll(request) && row.requesterUserId !== me && row.helperUserId !== me) {
      throw Errors.forbidden('Este pedido é de outra pessoa.');
    }
    // O tablet vê o histórico, mas não a avaliação dos colegas.
    if (!canSeeAll(request)) dto.events = dto.events?.map((e) => ({ ...e, candidates: null }));
    return dto;
  });

  /** Cancelar: o próprio solicitante (pedido ainda não iniciado) ou o gestor. */
  app.post(
    '/api/v1/help-requests/:id/cancel',
    { config: { access: READ, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = cancelHelpRequestSchema.parse(request.body ?? {});
      const actor = actorFrom(request);
      const manager = request.auth!.permissions.has('producao.planejar');
      await prisma.$transaction(async (tx) => {
        const req = await lockHelpRequest(tx, id);
        if (!req) throw Errors.notFound('Pedido de ajuda');
        if (req.requesterUserId !== request.auth!.userId && !manager)
          throw Errors.forbidden('Só quem pediu (ou o gestor) pode cancelar.');
        if (!manager && !request.auth!.permissions.has('ajuda.solicitar'))
          throw Errors.forbidden('Sem permissão para pedir ou cancelar ajuda.');
        if (input.version !== undefined && req.version !== input.version)
          throw Errors.versionConflict(req.version);
        if (req.status === 'CANCELADA') return; // repetição: nada muda
        if (!['PENDENTE', 'ATRIBUIDA', 'ESCALADA'].includes(req.status))
          throw Errors.business('O apoio já começou ou terminou; não pode mais ser cancelado.');
        const who =
          manager && req.requesterUserId !== request.auth!.userId ? 'gestor' : 'solicitante';
        await cancelHelp(
          tx,
          actor,
          req,
          input.reason ? `${input.reason} (${who}).` : `cancelado pelo ${who}.`,
        );
      });
      return (await loadHelp(prisma, id, true)).dto;
    },
  );

  /** Fase 9: candidatos avaliados agora (para a escolha manual do ajudante). */
  app.get('/api/v1/help-requests/:id/candidates', { config: { access: PLAN } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const req = await prisma.helpRequest.findUnique({ where: { id } });
    if (!req) throw Errors.notFound('Pedido de ajuda');
    const { candidates } = await prisma.$transaction((tx) =>
      evaluateCandidates(tx, {
        requesterUserId: req.requesterUserId,
        skill: HELP_KIND_SKILL[req.kind as HelpKind],
        estimatedMinutes: req.estimatedMinutes,
      }),
    );
    return { candidates };
  });

  /** Fase 9: escolha manual do ajudante (validada; conflito exige aprovação explícita). */
  app.post(
    '/api/v1/help-requests/:id/assign',
    { config: { access: PLAN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = manualHelpAssignSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction((tx) => manualAssign(tx, actor, id, input));
      await requeue();
      return (await loadHelp(prisma, id, true)).dto;
    },
  );

  /** Reavaliação manual da fila (a automática roda a cada 30 s e após mudanças). */
  app.post(
    '/api/v1/help-requests/process',
    { config: { access: PLAN, idempotent: true } },
    async () => ({ assigned: await processHelpQueue(prisma) }),
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
    await requeue();
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
    await requeue();
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
    const helpIds = [...new Set(rows.map((r) => r.helpRequestId).filter(Boolean))] as string[];
    const propIds = [...new Set(rows.map((r) => r.proposalId).filter(Boolean))] as string[];
    const [tasks, helps, props] = await Promise.all([
      prisma.productionTask.findMany({
        where: { id: { in: taskIds } },
        select: { id: true, number: true, title: true, status: true },
      }),
      prisma.helpRequest.findMany({
        where: { id: { in: helpIds } },
        select: { id: true, number: true },
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
        helpRequestCode: (() => {
          const h = helps.find((x) => x.id === r.helpRequestId);
          return h ? helpRequestCode(h.number) : null;
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
