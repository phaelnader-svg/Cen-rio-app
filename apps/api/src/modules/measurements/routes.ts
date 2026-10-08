import {
  EVENT_TYPES,
  MATERIAL_REQUEST_STATUS_LABEL,
  assignMeasurementSchema,
  cancelMeasurementSchema,
  createMeasurementSchema,
  formatServiceOrderItemCode,
  measurementCode,
  measurementQuerySchema,
  requestDecisionSchema,
  returnRequestSchema,
  reviseRequestSchema,
  saveMeasurementDraftSchema,
  submitMeasurementSchema,
  type AwaitingMeasurementDto,
  type MeasurementAssigneeDto,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { actorFrom } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { loadUserPermissions } from '../../core/permissions';
import { Errors } from '../../lib/errors';
import { dateOnly, parseDateOnly, serviceOrderCode, toCustomerSummary } from '../commercial/common';
import { idParams } from '../presenters';
import {
  audienceFor,
  eligibleAssignee,
  isManager,
  loadDetail,
  lockMeasurement,
  record,
  replaceItems,
  snapshotItems,
  summaryInclude,
  toSummary,
  todayIn,
} from './service';

const MANAGE = { session: 'WEB', permissions: ['medicoes.gerenciar'] } as const;
const VIEW_ALL = {
  session: 'WEB',
  anyPermissions: ['medicoes.gerenciar', 'materiais.ver', 'materiais.aprovar'],
} as const;
const EXECUTE = {
  session: 'any',
  anyPermissions: ['medicoes.gerenciar', 'medicoes.extraordinarias'],
} as const;
const APPROVE = { session: 'WEB', permissions: ['materiais.aprovar'] } as const;

async function companyTz(prisma: PrismaClient) {
  const c = await prisma.companySettings.findUnique({ where: { id: 1 } });
  return {
    timezone: c?.timezone ?? 'America/Sao_Paulo',
    measurementWeekday: c?.measurementWeekday ?? 5,
  };
}

function actorOf(request: FastifyRequest) {
  return { userId: request.auth!.userId, permissions: request.auth!.permissions };
}

/** OS ABERTA e peças efetivamente recebidas (a OS só existe após o recebimento). */
async function assertOsReady(
  tx: Tx | PrismaClient,
  serviceOrderId: string,
  itemId?: string | null,
) {
  const so = await tx.serviceOrder.findUnique({
    where: { id: serviceOrderId },
    include: { items: { include: { orderItem: { select: { receivedQuantity: true } } } } },
  });
  if (!so) throw Errors.notFound('Ordem de serviço');
  if (so.status !== 'ABERTA') throw Errors.business('A OS não está aberta.');
  if (itemId && !so.items.some((i) => i.id === itemId)) {
    throw Errors.validation(
      [{ path: 'serviceOrderItemId', message: 'A peça não pertence a esta OS.' }],
      'A peça não pertence a esta OS.',
    );
  }
  const targets = itemId ? so.items.filter((i) => i.id === itemId) : so.items;
  if (targets.some((i) => i.orderItem.receivedQuantity <= 0)) {
    throw Errors.business('A medição operacional só é possível após o recebimento físico da peça.');
  }
  return so;
}

export async function measurementRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  // ─────────────────────────── Consultas ───────────────────────────

  app.get('/api/v1/measurements', { config: { access: VIEW_ALL } }, async (request) => {
    const q = measurementQuerySchema.parse(request.query);
    const { timezone } = await companyTz(prisma);
    const where: Prisma.MeasurementWhereInput = {
      ...(q.status?.length ? { status: { in: q.status } } : {}),
      ...(q.requestStatus?.length ? { request: { status: { in: q.requestStatus } } } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.assigneeUserId ? { assigneeUserId: q.assigneeUserId } : {}),
      ...(q.serviceOrderId ? { serviceOrderId: q.serviceOrderId } : {}),
      ...(q.customerId ? { serviceOrder: { customerId: q.customerId } } : {}),
      ...(q.from || q.to
        ? {
            dueDate: {
              ...(q.from ? { gte: parseDateOnly(q.from)! } : {}),
              ...(q.to ? { lte: parseDateOnly(q.to)! } : {}),
            },
          }
        : {}),
      ...(q.q
        ? (() => {
            const os = q.q.match(/^(?:os-?)?0*(\d{1,9})$/i);
            const md = q.q.match(/^md-?0*(\d{1,9})$/i);
            return {
              OR: [
                ...(os ? [{ serviceOrder: { number: Number(os[1]) } }] : []),
                ...(md ? [{ number: Number(md[1]) }] : []),
                {
                  serviceOrder: {
                    customer: { name: { contains: q.q, mode: 'insensitive' as const } },
                  },
                },
              ],
            };
          })()
        : {}),
    };
    const rows = await prisma.measurement.findMany({
      where,
      include: summaryInclude,
      orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
      take: q.limit,
    });
    const today = todayIn(timezone);
    return rows.map((r) => toSummary(r, today));
  });

  /** Peças de OS abertas sem medição registrada e sem medição em andamento. */
  app.get('/api/v1/measurements/awaiting', { config: { access: VIEW_ALL } }, async () => {
    return awaitingMeasurement(prisma);
  });

  /** Pessoas aptas a receber medições (gestor e tapeceiros autorizados). */
  app.get('/api/v1/measurements/assignees', { config: { access: MANAGE } }, async () => {
    const users = await prisma.user.findMany({
      where: { active: true, OR: [{ employee: null }, { employee: { active: true } }] },
      include: { employee: true },
      orderBy: { displayName: 'asc' },
    });
    const out: MeasurementAssigneeDto[] = [];
    for (const u of users) {
      const perms = await loadUserPermissions(prisma, u.id);
      const manager = perms.has('medicoes.gerenciar');
      if (!manager && !perms.has('medicoes.extraordinarias')) continue;
      out.push({
        userId: u.id,
        displayName: u.employee?.displayName ?? u.displayName,
        jobTitle: u.employee?.jobTitle ?? null,
        color: u.employee?.color ?? null,
        isManager: manager,
      });
    }
    return out;
  });

  /** Medições atribuídas à pessoa logada (painel ou tablet). */
  app.get('/api/v1/measurements/mine', { config: { access: EXECUTE } }, async (request) => {
    const { timezone } = await companyTz(prisma);
    const rows = await prisma.measurement.findMany({
      where: {
        assigneeUserId: request.auth!.userId,
        OR: [
          { status: { in: ['PENDENTE', 'EM_ANDAMENTO'] } },
          { status: 'CONCLUIDA', completedAt: { gte: new Date(Date.now() - 14 * 86_400_000) } },
        ],
      },
      include: summaryInclude,
      orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
    });
    const today = todayIn(timezone);
    return rows.map((r) => toSummary(r, today));
  });

  app.get(
    '/api/v1/measurements/:id',
    {
      config: {
        access: {
          session: 'any',
          anyPermissions: [
            'medicoes.gerenciar',
            'medicoes.extraordinarias',
            'materiais.ver',
            'materiais.aprovar',
          ],
        },
      },
    },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { timezone } = await companyTz(prisma);
      return loadDetail(prisma, id, actorOf(request), todayIn(timezone));
    },
  );

  // ─────────────────────────── Gestão (somente gestor) ───────────────────────────

  /** Cria a medição (rotina de sexta ou extraordinária) e a atribui. */
  app.post(
    '/api/v1/measurements',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = createMeasurementSchema.parse(request.body);
      const { timezone, measurementWeekday } = await companyTz(prisma);
      const today = todayIn(timezone);
      if (input.dueDate < today) {
        throw Errors.validation(
          [{ path: 'dueDate', message: 'O prazo não pode estar no passado.' }],
          'O prazo não pode estar no passado.',
        );
      }
      const assignee = await eligibleAssignee(prisma, input.assigneeUserId);
      if (!assignee) {
        throw Errors.business(
          'Responsável não autorizado a executar medições (exige autorização do gestor).',
        );
      }
      // Rotina (sexta-feira) é responsabilidade do gestor; delegar só como extraordinária.
      if (input.kind === 'ROTINA' && !assignee.manager) {
        throw Errors.business(
          'A medição de rotina é do gestor. Para delegar a um tapeceiro, use medição extraordinária.',
        );
      }
      if (
        input.kind === 'ROTINA' &&
        new Date(`${input.dueDate}T12:00:00Z`).getUTCDay() !== measurementWeekday
      ) {
        throw Errors.business(
          'A medição de rotina deve ser programada para o dia de medição configurado (sexta-feira).',
        );
      }
      const id = await prisma.$transaction(async (tx) => {
        await assertOsReady(tx, input.serviceOrderId, input.serviceOrderItemId);
        // Serializa por OS para a checagem de duplicidade (complementa o índice único).
        await tx.$queryRaw`SELECT id FROM service_orders WHERE id = ${input.serviceOrderId}::uuid FOR UPDATE`;
        const conflicting = await tx.measurement.findFirst({
          where: {
            serviceOrderId: input.serviceOrderId,
            status: { in: ['PENDENTE', 'EM_ANDAMENTO'] },
            ...(input.serviceOrderItemId
              ? {
                  OR: [
                    { serviceOrderItemId: input.serviceOrderItemId },
                    { serviceOrderItemId: null },
                  ],
                }
              : {}),
          },
        });
        if (conflicting) {
          throw Errors.conflict(
            `Já existe a medição ${measurementCode(conflicting.number)} em aberto para esta ${input.serviceOrderItemId ? 'peça' : 'OS'}.`,
            { measurementId: conflicting.id },
          );
        }
        const actor = actorFrom(request);
        const m = await tx.measurement.create({
          data: {
            serviceOrderId: input.serviceOrderId,
            serviceOrderItemId: input.serviceOrderItemId ?? null,
            kind: input.kind,
            assigneeUserId: input.assigneeUserId,
            requestedById: actor.userId,
            dueDate: parseDateOnly(input.dueDate)!,
            reason: input.reason ?? null,
            request: { create: {} },
          },
        });
        await record(tx, request, m, {
          kind: 'ATRIBUIDA',
          toStatus: 'PENDENTE',
          note: input.reason ?? null,
          changes: {
            kind: input.kind,
            dueDate: input.dueDate,
            assignee: assignee.user.displayName,
          },
          summary: `Medição ${measurementCode(m.number)} (${input.kind === 'ROTINA' ? 'rotina' : 'extraordinária'}) atribuída a ${assignee.user.displayName}.`,
          event: EVENT_TYPES.MEASUREMENT_ASSIGNED,
        });
        return m.id;
      });
      return reply.status(201).send(await loadDetail(prisma, id, actorOf(request), today));
    },
  );

  app.post('/api/v1/measurements/:id/assign', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = assignMeasurementSchema.parse(request.body);
    const { timezone } = await companyTz(prisma);
    const assignee = await eligibleAssignee(prisma, input.assigneeUserId);
    if (!assignee) throw Errors.business('Responsável não autorizado a executar medições.');
    await prisma.$transaction(async (tx) => {
      const m = await lockMeasurement(tx, id);
      if (m.version !== input.version) throw Errors.versionConflict(m.version);
      if (m.status !== 'PENDENTE' && m.status !== 'EM_ANDAMENTO')
        throw Errors.business('Só medições em aberto podem ser reatribuídas.');
      if (m.kind === 'ROTINA' && !assignee.manager) {
        throw Errors.business(
          'A medição de rotina é do gestor. Crie uma medição extraordinária para delegar.',
        );
      }
      await tx.measurement.update({
        where: { id },
        data: {
          assigneeUserId: input.assigneeUserId,
          ...(input.dueDate ? { dueDate: parseDateOnly(input.dueDate)! } : {}),
          version: { increment: 1 },
        },
      });
      await record(
        tx,
        request,
        { ...m, assigneeUserId: input.assigneeUserId },
        {
          kind: 'REATRIBUIDA',
          fromStatus: m.status,
          toStatus: m.status,
          note: input.note ?? null,
          changes: {
            assigneeUserId: { from: m.assigneeUserId, to: input.assigneeUserId },
            ...(input.dueDate ? { dueDate: input.dueDate } : {}),
          },
          summary: `Medição ${measurementCode(m.number)} reatribuída a ${assignee.user.displayName}.`,
          event: EVENT_TYPES.MEASUREMENT_ASSIGNED,
          extraUsers: [m.assigneeUserId],
        },
      );
    });
    return loadDetail(prisma, id, actorOf(request), todayIn(timezone));
  });

  app.post('/api/v1/measurements/:id/cancel', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = cancelMeasurementSchema.parse(request.body);
    const { timezone } = await companyTz(prisma);
    await prisma.$transaction(async (tx) => {
      const m = await lockMeasurement(tx, id);
      if (m.version !== input.version) throw Errors.versionConflict(m.version);
      if (m.status === 'CANCELADA') throw Errors.business('A medição já está cancelada.');
      if (m.request?.status === 'APROVADA') {
        throw Errors.business('A solicitação já foi aprovada. Reabra a revisão antes de cancelar.');
      }
      await tx.measurement.update({
        where: { id },
        data: {
          status: 'CANCELADA',
          cancelledAt: new Date(),
          cancelReason: input.reason,
          version: { increment: 1 },
        },
      });
      if (m.request) {
        await tx.materialRequest.update({
          where: { id: m.request.id },
          data: { status: 'CANCELADA', version: { increment: 1 } },
        });
      }
      await record(tx, request, m, {
        kind: 'CANCELADA',
        fromStatus: m.status,
        toStatus: 'CANCELADA',
        note: input.reason,
        summary: `Medição ${measurementCode(m.number)} cancelada.`,
        event: EVENT_TYPES.MEASUREMENT_CANCELLED,
      });
    });
    return loadDetail(prisma, id, actorOf(request), todayIn(timezone));
  });

  // ─────────────────────────── Execução (responsável) ───────────────────────────

  /** Garante que só o responsável (ou o gestor) altere a medição. */
  function assertExecutor(request: FastifyRequest, m: { assigneeUserId: string }) {
    const actor = actorOf(request);
    if (isManager(actor)) return;
    if (m.assigneeUserId !== actor.userId) {
      throw Errors.forbidden('Esta medição está atribuída a outra pessoa.');
    }
    if (!actor.permissions.has('medicoes.extraordinarias')) {
      throw Errors.forbidden('Você não está autorizado a executar medições.');
    }
  }

  function assertEditable(m: Awaited<ReturnType<typeof lockMeasurement>>) {
    if (m.status === 'CANCELADA') throw Errors.business('Medição cancelada.');
    const rs = m.request?.status;
    if (rs !== 'RASCUNHO' && rs !== 'DEVOLVIDA') {
      throw Errors.business(
        `A solicitação está "${MATERIAL_REQUEST_STATUS_LABEL[rs ?? 'RASCUNHO']}" e não pode ser alterada por aqui.`,
      );
    }
  }

  app.post('/api/v1/measurements/:id/start', { config: { access: EXECUTE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { version } = submitMeasurementSchema.parse(request.body);
    const { timezone } = await companyTz(prisma);
    await prisma.$transaction(async (tx) => {
      const m = await lockMeasurement(tx, id);
      assertExecutor(request, m);
      if (m.version !== version) throw Errors.versionConflict(m.version);
      if (m.status !== 'PENDENTE') return;
      await tx.measurement.update({
        where: { id },
        data: { status: 'EM_ANDAMENTO', startedAt: new Date(), version: { increment: 1 } },
      });
      await record(tx, request, m, {
        kind: 'INICIADA',
        fromStatus: 'PENDENTE',
        toStatus: 'EM_ANDAMENTO',
        summary: `Medição ${measurementCode(m.number)} iniciada.`,
        event: EVENT_TYPES.MEASUREMENT_STARTED,
      });
    });
    return loadDetail(prisma, id, actorOf(request), todayIn(timezone));
  });

  /** Salva rascunho (medidas das peças + materiais). Pode ser chamado várias vezes. */
  app.put('/api/v1/measurements/:id/draft', { config: { access: EXECUTE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = saveMeasurementDraftSchema.parse(request.body);
    const { timezone } = await companyTz(prisma);
    await prisma.$transaction(async (tx) => {
      const m = await lockMeasurement(tx, id);
      assertExecutor(request, m);
      if (m.version !== input.version) throw Errors.versionConflict(m.version);
      assertEditable(m);
      const allowed = new Set(
        (m.serviceOrderItemId
          ? m.serviceOrder.items.filter((i) => i.id === m.serviceOrderItemId)
          : m.serviceOrder.items
        ).map((i) => i.id),
      );
      const seen = new Set<string>();
      for (const p of input.pieces) {
        if (!allowed.has(p.serviceOrderItemId))
          throw Errors.validation(undefined, 'Peça não pertence a esta medição.');
        if (seen.has(p.serviceOrderItemId)) throw Errors.validation(undefined, 'Peça repetida.');
        seen.add(p.serviceOrderItemId);
      }
      await tx.measurementPiece.deleteMany({ where: { measurementId: id } });
      for (const p of input.pieces) {
        await tx.measurementPiece.create({
          data: {
            measurementId: id,
            serviceOrderItemId: p.serviceOrderItemId,
            dimensions: p.dimensions as unknown as Prisma.InputJsonValue,
            notes: p.notes ?? null,
          },
        });
      }
      await replaceItems(tx, m.request!.id, allowed, input.items);
      const starting = m.status === 'PENDENTE';
      await tx.measurement.update({
        where: { id },
        data: {
          notes: input.notes ?? null,
          version: { increment: 1 },
          ...(starting ? { status: 'EM_ANDAMENTO', startedAt: new Date() } : {}),
        },
      });
      if (starting) {
        await record(tx, request, m, {
          kind: 'INICIADA',
          fromStatus: 'PENDENTE',
          toStatus: 'EM_ANDAMENTO',
          summary: `Medição ${measurementCode(m.number)} iniciada.`,
          event: EVENT_TYPES.MEASUREMENT_STARTED,
        });
      } else {
        // Rascunho não entra no histórico imutável (a cópia completa é registrada no envio),
        // mas o painel é avisado para manter a visão atualizada.
        const cur = await tx.measurement.findUniqueOrThrow({
          where: { id },
          include: { request: true },
        });
        await appendEvent(tx, actorFrom(request), {
          type: EVENT_TYPES.MEASUREMENT_UPDATED,
          aggregateType: 'measurement',
          aggregateId: id,
          payload: {
            id,
            code: measurementCode(m.number),
            status: cur.status,
            requestStatus: cur.request?.status ?? null,
            version: cur.version,
          },
          audience: audienceFor(m.assigneeUserId),
        });
      }
    });
    return loadDetail(prisma, id, actorOf(request), todayIn(timezone));
  });

  /** Envia a medição: conclui a tarefa e envia a solicitação de materiais ao gestor. */
  app.post(
    '/api/v1/measurements/:id/submit',
    { config: { access: EXECUTE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { version } = submitMeasurementSchema.parse(request.body);
      const { timezone } = await companyTz(prisma);
      await prisma.$transaction(async (tx) => {
        const m = await lockMeasurement(tx, id);
        assertExecutor(request, m);
        if (m.version !== version) throw Errors.versionConflict(m.version);
        assertEditable(m);
        const pieces = await tx.measurementPiece.findMany({ where: { measurementId: id } });
        const measured = pieces.filter(
          (p) => Array.isArray(p.dimensions) && (p.dimensions as unknown[]).length > 0,
        );
        const items = m.request!.items;
        if (measured.length === 0 && items.length === 0) {
          throw Errors.validation(
            undefined,
            'Informe as medidas da peça ou os materiais necessários antes de enviar.',
          );
        }
        const actor = actorFrom(request);
        const now = new Date();
        const resubmission = m.request!.status === 'DEVOLVIDA';
        await tx.measurement.update({
          where: { id },
          data: {
            status: 'CONCLUIDA',
            completedAt: now,
            startedAt: m.startedAt ?? now,
            version: { increment: 1 },
          },
        });
        await tx.materialRequest.update({
          where: { id: m.request!.id },
          data: {
            status: 'ENVIADA',
            submittedAt: now,
            returnReason: null,
            version: { increment: 1 },
          },
        });
        // Medidas viram o valor vigente da peça na OS (com histórico técnico da OS).
        if (measured.length) {
          const so = await tx.serviceOrder.findUniqueOrThrow({
            where: { id: m.serviceOrderId },
            include: { items: true },
          });
          for (const p of measured) {
            await tx.serviceOrderItem.update({
              where: { id: p.serviceOrderItemId },
              data: {
                measurements: p.dimensions as Prisma.InputJsonValue,
                measurementNotes: p.notes,
                measuredAt: now,
                measuredById: m.assigneeUserId,
                measurementKind: m.kind,
                version: { increment: 1 },
              },
            });
          }
          const last = await tx.serviceOrderRevision.aggregate({
            where: { serviceOrderId: so.id },
            _max: { revision: true },
          });
          await tx.serviceOrderRevision.create({
            data: {
              serviceOrderId: so.id,
              revision: (last._max.revision ?? 0) + 1,
              scope: 'MEDICAO',
              itemId: m.serviceOrderItemId,
              changes: {
                measurement: measurementCode(m.number),
                kind: m.kind,
                pieces: measured.map((p) => ({
                  item: formatServiceOrderItemCode(
                    so.number,
                    so.items.find((i) => i.id === p.serviceOrderItemId)!.position,
                  ),
                  dimensions: p.dimensions,
                })),
              } as Prisma.InputJsonValue,
              changedById: actor.userId,
            },
          });
        }
        await record(tx, request, m, {
          kind: resubmission ? 'REENVIADA' : 'ENVIADA',
          fromStatus: m.request!.status,
          toStatus: 'ENVIADA',
          changes: { items: snapshotItems(items), piecesMeasured: measured.length },
          summary: `Medição ${measurementCode(m.number)} ${resubmission ? 'corrigida e reenviada' : 'concluída e enviada'} (${items.length} material(is)).`,
          event: EVENT_TYPES.MEASUREMENT_COMPLETED,
        });
        const cur = await tx.measurement.findUniqueOrThrow({
          where: { id },
          include: { request: true },
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.MATERIAL_REQUEST_SUBMITTED,
          aggregateType: 'material_request',
          aggregateId: m.request!.id,
          payload: {
            id: m.request!.id,
            measurementId: id,
            status: 'ENVIADA',
            version: cur.request!.version,
          },
          audience: audienceFor(m.assigneeUserId),
        });
      });
      return loadDetail(prisma, id, actorOf(request), todayIn(timezone));
    },
  );

  // ─────────────────────────── Revisão e aprovação (gestor) ───────────────────────────

  async function decision(
    request: FastifyRequest,
    measurementId: string,
    expectedVersion: number,
    run: (tx: Tx, m: Awaited<ReturnType<typeof lockMeasurement>>) => Promise<void>,
  ) {
    const { timezone } = await companyTz(prisma);
    await prisma.$transaction(async (tx) => {
      const m = await lockMeasurement(tx, measurementId);
      if (!m.request) throw Errors.notFound('Solicitação');
      if (m.request.version !== expectedVersion) throw Errors.versionConflict(m.request.version);
      await run(tx, m);
    });
    return loadDetail(prisma, measurementId, actorOf(request), todayIn(timezone));
  }

  const reqParams = z.object({ id: z.string().uuid() });

  /** Inicia a revisão (sinaliza ao executor que o gestor está conferindo). */
  app.post(
    '/api/v1/measurements/:id/request/review',
    { config: { access: APPROVE } },
    async (request) => {
      const { id } = reqParams.parse(request.params);
      const input = requestDecisionSchema.parse(request.body);
      return decision(request, id, input.version, async (tx, m) => {
        if (m.request!.status !== 'ENVIADA')
          throw Errors.business('Só solicitações enviadas podem entrar em revisão.');
        await tx.materialRequest.update({
          where: { id: m.request!.id },
          data: {
            status: 'EM_REVISAO',
            reviewedById: request.auth!.userId,
            version: { increment: 1 },
          },
        });
        await record(tx, request, m, {
          kind: 'EM_REVISAO',
          fromStatus: 'ENVIADA',
          toStatus: 'EM_REVISAO',
          note: input.note ?? null,
          summary: `Solicitação da medição ${measurementCode(m.number)} em revisão.`,
          event: EVENT_TYPES.MATERIAL_REQUEST_IN_REVIEW,
        });
      });
    },
  );

  /** Revisão de quantidades pelo gestor: substitui os itens com registro do antes/depois. */
  app.put(
    '/api/v1/measurements/:id/request/items',
    { config: { access: APPROVE } },
    async (request) => {
      const { id } = reqParams.parse(request.params);
      const input = reviseRequestSchema.parse(request.body);
      return decision(request, id, input.version, async (tx, m) => {
        if (m.request!.status !== 'EM_REVISAO') {
          throw Errors.business('Inicie a revisão antes de alterar as quantidades.');
        }
        const before = snapshotItems(m.request!.items);
        const osItemIds = new Set(
          (m.serviceOrderItemId
            ? m.serviceOrder.items.filter((i) => i.id === m.serviceOrderItemId)
            : m.serviceOrder.items
          ).map((i) => i.id),
        );
        await replaceItems(tx, m.request!.id, osItemIds, input.items);
        await tx.materialRequest.update({
          where: { id: m.request!.id },
          data: { version: { increment: 1 } },
        });
        await record(tx, request, m, {
          kind: 'REVISADA',
          fromStatus: 'EM_REVISAO',
          toStatus: 'EM_REVISAO',
          note: input.reason,
          changes: {
            before,
            after: snapshotItems(
              input.items.map((i) => ({
                ...i,
                color: i.color ?? null,
                serviceOrderItemId: i.serviceOrderItemId ?? null,
              })),
            ),
          },
          summary: `Quantidades da medição ${measurementCode(m.number)} revisadas pelo gestor.`,
          event: EVENT_TYPES.MATERIAL_REQUEST_REVISED,
        });
      });
    },
  );

  /**
   * Aprova para compra: quantidades conferidas. NÃO é compra, recebimento nem
   * disponibilidade — e não inicia produção.
   */
  app.post(
    '/api/v1/measurements/:id/request/approve',
    { config: { access: APPROVE, idempotent: true } },
    async (request) => {
      const { id } = reqParams.parse(request.params);
      const input = requestDecisionSchema.parse(request.body);
      return decision(request, id, input.version, async (tx, m) => {
        const from = m.request!.status;
        if (from !== 'ENVIADA' && from !== 'EM_REVISAO') {
          throw Errors.business(
            `Solicitação "${MATERIAL_REQUEST_STATUS_LABEL[from]}" não pode ser aprovada.`,
          );
        }
        if (m.request!.items.length === 0) throw Errors.business('Não há materiais para aprovar.');
        const now = new Date();
        await tx.materialRequest.update({
          where: { id: m.request!.id },
          data: {
            status: 'APROVADA',
            approvedAt: now,
            reviewedById: request.auth!.userId,
            version: { increment: 1 },
          },
        });
        // Necessidades aprovadas da OS (base das compras na Fase 4).
        for (const it of m.request!.items) {
          await tx.materialRequirement.create({
            data: {
              serviceOrderId: m.serviceOrderId,
              serviceOrderItemId: it.serviceOrderItemId,
              kind: it.kind,
              description: it.description,
              quantity: it.quantity,
              unit: null,
              unitCode: it.unit,
              sourcing: it.sourcing,
              notes: it.notes,
              origin: 'SOLICITACAO_APROVADA',
              materialRequestItemId: it.id,
              color: it.color,
              reference: it.reference,
              foamDensity: it.foamDensity,
              thicknessCm: it.thicknessCm,
              lengthCm: it.lengthCm,
              widthCm: it.widthCm,
              approvedAt: now,
            },
          });
        }
        await record(tx, request, m, {
          kind: 'APROVADA',
          fromStatus: from,
          toStatus: 'APROVADA',
          note: input.note ?? null,
          changes: { items: snapshotItems(m.request!.items) },
          summary: `Materiais da medição ${measurementCode(m.number)} aprovados para compra (quantidades conferidas; ainda não comprados).`,
          event: EVENT_TYPES.MATERIAL_REQUEST_APPROVED,
        });
      });
    },
  );

  app.post(
    '/api/v1/measurements/:id/request/return',
    { config: { access: APPROVE } },
    async (request) => {
      const { id } = reqParams.parse(request.params);
      const input = returnRequestSchema.parse(request.body);
      return decision(request, id, input.version, async (tx, m) => {
        const from = m.request!.status;
        if (from !== 'ENVIADA' && from !== 'EM_REVISAO') {
          throw Errors.business(
            `Solicitação "${MATERIAL_REQUEST_STATUS_LABEL[from]}" não pode ser devolvida.`,
          );
        }
        await tx.materialRequest.update({
          where: { id: m.request!.id },
          data: {
            status: 'DEVOLVIDA',
            returnReason: input.reason,
            reviewedById: request.auth!.userId,
            version: { increment: 1 },
          },
        });
        // A medição volta para o responsável corrigir.
        await tx.measurement.update({
          where: { id },
          data: { status: 'EM_ANDAMENTO', completedAt: null, version: { increment: 1 } },
        });
        await record(tx, request, m, {
          kind: 'DEVOLVIDA',
          fromStatus: from,
          toStatus: 'DEVOLVIDA',
          note: input.reason,
          summary: `Medição ${measurementCode(m.number)} devolvida para correção.`,
          event: EVENT_TYPES.MATERIAL_REQUEST_RETURNED,
        });
      });
    },
  );

  /** Reabre uma solicitação aprovada para revisão (alteração explícita e auditada). */
  app.post(
    '/api/v1/measurements/:id/request/reopen',
    { config: { access: APPROVE } },
    async (request) => {
      const { id } = reqParams.parse(request.params);
      const input = returnRequestSchema.parse(request.body);
      return decision(request, id, input.version, async (tx, m) => {
        if (m.request!.status !== 'APROVADA')
          throw Errors.business('Só solicitações aprovadas podem ser reabertas.');
        const removed = await tx.materialRequirement.deleteMany({
          where: { materialRequestItemId: { in: m.request!.items.map((i) => i.id) } },
        });
        await tx.materialRequest.update({
          where: { id: m.request!.id },
          data: { status: 'EM_REVISAO', approvedAt: null, version: { increment: 1 } },
        });
        await record(tx, request, m, {
          kind: 'REABERTA',
          fromStatus: 'APROVADA',
          toStatus: 'EM_REVISAO',
          note: input.reason,
          changes: { removedApprovedNeeds: removed.count, items: snapshotItems(m.request!.items) },
          summary: `Aprovação dos materiais da medição ${measurementCode(m.number)} reaberta para revisão.`,
          event: EVENT_TYPES.MATERIAL_REQUEST_REOPENED,
        });
      });
    },
  );
}

/** Peças aguardando medição (sem medidas e sem medição em aberto). */
export async function awaitingMeasurement(prisma: PrismaClient): Promise<AwaitingMeasurementDto[]> {
  const items = await prisma.serviceOrderItem.findMany({
    where: {
      measuredAt: null,
      serviceOrder: { status: 'ABERTA' },
      // Medição em aberto ou concluída (com medidas e/ou materiais) tira a peça da fila.
      measurementTasks: { none: { status: { in: ['PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDA'] } } },
    },
    include: {
      serviceOrder: {
        include: {
          customer: true,
          measurements: {
            where: {
              status: { in: ['PENDENTE', 'EM_ANDAMENTO', 'CONCLUIDA'] },
              serviceOrderItemId: null,
            },
          },
        },
      },
      orderItem: {
        include: { receiptLines: { include: { receipt: { select: { receivedAt: true } } } } },
      },
    },
    orderBy: [{ serviceOrder: { number: 'asc' } }, { position: 'asc' }],
  });
  return items
    .filter((i) => i.serviceOrder.measurements.length === 0)
    .map((i) => {
      const dates = i.orderItem.receiptLines.map((l) => l.receipt.receivedAt.getTime());
      return {
        serviceOrder: {
          id: i.serviceOrderId,
          code: serviceOrderCode(i.serviceOrder.number),
          promisedDate: dateOnly(i.serviceOrder.promisedDate),
          priority: i.serviceOrder.priority,
        },
        customer: toCustomerSummary(i.serviceOrder.customer),
        item: {
          id: i.id,
          code: formatServiceOrderItemCode(i.serviceOrder.number, i.position),
          description: i.description,
          quantity: i.quantity,
          pieceType: i.pieceType,
        },
        receivedAt: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
      };
    });
}
