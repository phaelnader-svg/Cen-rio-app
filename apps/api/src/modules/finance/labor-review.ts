/**
 * Evolução, Fase 5 — mão de obra dos tapeceiros: revisão financeira, valor por peça, edição
 * auditada, dados por semana (base da Fase 7) e "Meus valores" com confirmação de PIN.
 *
 * Fonte única de verdade: `production_payables` (obrigação), `financial_adjustments`
 * (ajustes) e `professional_payments` (pagamentos). Previsto/liberado/pago/saldo são derivados
 * dessas linhas — nenhum total redundante é gravado.
 */
import {
  EVENT_TYPES,
  editLaborAgreedSchema,
  formatServiceOrderItemCode,
  laborDue,
  laborWeeklyQuerySchema,
  myProductionUnlockSchema,
  productionPayableCode,
  resolveLaborReviewSchema,
  reviewResolutionProblem,
  type LaborReviewDto,
  type LaborWeeklyDto,
  type ServiceOrderLaborDto,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { AuthThrottle, POLICIES } from '../../core/throttle';
import type { ActorContext } from '../../core/types';
import { burnVerification, verifySecret } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
import { serviceOrderCode } from '../commercial/common';
import { idParams } from '../presenters';
import { workers } from '../production/plans';
import {
  FIN_ADJUST,
  FIN_OWN,
  FIN_VIEW,
  checkVersion,
  dateOnly,
  financeEvent,
  lockRow,
} from './common';
import {
  laborInclude,
  laborReviewCode,
  myProduction,
  openReviewIndex,
  openReviewOf,
  refreshLabor,
  refreshLaborOf,
  toLaborDto,
} from './labor';

// ─────────────────────────── Abertura (substituição de titular) ───────────────────────────

/**
 * Abre a revisão financeira quando a titularidade de uma peça muda e já existe mão de obra
 * combinada com outra pessoa (na peça ou na OS inteira). Idempotente: uma revisão aberta por
 * escopo. Nada é transferido; liberação e pagamento ficam travados até a resolução.
 */
export async function openLaborReviews(
  tx: Tx,
  actor: ActorContext,
  input: {
    serviceOrderId: string;
    itemId: string;
    newOwnerId: string;
    ownerChangeId: string | null;
  },
) {
  const affected = await tx.productionPayable.findMany({
    where: {
      serviceOrderId: input.serviceOrderId,
      OR: [{ serviceOrderItemId: input.itemId }, { serviceOrderItemId: null }],
      status: { not: 'CANCELADO' },
      professionalUserId: { not: input.newOwnerId },
    },
    select: { serviceOrderItemId: true },
  });
  const scopes = [...new Set(affected.map((a) => a.serviceOrderItemId))];
  const opened: string[] = [];
  for (const [i, scope] of scopes.entries()) {
    const existing = await openReviewOf(tx, {
      serviceOrderId: input.serviceOrderId,
      serviceOrderItemId: scope,
    });
    if (existing) continue;
    const r = await tx.laborReview.create({
      data: {
        serviceOrderId: input.serviceOrderId,
        serviceOrderItemId: scope,
        // A troca registrada liga-se à primeira revisão (índice único).
        ownerChangeId: i === 0 ? input.ownerChangeId : null,
        reason:
          scope === null
            ? 'Mão de obra combinada para a OS inteira e titular de peça alterado: defina o valor devido a cada profissional.'
            : 'Titular da peça substituído com mão de obra já combinada: defina o valor devido a cada profissional.',
        openedById: actor.userId,
      },
    });
    await audit(tx, actor, {
      action: 'finance.labor_review_opened',
      entityType: 'labor_review',
      entityId: r.id,
      summary: `${laborReviewCode(r.number)} aberta: ${r.reason}`,
    });
    await financeEvent(tx, actor, {
      entityType: 'labor_review',
      entityId: r.id,
      kind: 'REVISAO_ABERTA',
      note: r.reason,
      type: EVENT_TYPES.FINANCE_COST_UPDATED,
    });
    opened.push(r.id);
  }
  return opened;
}

// ─────────────────────────── Leitura ───────────────────────────

async function reviewDto(db: Tx | PrismaClient, id: string): Promise<LaborReviewDto> {
  const r = await db.laborReview.findUniqueOrThrow({
    where: { id },
    include: {
      serviceOrder: { select: { id: true, number: true } },
      item: { select: { id: true, position: true } },
      openedBy: { select: { displayName: true } },
      resolvedBy: { select: { displayName: true } },
    },
  });
  const payables = await db.productionPayable.findMany({
    where: {
      serviceOrderId: r.serviceOrderId,
      serviceOrderItemId: r.serviceOrderItemId,
      status: { not: 'CANCELADO' },
    },
    include: { professional: { select: { displayName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return {
    id: r.id,
    code: laborReviewCode(r.number),
    status: r.status as LaborReviewDto['status'],
    serviceOrder: { id: r.serviceOrder.id, code: serviceOrderCode(r.serviceOrder.number) },
    piece: r.item
      ? { id: r.item.id, code: formatServiceOrderItemCode(r.serviceOrder.number, r.item.position) }
      : null,
    reason: r.reason,
    lines: payables.map((p) => ({
      professionalUserId: p.professionalUserId,
      displayName: p.professional.displayName,
      dueCents: laborDue(p),
      paidCents: p.paidCents,
    })),
    resolution: (r.resolution as LaborReviewDto['resolution']) ?? null,
    resolutionNote: r.resolutionNote,
    openedBy: r.openedBy?.displayName ?? null,
    resolvedBy: r.resolvedBy?.displayName ?? null,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    version: r.version,
  };
}

export async function serviceOrderLabor(
  db: Tx | PrismaClient,
  serviceOrderId: string,
): Promise<ServiceOrderLaborDto> {
  const so = await db.serviceOrder.findUnique({
    where: { id: serviceOrderId },
    include: {
      items: {
        orderBy: { position: 'asc' },
        include: { upholsterer: { select: { id: true, displayName: true } } },
      },
    },
  });
  if (!so) throw Errors.notFound('Ordem de serviço');
  const rows = await db.productionPayable.findMany({
    where: { serviceOrderId },
    include: laborInclude,
    orderBy: { createdAt: 'asc' },
  });
  const index = await openReviewIndex(db, [{ serviceOrderId }]);
  const dtos = await Promise.all(rows.map((r) => toLaborDto(db, r, index)));
  const reviews = await db.laborReview.findMany({
    where: { serviceOrderId, status: 'ABERTA' },
    select: { id: true },
  });
  return {
    serviceOrder: { id: so.id, code: serviceOrderCode(so.number) },
    pieces: await Promise.all(
      so.items.map(async (i) => {
        const payables = dtos.filter((d) => d.piece?.id === i.id);
        const review = await openReviewOf(db, { serviceOrderId, serviceOrderItemId: i.id });
        return {
          id: i.id,
          code: formatServiceOrderItemCode(so.number, i.position),
          description: i.description,
          stage: i.fulfillmentStage,
          upholsterer: i.upholsterer
            ? { userId: i.upholsterer.id, displayName: i.upholsterer.displayName }
            : null,
          payables,
          missingValue: Boolean(
            i.upholstererUserId &&
              !payables.some(
                (p) => p.status !== 'CANCELADO' && p.professional.userId === i.upholstererUserId,
              ) &&
              !dtos.some((d) => !d.piece && d.status !== 'CANCELADO'),
          ),
          openReview: review ? { id: review.id, code: laborReviewCode(review.number) } : null,
        };
      }),
    ),
    wholeOrder: dtos.filter((d) => !d.piece),
    openReviews: await Promise.all(reviews.map((r) => reviewDto(db, r.id))),
  };
}

// ─────────────────────────── Edição e resolução ───────────────────────────

/** Corrige o valor combinado (antes de qualquer pagamento), com motivo e antes/depois. */
export async function editLaborAgreed(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: z.output<typeof editLaborAgreedSchema>,
) {
  await lockRow(tx, 'production_payables', id, 'Mão de obra');
  const p = await tx.productionPayable.findUniqueOrThrow({ where: { id } });
  checkVersion(p, input.version);
  if (p.status === 'CANCELADO') throw Errors.business('Mão de obra cancelada.');
  if (p.paidCents > 0)
    throw Errors.business(
      'Já há pagamento registrado: corrija com um ajuste justificado (o valor combinado fica como histórico).',
    );
  const review = await openReviewOf(tx, p);
  if (review)
    throw Errors.business(
      `Revisão financeira ${laborReviewCode(review.number)} pendente: defina os valores pela revisão.`,
    );
  if (p.agreedCents === input.agreedCents) return p;
  if (p.agreedCents + p.adjustmentsCents < 0 || input.agreedCents + p.adjustmentsCents < 0)
    throw Errors.business('O valor devido não pode ficar negativo.');
  await tx.productionPayable.update({
    where: { id },
    data: { agreedCents: input.agreedCents, version: { increment: 1 } },
  });
  await audit(tx, actor, {
    action: 'finance.labor_agreed_changed',
    entityType: 'production_payable',
    entityId: id,
    summary: `${productionPayableCode(p.number)}: valor combinado alterado. Motivo: ${input.reason}`,
    changes: { agreedCents: { from: p.agreedCents, to: input.agreedCents } },
  });
  await financeEvent(tx, actor, {
    entityType: 'production_payable',
    entityId: id,
    kind: 'VALOR_ALTERADO',
    note: input.reason,
    data: { fromCents: p.agreedCents, toCents: input.agreedCents },
    type: EVENT_TYPES.FINANCE_COST_UPDATED,
  });
  return refreshLabor(tx, actor, id);
}

/**
 * Resolve a revisão: o gestor define o valor devido a cada profissional (sem rateio
 * automático). Obrigações existentes viram ajustes justificados (nunca abaixo do pago) ou
 * são canceladas (zero, sem pagamento); novos profissionais ganham obrigação própria ligada à
 * revisão. Pagamentos e histórico anteriores ficam intactos.
 */
export async function resolveLaborReview(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: z.output<typeof resolveLaborReviewSchema>,
) {
  await lockRow(tx, 'labor_reviews', id, 'Revisão financeira');
  const r = await tx.laborReview.findUniqueOrThrow({ where: { id } });
  if (r.status !== 'ABERTA') throw Errors.business('Esta revisão já foi resolvida.');
  checkVersion(r, input.version);
  const payables = await tx.productionPayable.findMany({
    where: {
      serviceOrderId: r.serviceOrderId,
      serviceOrderItemId: r.serviceOrderItemId,
      status: { not: 'CANCELADO' },
    },
    orderBy: { createdAt: 'asc' },
  });
  for (const p of payables) await lockRow(tx, 'production_payables', p.id, 'Mão de obra');
  const existing = payables.map((p) => ({
    professionalUserId: p.professionalUserId,
    dueCents: laborDue(p),
    paidCents: p.paidCents,
  }));
  const problem = reviewResolutionProblem(input.lines, existing);
  if (problem) throw Errors.business(problem);
  const team = await workers(tx);
  const resolution: NonNullable<LaborReviewDto['resolution']> = [];
  const touched: string[] = [];
  for (const line of input.lines) {
    const p = payables.find((x) => x.professionalUserId === line.professionalUserId);
    if (p) {
      const due = laborDue(p);
      if (line.amountCents === 0 && p.paidCents === 0) {
        await tx.productionPayable.update({
          where: { id: p.id },
          data: {
            status: 'CANCELADO',
            cancelReason: `Revisão ${laborReviewCode(r.number)}: ${input.reason}`.slice(0, 500),
            version: { increment: 1 },
          },
        });
        await financeEvent(tx, actor, {
          entityType: 'production_payable',
          entityId: p.id,
          kind: 'CANCELADO',
          note: `Revisão ${laborReviewCode(r.number)}: ${input.reason}`,
          type: EVENT_TYPES.FINANCE_COST_UPDATED,
        });
      } else if (line.amountCents !== due) {
        const delta = line.amountCents - due;
        await tx.financialAdjustment.create({
          data: {
            productionPayableId: p.id,
            amountCents: delta,
            reason: `Revisão ${laborReviewCode(r.number)}: ${input.reason}`.slice(0, 500),
            authorizedById: actor.userId!,
          },
        });
        await tx.productionPayable.update({
          where: { id: p.id },
          data: { adjustmentsCents: { increment: delta }, version: { increment: 1 } },
        });
        await financeEvent(tx, actor, {
          entityType: 'production_payable',
          entityId: p.id,
          kind: 'AJUSTE',
          note: `Revisão ${laborReviewCode(r.number)}: ${input.reason}`,
          data: { amountCents: delta },
          type: EVENT_TYPES.FINANCE_COST_UPDATED,
        });
      }
      resolution.push({
        professionalUserId: p.professionalUserId,
        beforeCents: due,
        afterCents: line.amountCents,
        paidCents: p.paidCents,
        payableId: p.id,
      });
      touched.push(p.id);
      continue;
    }
    const w = team.find((x) => x.userId === line.professionalUserId);
    if (!w?.isTapeceiro)
      throw Errors.business('A mão de obra por produção é só para tapeceiros ativos.');
    const base = payables[0];
    const created = await tx.productionPayable.create({
      data: {
        professionalUserId: w.userId,
        serviceOrderId: r.serviceOrderId,
        serviceOrderItemId: r.serviceOrderItemId,
        service: `${base?.service ?? 'Mão de obra'} (revisão ${laborReviewCode(r.number)})`.slice(
          0,
          200,
        ),
        agreedCents: line.amountCents,
        eligibility: base?.eligibility ?? 'QUALIDADE_APROVADA',
        notes: input.reason,
        createdById: actor.userId,
        reviewId: r.id,
      },
    });
    await financeEvent(tx, actor, {
      entityType: 'production_payable',
      entityId: created.id,
      kind: 'COMBINADO',
      note: `Revisão ${laborReviewCode(r.number)}: ${input.reason}`,
      data: { agreedCents: line.amountCents },
      type: EVENT_TYPES.FINANCE_PAYABLE_CREATED,
      status: created.status,
    });
    resolution.push({
      professionalUserId: w.userId,
      beforeCents: 0,
      afterCents: line.amountCents,
      paidCents: 0,
      payableId: created.id,
    });
    touched.push(created.id);
  }
  await tx.laborReview.update({
    where: { id },
    data: {
      status: 'RESOLVIDA',
      resolution,
      resolutionNote: input.reason,
      resolvedById: actor.userId,
      resolvedAt: new Date(),
      version: { increment: 1 },
    },
  });
  await audit(tx, actor, {
    action: 'finance.labor_review_resolved',
    entityType: 'labor_review',
    entityId: id,
    summary: `${laborReviewCode(r.number)} resolvida: ${input.reason}`,
    changes: { resolution },
  });
  await financeEvent(tx, actor, {
    entityType: 'labor_review',
    entityId: id,
    kind: 'REVISAO_RESOLVIDA',
    note: input.reason,
    type: EVENT_TYPES.FINANCE_COST_UPDATED,
  });
  for (const pid of touched) await refreshLabor(tx, actor, pid);
}

// ─────────────────────────── Base da Fase 7 ───────────────────────────

const mondayOf = (d: Date) => {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
};
const localDay = (d: Date, timeZone: string) =>
  new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone }).format(d)}T00:00:00Z`);

/**
 * Totais por profissional e semana: combinado (data de criação), liberado (data de liberação
 * `eligibleAt`) e pago (data do pagamento). Cada obrigação entra uma vez em cada categoria;
 * canceladas não entram. Referência sugerida para o fechamento: data de liberação.
 */
export async function laborWeekly(
  db: Tx | PrismaClient,
  from: string,
  to: string,
  timeZone = 'America/Sao_Paulo',
): Promise<LaborWeeklyDto> {
  const start = new Date(`${from}T00:00:00-03:00`);
  const end = new Date(new Date(`${to}T00:00:00-03:00`).getTime() + 86_400_000);
  const payables = await db.productionPayable.findMany({
    where: { status: { not: 'CANCELADO' } },
    include: {
      professional: { select: { id: true, displayName: true } },
      payments: true,
    },
  });
  const rows = new Map<string, LaborWeeklyDto['rows'][number]>();
  const row = (p: (typeof payables)[number], when: Date) => {
    const week = mondayOf(localDay(when, timeZone));
    const k = `${p.professionalUserId}|${week}`;
    if (!rows.has(k))
      rows.set(k, {
        professionalUserId: p.professionalUserId,
        displayName: p.professional.displayName,
        weekStart: week,
        agreedCents: 0,
        releasedCents: 0,
        paidCents: 0,
      });
    return rows.get(k)!;
  };
  const inRange = (d: Date | null) => Boolean(d && d >= start && d < end);
  const open = new Map<string, LaborWeeklyDto['openByProfessional'][number]>();
  for (const p of payables) {
    if (inRange(p.createdAt)) row(p, p.createdAt).agreedCents += laborDue(p);
    if (inRange(p.eligibleAt)) row(p, p.eligibleAt!).releasedCents += laborDue(p);
    for (const pay of p.payments) {
      const at = new Date(`${dateOnly(pay.paidAt)}T12:00:00-03:00`);
      if (inRange(at)) row(p, at).paidCents += pay.amountCents;
    }
    if (p.status === 'LIBERADO' || p.status === 'PAGO_PARCIAL') {
      const o = open.get(p.professionalUserId) ?? {
        professionalUserId: p.professionalUserId,
        displayName: p.professional.displayName,
        openCents: 0,
      };
      o.openCents += Math.max(0, laborDue(p) - p.paidCents);
      open.set(p.professionalUserId, o);
    }
  }
  return {
    from,
    to,
    rows: [...rows.values()].sort(
      (a, b) =>
        a.weekStart.localeCompare(b.weekStart) || a.displayName.localeCompare(b.displayName),
    ),
    openByProfessional: [...open.values()],
  };
}

// ─────────────────────────── Rotas ───────────────────────────

export async function laborReviewRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  const throttle = new AuthThrottle(prisma);
  const tx = <T>(fn: (t: Tx) => Promise<T>) => prisma.$transaction(fn);

  app.get(
    '/api/v1/finance/service-orders/:id/labor',
    { config: { access: FIN_VIEW } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      await tx((t) => refreshLaborOf(t, actorFrom(request), { serviceOrderId: id }));
      return serviceOrderLabor(prisma, id);
    },
  );

  app.get('/api/v1/finance/labor-reviews', { config: { access: FIN_VIEW } }, async (request) => {
    const q = z.object({ status: z.enum(['ABERTA', 'RESOLVIDA']).optional() }).parse(request.query);
    const rows = await prisma.laborReview.findMany({
      where: q.status ? { status: q.status } : {},
      orderBy: { number: 'desc' },
      take: 200,
      select: { id: true },
    });
    return Promise.all(rows.map((r) => reviewDto(prisma, r.id)));
  });

  app.get('/api/v1/finance/labor-reviews/:id', { config: { access: FIN_VIEW } }, async (request) =>
    reviewDto(prisma, idParams.parse(request.params).id),
  );

  app.post(
    '/api/v1/finance/labor-reviews/:id/resolve',
    { config: { access: FIN_ADJUST, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = resolveLaborReviewSchema.parse(request.body);
      await tx((t) => resolveLaborReview(t, actorFrom(request), id, input));
      return reviewDto(prisma, id);
    },
  );

  app.post(
    '/api/v1/finance/labor/:id/agreed',
    { config: { access: FIN_ADJUST, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = editLaborAgreedSchema.parse(request.body);
      await tx((t) => editLaborAgreed(t, actorFrom(request), id, input));
      return toLaborDto(
        prisma,
        await prisma.productionPayable.findUniqueOrThrow({ where: { id }, include: laborInclude }),
      );
    },
  );

  app.get('/api/v1/finance/labor-weekly', { config: { access: FIN_VIEW } }, async (request) => {
    const q = laborWeeklyQuerySchema.parse(request.query);
    await tx((t) => refreshLaborOf(t, actorFrom(request), {}));
    return laborWeekly(prisma, q.from, q.to);
  });

  /**
   * "Meus valores" no tablet: a sessão do tablet é longa e o aparelho fica na oficina, então o
   * PIN é confirmado a cada abertura (mesmo limite de tentativas do login). Resposta sem cache.
   */
  app.post(
    '/api/v1/finance/my-production/unlock',
    { config: { access: FIN_OWN } },
    async (request, reply) => {
      const { pin } = myProductionUnlockSchema.parse(request.body);
      const userId = request.auth!.userId;
      const employee = await prisma.employee.findUnique({
        where: { userId },
        include: { user: true },
      });
      const key = `pin:${employee?.id ?? userId}`;
      await throttle.assertAllowed([key]);
      const ok = employee?.user.pinHash
        ? await verifySecret(employee.user.pinHash, pin)
        : (await burnVerification(pin), false);
      if (!ok) {
        await throttle.registerFailure(key, POLICIES.pin);
        throw Errors.invalidCredentials('PIN incorreto.');
      }
      await throttle.reset(key);
      await tx((t) =>
        refreshLaborOf(t, actorFrom(request), {
          professionalUserId: userId,
          status: { in: ['PREVISTO', 'LIBERADO'] },
        }),
      );
      void reply.header('cache-control', 'no-store');
      return myProduction(prisma, userId);
    },
  );
}
