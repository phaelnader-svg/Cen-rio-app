/**
 * R2 — negociação de valores: "eu, profissional, discordo deste valor e peço alteração".
 *
 * O pedido NUNCA move dinheiro. A aprovação aplica pelas funções financeiras existentes
 * (`editLaborAgreed` antes da liberação e de qualquer pagamento; senão `adjustLabor`; viagem:
 * `adjustTripCost`) na MESMA transação — não existe "aprovada sem efeito". O pedido guarda o valor
 * que o profissional viu: se o alvo mudou (ajuste, revisão, troca de titular, cancelamento,
 * recebedor), o pedido fica OBSOLETO e nada é aplicado. Uma única decisão financeira por alvo:
 * revisão financeira aberta impede pedir e torna obsoleto o pedido pendente.
 *
 * Ordem de travas: pedido → alvo (production_payables | logistics_costs) → conta a pagar.
 */
import {
  closingWeekStart,
  laborDue,
  productionPayableCode,
  logisticsCostCode,
  valueChangeCode,
  formatServiceOrderItemCode,
  type ConfirmationLine,
  type OwnValueChangeDto,
  type ValueChangeRequestDto,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx, ValueChangeRequest } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { serviceOrderCode } from '../commercial/common';
import { notify, resolveNotifications } from '../notifications/notify';
import { idParams } from '../presenters';
import { notifyUsersWith } from '../quality/common';
import { notifyOwnChanged } from './own-changed';
import {
  FIN_ADJUST,
  FIN_VIEW,
  checkVersion,
  financeEvent,
  localDateOf,
  lockRow,
  shopTimezone,
} from './common';
import { editLaborAgreed } from './labor-review';
import { adjustLabor, laborReviewCode, openReviewOf } from './labor';
import { OWN_EARNINGS, UNLOCK_HEADER, unlockValid } from './my-earnings';
import { adjustTripCost } from './trip-costs';

type Db = Tx | PrismaClient;

const targetInclude = {
  payable: {
    include: {
      item: { select: { id: true, position: true, upholstererUserId: true } },
      serviceOrder: { select: { number: true } },
    },
  },
  cost: {
    include: {
      allocations: { include: { serviceOrder: { select: { number: true } } } },
      pickup: { select: { number: true } },
      delivery: { select: { number: true } },
    },
  },
  beneficiary: { select: { id: true, displayName: true } },
  decidedBy: { select: { displayName: true } },
} as const satisfies Prisma.ValueChangeRequestInclude;
type Row = Prisma.ValueChangeRequestGetPayload<{ include: typeof targetInclude }>;

/** Valor devido atual do alvo. */
const dueNow = (r: Row) =>
  r.payable ? laborDue(r.payable) : r.cost ? r.cost.amountCents + r.cost.adjustmentsCents : 0;

/** Motivo de o pedido não poder mais ser aplicado (null = ainda vale). */
async function staleReason(db: Db, r: Row): Promise<string | null> {
  if (r.payable) {
    const p = r.payable;
    if (p.status === 'CANCELADO') return 'O valor foi cancelado.';
    if (p.professionalUserId !== r.beneficiaryUserId)
      return 'O valor não é mais deste profissional.';
    if (p.item?.upholstererUserId && p.item.upholstererUserId !== r.beneficiaryUserId)
      return 'O titular da peça mudou.';
    const review = await openReviewOf(db, p);
    if (review)
      return `Revisão financeira ${laborReviewCode(review.number)} aberta para este valor.`;
  } else if (r.cost) {
    const c = r.cost;
    if (c.cancelledAt || c.status === 'CANCELADO') return 'O custo da viagem foi cancelado.';
    if (c.payeeUserId !== r.beneficiaryUserId) return 'O recebedor da viagem mudou.';
  }
  if (dueNow(r) !== r.currentCents) return 'O valor mudou depois do pedido.';
  return null;
}

/** Marca como OBSOLETOS os pedidos pendentes que não podem mais ser aplicados (histórico). */
export async function markStaleRequests(
  tx: Tx,
  actor: ActorContext,
  where: Prisma.ValueChangeRequestWhereInput,
) {
  const rows = await tx.valueChangeRequest.findMany({
    where: { ...where, status: 'PENDENTE' },
    include: targetInclude,
  });
  const out: string[] = [];
  for (const r of rows) {
    const why = await staleReason(tx, r);
    if (why) {
      await obsolete(tx, actor, r, why);
      out.push(r.id);
    }
  }
  return out;
}

async function obsolete(tx: Tx, actor: ActorContext, r: ValueChangeRequest, why: string) {
  const u = await tx.valueChangeRequest.updateMany({
    where: { id: r.id, status: 'PENDENTE' },
    data: {
      status: 'OBSOLETA',
      decisionNote: why,
      decidedAt: new Date(),
      decidedById: actor.userId,
      version: { increment: 1 },
    },
  });
  if (!u.count) return;
  await resolveNotifications(tx, actor, 'VALOR_SOLICITADO', [`VALOR:${r.id}`]);
  // F8-15b: o pedido some dos pendentes do profissional (não passa pelo histórico financeiro).
  await notifyOwnChanged(tx, actor, [r.beneficiaryUserId], 'value_change_request');
  await audit(tx, actor, {
    action: 'finance.value_request_obsolete',
    entityType: 'value_change_request',
    entityId: r.id,
    summary: `${valueChangeCode(r.number)} obsoleta: ${why}`,
  });
  await notify(tx, actor, [
    {
      userId: r.beneficiaryUserId,
      kind: 'VALOR_DECIDIDO',
      dedupeKey: `VALOR:${r.id}:OBSOLETA`,
      body: `Seu pedido ${valueChangeCode(r.number)} não pode mais ser aplicado: o item mudou. Confira em Meus ganhos.`,
      includeActor: true,
    },
  ]);
}

/** Pedidos pendentes (ainda válidos) do profissional sobre as linhas da semana. */
export async function pendingRequestCodes(
  db: Db,
  userId: string,
  lines: readonly ConfirmationLine[],
) {
  const labor = lines.filter((l) => l.kind === 'MAO_DE_OBRA').map((l) => l.id);
  const costs = lines.filter((l) => l.kind === 'LOGISTICA').map((l) => l.id);
  if (!labor.length && !costs.length) return [];
  const rows = await db.valueChangeRequest.findMany({
    where: {
      beneficiaryUserId: userId,
      status: 'PENDENTE',
      OR: [{ productionPayableId: { in: labor } }, { logisticsCostId: { in: costs } }],
    },
    include: targetInclude,
    orderBy: { number: 'asc' },
  });
  const out: string[] = [];
  for (const r of rows) if (!(await staleReason(db, r))) out.push(valueChangeCode(r.number));
  return out;
}

const ownDto = (r: ValueChangeRequest, stale: string | null): OwnValueChangeDto => ({
  id: r.id,
  code: valueChangeCode(r.number),
  status: r.status === 'PENDENTE' && stale ? 'OBSOLETA' : (r.status as OwnValueChangeDto['status']),
  currentCents: r.currentCents,
  requestedCents: r.requestedCents,
  reason: r.reason,
  decisionNote: r.status === 'PENDENTE' && stale ? stale : r.decisionNote,
  decidedAt: r.decidedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

/** Último pedido de cada item do próprio profissional (para "Meus Ganhos"). */
export async function ownRequestIndex(db: Db, userId: string, itemIds: string[]) {
  const rows = await db.valueChangeRequest.findMany({
    where: {
      beneficiaryUserId: userId,
      OR: [{ productionPayableId: { in: itemIds } }, { logisticsCostId: { in: itemIds } }],
    },
    include: targetInclude,
    orderBy: { number: 'desc' },
  });
  const out = new Map<string, OwnValueChangeDto>();
  for (const r of rows) {
    const key = r.productionPayableId ?? r.logisticsCostId!;
    if (out.has(key)) continue;
    out.set(key, ownDto(r, r.status === 'PENDENTE' ? await staleReason(db, r) : null));
  }
  return out;
}

async function managerDto(db: Db, r: Row, tz: string): Promise<ValueChangeRequestDto> {
  const stale = r.status === 'PENDENTE' ? await staleReason(db, r) : null;
  const target = r.payable
    ? {
        id: r.payable.id,
        code: productionPayableCode(r.payable.number),
        description: r.payable.service,
        serviceOrders: [serviceOrderCode(r.payable.serviceOrder.number)],
        piece: r.payable.item
          ? formatServiceOrderItemCode(r.payable.serviceOrder.number, r.payable.item.position)
          : null,
      }
    : {
        id: r.cost!.id,
        code: logisticsCostCode(r.cost!.number),
        description: r.cost!.description,
        serviceOrders: [
          ...new Set(
            r
              .cost!.allocations.filter((a) => a.revision === r.cost!.allocationRevision)
              .map((a) => serviceOrderCode(a.serviceOrder.number)),
          ),
        ],
        piece: null,
      };
  const when = r.payable?.eligibleAt ?? r.cost?.dueAt ?? null;
  return {
    ...ownDto(r, stale),
    targetKind: r.targetKind as 'PRODUCAO' | 'LOGISTICA',
    target,
    beneficiary: { userId: r.beneficiary.id, displayName: r.beneficiary.displayName },
    weekStart: when ? closingWeekStart(localDateOf(when, tz)) : null,
    currentNowCents: dueNow(r),
    diffCents: r.requestedCents - r.currentCents,
    staleReason: stale,
    appliedAs: (r.appliedAs as ValueChangeRequestDto['appliedAs']) ?? null,
    decidedBy: r.decidedBy?.displayName ?? null,
    version: r.version,
  };
}

export const createRequestSchema = z.object({
  targetKind: z.enum(['PRODUCAO', 'LOGISTICA']),
  targetId: z.string().uuid(),
  requestedCents: z.number().int().positive().max(100_000_000),
  reason: z.string().trim().min(5, 'Explique o motivo do pedido.').max(500),
});
const approveSchema = z.object({
  version: z.number().int().positive(),
  note: z.string().trim().max(500).optional().nullable(),
});
const rejectSchema = z.object({
  version: z.number().int().positive(),
  note: z.string().trim().min(3, 'Informe o motivo da recusa.').max(500),
});

/** O próprio beneficiário pede a alteração de um valor seu (tablet, D12). */
export async function createRequest(
  tx: Tx,
  actor: ActorContext,
  userId: string,
  deviceId: string | null,
  input: z.output<typeof createRequestSchema>,
) {
  let currentCents: number;
  if (input.targetKind === 'PRODUCAO') {
    await lockRow(tx, 'production_payables', input.targetId, 'Valor');
    const p = await tx.productionPayable.findUnique({
      where: { id: input.targetId },
      include: { item: { select: { upholstererUserId: true } } },
    });
    // Mesmo erro para "não existe" e "não é seu" (não revela valores de outra pessoa).
    if (!p || p.professionalUserId !== userId) throw Errors.notFound('Valor');
    if (p.status === 'CANCELADO') throw Errors.business('Este valor foi cancelado.');
    if (p.status === 'PAGO') throw Errors.business('Este valor já foi quitado: fale com o gestor.');
    if (p.item?.upholstererUserId && p.item.upholstererUserId !== userId)
      throw Errors.business('A peça tem outro titular: o valor está em revisão pelo gestor.');
    const review = await openReviewOf(tx, p);
    if (review)
      throw Errors.business(
        `Este valor está em revisão financeira (${laborReviewCode(review.number)}): aguarde a decisão do gestor.`,
      );
    currentCents = laborDue(p);
  } else {
    await lockRow(tx, 'logistics_costs', input.targetId, 'Valor');
    const c = await tx.logisticsCost.findUnique({ where: { id: input.targetId } });
    if (!c || c.payeeUserId !== userId) throw Errors.notFound('Valor');
    if (c.cancelledAt || c.status === 'CANCELADO')
      throw Errors.business('Esta viagem foi cancelada.');
    if (c.status !== 'DEVIDO')
      throw Errors.business('A viagem ainda não foi realizada: o pedido vale para valor devido.');
    currentCents = c.amountCents + c.adjustmentsCents;
  }
  if (input.requestedCents === currentCents)
    throw Errors.business('O valor pedido é igual ao valor atual.');
  const targetWhere =
    input.targetKind === 'PRODUCAO'
      ? { productionPayableId: input.targetId }
      : { logisticsCostId: input.targetId };
  await markStaleRequests(tx, actor, targetWhere);
  const open = await tx.valueChangeRequest.findFirst({
    where: { ...targetWhere, status: 'PENDENTE' },
  });
  if (open) {
    // Repetição do mesmo pedido: devolve o existente (sem duplicar).
    if (open.requestedCents === input.requestedCents && open.reason === input.reason) return open;
    throw Errors.conflict(
      `Já existe um pedido pendente para este item (${valueChangeCode(open.number)}).`,
    );
  }
  const r = await tx.valueChangeRequest.create({
    data: {
      targetKind: input.targetKind,
      ...targetWhere,
      beneficiaryUserId: userId,
      currentCents,
      requestedCents: input.requestedCents,
      reason: input.reason,
      sessionId: actor.sessionId,
      deviceId,
    },
  });
  const code = valueChangeCode(r.number);
  await audit(tx, actor, {
    action: 'finance.value_request_created',
    entityType: 'value_change_request',
    entityId: r.id,
    summary: `${code}: pedido de alteração de valor (${input.targetKind === 'PRODUCAO' ? 'mão de obra' : 'viagem'}).`,
  });
  await financeEvent(tx, actor, {
    entityType: input.targetKind === 'PRODUCAO' ? 'production_payable' : 'logistics_cost',
    entityId: input.targetId,
    kind: 'PEDIDO_ALTERACAO',
    note: `${code}: ${input.reason}`,
    data: { requestId: r.id, currentCents, requestedCents: input.requestedCents },
  });
  await notifyUsersWith(
    tx,
    actor,
    'financeiro.ajustes',
    'VALOR_SOLICITADO',
    `VALOR:${r.id}`,
    `${code}: um profissional pediu alteração de valor. Analise em Financeiro → Fechamento semanal.`,
  );
  return r;
}

async function lockRequest(tx: Tx, id: string) {
  await lockRow(tx, 'value_change_requests', id, 'Pedido de alteração');
  return tx.valueChangeRequest.findUniqueOrThrow({ where: { id }, include: targetInclude });
}

/**
 * Aprovação: aplica pela função financeira canônica, na mesma transação. Se o alvo mudou, o
 * pedido vira OBSOLETO (gravado) e nada é aplicado — o chamador recebe o resultado.
 */
export async function approveRequest(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: z.output<typeof approveSchema>,
): Promise<{ obsolete: string | null }> {
  const r0 = await lockRequest(tx, id);
  if (r0.status !== 'PENDENTE') throw Errors.business('Este pedido já foi decidido.');
  checkVersion(r0, input.version);
  if (r0.productionPayableId)
    await lockRow(tx, 'production_payables', r0.productionPayableId, 'Mão de obra');
  else await lockRow(tx, 'logistics_costs', r0.logisticsCostId!, 'Custo de logística');
  const r = await tx.valueChangeRequest.findUniqueOrThrow({
    where: { id },
    include: targetInclude,
  });
  const why = await staleReason(tx, r);
  if (why) {
    await obsolete(tx, actor, r, why);
    return { obsolete: why };
  }
  const code = valueChangeCode(r.number);
  const delta = r.requestedCents - r.currentCents;
  const reason = `Pedido ${code} aprovado${input.note ? `: ${input.note}` : ''}`.slice(0, 500);
  let appliedAs: 'VALOR_COMBINADO' | 'AJUSTE';
  if (r.payable) {
    const p = r.payable;
    if (!p.eligibleAt && p.paidCents === 0) {
      appliedAs = 'VALOR_COMBINADO';
      await editLaborAgreed(tx, actor, p.id, {
        agreedCents: p.agreedCents + delta,
        reason,
        version: p.version,
      });
    } else {
      appliedAs = 'AJUSTE';
      await adjustLabor(tx, actor, p.id, { amountCents: delta, reason, version: p.version });
    }
  } else {
    appliedAs = 'AJUSTE';
    await adjustTripCost(tx, actor, r.cost!.id, {
      amountCents: delta,
      reason,
      version: r.cost!.version,
    });
  }
  await tx.valueChangeRequest.update({
    where: { id },
    data: {
      status: 'APROVADA',
      appliedAs,
      decisionNote: input.note ?? null,
      decidedById: actor.userId,
      decidedAt: new Date(),
      version: { increment: 1 },
    },
  });
  await audit(tx, actor, {
    action: 'finance.value_request_approved',
    entityType: 'value_change_request',
    entityId: id,
    summary: `${code} aprovado (${appliedAs === 'AJUSTE' ? 'ajuste' : 'valor combinado'} de ${(delta / 100).toFixed(2)}).`,
  });
  await financeEvent(tx, actor, {
    entityType: 'value_change_request',
    entityId: id,
    kind: 'APROVADA',
    note: input.note ?? null,
    data: { appliedAs, deltaCents: delta },
  });
  // F10-19: o aviso "pedido de alteração de valor" do gestor deixa de pedir ação.
  await resolveNotifications(tx, actor, 'VALOR_SOLICITADO', [`VALOR:${id}`]);
  await notify(tx, actor, [
    {
      userId: r.beneficiaryUserId,
      kind: 'VALOR_DECIDIDO',
      dedupeKey: `VALOR:${id}:APROVADA`,
      body: `Seu pedido ${code} foi aprovado. Confira em Meus ganhos.`,
      includeActor: true,
    },
  ]);
  return { obsolete: null };
}

export async function rejectRequest(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: z.output<typeof rejectSchema>,
) {
  const r = await lockRequest(tx, id);
  if (r.status !== 'PENDENTE') throw Errors.business('Este pedido já foi decidido.');
  checkVersion(r, input.version);
  await tx.valueChangeRequest.update({
    where: { id },
    data: {
      status: 'RECUSADA',
      decisionNote: input.note,
      decidedById: actor.userId,
      decidedAt: new Date(),
      version: { increment: 1 },
    },
  });
  const code = valueChangeCode(r.number);
  await audit(tx, actor, {
    action: 'finance.value_request_rejected',
    entityType: 'value_change_request',
    entityId: id,
    summary: `${code} recusado: ${input.note}`,
  });
  await financeEvent(tx, actor, {
    entityType: 'value_change_request',
    entityId: id,
    kind: 'RECUSADA',
    note: input.note,
  });
  await resolveNotifications(tx, actor, 'VALOR_SOLICITADO', [`VALOR:${id}`]);
  await notify(tx, actor, [
    {
      userId: r.beneficiaryUserId,
      kind: 'VALOR_DECIDIDO',
      dedupeKey: `VALOR:${id}:RECUSADA`,
      body: `Seu pedido ${code} foi recusado. Veja o motivo em Meus ganhos.`,
      includeActor: true,
    },
  ]);
}

export async function valueRequestRoutes(app: FastifyInstance) {
  const { prisma, hashToken } = app.ctx;
  const tx = <T>(fn: (t: Tx) => Promise<T>) => prisma.$transaction(fn, { timeout: 30_000 });
  const load = async (id: string) =>
    managerDto(
      prisma,
      await prisma.valueChangeRequest.findUniqueOrThrow({ where: { id }, include: targetInclude }),
      await shopTimezone(prisma),
    );

  /** Tablet (D12): pedir alteração de um valor próprio. */
  app.post(
    '/api/v1/finance/my-earnings/requests',
    { config: { access: OWN_EARNINGS, idempotent: true } },
    async (request, reply) => {
      const auth = request.auth!;
      if (!unlockValid(hashToken, auth, request.headers[UNLOCK_HEADER]))
        throw Errors.forbidden('Confirme seu PIN para ver seus ganhos.');
      const input = createRequestSchema.parse(request.body);
      const r = await tx((t) =>
        createRequest(t, actorFrom(request), auth.userId, auth.deviceId, input),
      );
      void reply.header('cache-control', 'no-store');
      return reply.status(201).send(ownDto(r, null));
    },
  );

  app.get('/api/v1/finance/value-requests', { config: { access: FIN_VIEW } }, async (request) => {
    const q = z
      .object({ status: z.enum(['PENDENTE', 'APROVADA', 'RECUSADA', 'OBSOLETA']).optional() })
      .parse(request.query);
    const rows = await prisma.valueChangeRequest.findMany({
      where: q.status ? { status: q.status } : {},
      include: targetInclude,
      orderBy: { number: 'desc' },
      take: 200,
    });
    const tz = await shopTimezone(prisma);
    return Promise.all(rows.map((r) => managerDto(prisma, r, tz)));
  });

  app.post(
    '/api/v1/finance/value-requests/:id/approve',
    { config: { access: FIN_ADJUST, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = approveSchema.parse(request.body);
      const res = await tx((t) => approveRequest(t, actorFrom(request), id, input));
      if (res.obsolete)
        throw Errors.business(`Pedido obsoleto: ${res.obsolete} Nada foi aplicado.`);
      return load(id);
    },
  );

  app.post(
    '/api/v1/finance/value-requests/:id/reject',
    { config: { access: FIN_ADJUST, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = rejectSchema.parse(request.body);
      await tx((t) => rejectRequest(t, actorFrom(request), id, input));
      return load(id);
    },
  );
}
