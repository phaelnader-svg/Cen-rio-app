import {
  assignIssueSchema,
  issueListQuerySchema,
  issueNoteSchema,
  openIssueSchema,
  verifyIssueSchema,
  type IssueDto,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { actorFrom } from '../../core/audit';
import { Errors } from '../../lib/errors';
import { attendanceConfig } from '../attendance/common';
import { processHelpQueue } from '../help/queue';
import { idParams } from '../presenters';
import { refreshAvailabilityOfUser } from '../attendance/common';
import { attentionRoutes } from './attention';
import {
  MANAGE,
  OPEN_STATUSES,
  READ,
  REPORT,
  VIEW,
  impactOf,
  issueDto,
  issueInclude,
} from './common';
import {
  assignIssue,
  cancelIssue,
  openIssue,
  recordAction,
  reopenIssue,
  requestVerification,
  verifyIssue,
} from './service';

const deviceOf = (request: FastifyRequest) => request.auth?.deviceId ?? null;

export async function issueRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  const has = (request: FastifyRequest, p: string) => request.auth!.permissions.has(p as never);
  const canManage = (request: FastifyRequest) => has(request, 'ocorrencias.gerenciar');
  const canView = (request: FastifyRequest) =>
    canManage(request) || has(request, 'ocorrencias.ver');
  const after = () =>
    processHelpQueue(prisma).catch((err: unknown) =>
      app.log.warn({ err }, 'Falha ao reavaliar a fila de ajuda'),
    );

  async function load(db: Tx | PrismaClient, id: string, request?: FastifyRequest) {
    const r = await db.productionIssue.findUnique({ where: { id }, include: issueInclude });
    if (!r) throw Errors.notFound('Ocorrência');
    const cfg = await attendanceConfig(db);
    const [impact, photos, events] = await Promise.all([
      impactOf(db, r.taskId),
      db.attachment.count({
        where: { entityType: 'PRODUCTION_ISSUE', entityId: id, deletedAt: null },
      }),
      db.productionIssueEvent.findMany({
        where: { issueId: id },
        include: { actor: { select: { displayName: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const dto: IssueDto = issueDto(r, cfg.today, { photos, deadlineRisk: impact.deadlineRisk });
    dto.events = events.map((e) => ({
      id: e.id,
      kind: e.kind,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      note: e.note,
      actor: e.actor?.displayName ?? (e.actorId ? null : 'Sistema'),
      createdAt: e.createdAt.toISOString(),
    }));
    if (request) {
      const me = request.auth!.userId;
      const manage = canManage(request) && request.auth!.kind === 'WEB';
      const open = (OPEN_STATUSES as string[]).includes(r.status);
      const assignee = r.assigneeUserId === me;
      dto.can = {
        assign: manage && ['ABERTA', 'ATRIBUIDA', 'EM_RESOLUCAO'].includes(r.status),
        record: open && (manage || assignee),
        requestVerification:
          (manage || assignee) && ['ABERTA', 'ATRIBUIDA', 'EM_RESOLUCAO'].includes(r.status),
        verify: manage && r.status === 'AGUARDANDO_VERIFICACAO',
        reopen: manage && !open,
        cancel: open && (manage || (r.reporterUserId === me && r.status === 'ABERTA')),
      };
    }
    return { row: r, dto };
  }

  /** Quem pode ver uma ocorrência: gestão, quem registrou ou quem resolve. */
  async function visible(request: FastifyRequest, id: string) {
    const r = await prisma.productionIssue.findUnique({ where: { id } });
    if (!r) throw Errors.notFound('Ocorrência');
    const me = request.auth!.userId;
    if (!canView(request) && r.reporterUserId !== me && r.assigneeUserId !== me)
      throw Errors.forbidden('Esta ocorrência é de outra pessoa.');
    return r;
  }

  /** "Tenho um problema" (tablet): OS, tarefa, funcionário, dispositivo e horário automáticos. */
  app.post(
    '/api/v1/issues',
    { config: { access: REPORT, idempotent: true } },
    async (request, reply) => {
      const input = openIssueSchema.parse(request.body);
      const actor = actorFrom(request);
      const me = request.auth!.userId;
      const issue = await prisma.$transaction((tx) =>
        openIssue(tx, actor, deviceOf(request), me, input),
      );
      // Pausa por impedimento muda a disponibilidade (Fase 7) e libera para ajudar (Fase 8).
      await prisma.$transaction((tx) => refreshAvailabilityOfUser(tx, actor, me));
      await after();
      reply.status(201);
      return (await load(prisma, issue.id, request)).dto;
    },
  );

  /** Ocorrências que registrei ou que estou resolvendo (tablet). */
  app.get('/api/v1/issues/mine', { config: { access: READ } }, async (request) => {
    const me = request.auth!.userId;
    const cfg = await attendanceConfig(prisma);
    const rows = await prisma.productionIssue.findMany({
      where: {
        OR: [{ reporterUserId: me }, { assigneeUserId: me }],
        AND: [
          {
            OR: [
              { status: { in: OPEN_STATUSES } },
              { updatedAt: { gte: new Date(Date.now() - 24 * 3_600_000) } },
            ],
          },
        ],
      },
      include: issueInclude,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => issueDto(r, cfg.today));
  });

  app.get('/api/v1/issues', { config: { access: VIEW } }, async (request) => {
    const q = issueListQuerySchema.parse(request.query);
    const cfg = await attendanceConfig(prisma);
    const rows = await prisma.productionIssue.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.taskId ? { taskId: q.taskId } : {}),
      },
      include: issueInclude,
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    return rows.map((r) => issueDto(r, cfg.today));
  });

  app.get('/api/v1/issues/:id', { config: { access: READ } }, async (request) => {
    const { id } = idParams.parse(request.params);
    await visible(request, id);
    return (await load(prisma, id, request)).dto;
  });

  app.get('/api/v1/issues/:id/impacts', { config: { access: READ } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const r = await visible(request, id);
    return impactOf(prisma, r.taskId);
  });

  async function mutate(request: FastifyRequest, id: string, run: (tx: Tx) => Promise<unknown>) {
    await prisma.$transaction(run);
    await after();
    return (await load(prisma, id, request)).dto;
  }

  app.post(
    '/api/v1/issues/:id/assign',
    { config: { access: MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = assignIssueSchema.parse(request.body);
      const actor = actorFrom(request);
      return mutate(request, id, (tx) => assignIssue(tx, actor, id, input));
    },
  );

  /** Registrar ação: gestão ou quem está resolvendo. */
  app.post(
    '/api/v1/issues/:id/actions',
    { config: { access: READ, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = issueNoteSchema.parse(request.body);
      const r = await visible(request, id);
      if (
        !(canManage(request) && request.auth!.kind === 'WEB') &&
        r.assigneeUserId !== request.auth!.userId
      )
        throw Errors.forbidden('Só quem resolve ou o gestor registra ações.');
      const actor = actorFrom(request);
      return mutate(request, id, (tx) => recordAction(tx, actor, id, input.note));
    },
  );

  /** Solução registrada sem a tarefa (ex.: gestor reservou o material) → verificação. */
  app.post(
    '/api/v1/issues/:id/request-verification',
    { config: { access: READ, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = issueNoteSchema.parse(request.body);
      const r = await visible(request, id);
      if (
        !(canManage(request) && request.auth!.kind === 'WEB') &&
        r.assigneeUserId !== request.auth!.userId
      )
        throw Errors.forbidden('Só quem resolve ou o gestor registra a solução.');
      const actor = actorFrom(request);
      return mutate(request, id, (tx) =>
        requestVerification(tx, actor, id, input.note, input.version),
      );
    },
  );

  app.post(
    '/api/v1/issues/:id/verify',
    { config: { access: MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = verifyIssueSchema.parse(request.body);
      const actor = actorFrom(request);
      return mutate(request, id, (tx) => verifyIssue(tx, actor, id, input));
    },
  );

  app.post(
    '/api/v1/issues/:id/reopen',
    { config: { access: MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = issueNoteSchema.parse(request.body);
      const actor = actorFrom(request);
      return mutate(request, id, (tx) => reopenIssue(tx, actor, id, input.note, input.version));
    },
  );

  /** Cancelar: gestor; quem registrou só a própria ocorrência ainda aberta (ex.: engano). */
  app.post(
    '/api/v1/issues/:id/cancel',
    { config: { access: READ, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = issueNoteSchema.parse(request.body);
      const r = await visible(request, id);
      const manager = canManage(request) && request.auth!.kind === 'WEB';
      if (!manager && !(r.reporterUserId === request.auth!.userId && r.status === 'ABERTA'))
        throw Errors.forbidden('Só o gestor cancela esta ocorrência.');
      const actor = actorFrom(request);
      return mutate(request, id, (tx) => cancelIssue(tx, actor, id, input.note, input.version));
    },
  );

  await app.register(attentionRoutes);
}
