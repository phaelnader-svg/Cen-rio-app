/**
 * Evolução, Fase 7 — fechamento semanal geral (tapeceiros + logística).
 *
 * O fechamento é uma VISÃO sobre as fontes de verdade — nada é consolidado nem duplicado:
 * - Tapeçaria: `production_payables` (obrigação por peça e profissional; inclusive as duas
 *   obrigações de uma revisão resolvida) + `professional_payments` (+ estornos).
 * - Logística: `logistics_costs` DEVIDO + `account_payables` + `payable_payments` (+ estornos).
 * Conferência = retrato versionado (`weekly_closings`); Pix em lote = baixas nas obrigações
 * originais (`closing_payments` só agrupa e rastreia). Regras de competência: closing-domain.ts.
 */
import {
  EVENT_TYPES,
  allocateClosingPayment,
  closingFigures,
  closingPaymentSchema,
  closingQuerySchema,
  closingWeekEnd,
  confirmClosingSchema,
  deliveryCode,
  formatNumber,
  formatServiceOrderItemCode,
  freeTripSchema,
  laborDue,
  laborSituation,
  logisticsCostCode,
  productionPayableCode,
  reopenClosingSchema,
  reverseClosingPaymentSchema,
  reverseLaborPaymentSchema,
  toCsv,
  weekStartParamsSchema,
  zonedDateTime,
  type ClosingItemDto,
  type ClosingPendencyDto,
  type ClosingRowDto,
  type EligibilityRule,
  type LaborStatus,
  type PaymentMethod,
  type WeeklyClosingDto,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { pickupCode, serviceOrderCode } from '../commercial/common';
import { idParams } from '../presenters';
import {
  FIN_ADJUST,
  FIN_MANAGE,
  FIN_VIEW,
  FINANCE_AUDIENCE,
  dateOnly,
  lockRow,
  todayIso,
} from './common';
import { laborInclude, openReviewIndex, payLabor, reverseLaborPayment } from './labor';
import { payPayable } from './payables';
import { reversePayablePayment, tripCostInclude } from './trip-costs';

type Db = Tx | PrismaClient;
export const closingPaymentCode = (n: number) => formatNumber('PF', n);

const plusDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function tzOf(db: Db) {
  return (
    (await db.companySettings.findUnique({ where: { id: 1 } }))?.timezone ?? 'America/Sao_Paulo'
  );
}

type Built = {
  weekStart: string;
  weekEnd: string;
  timezone: string;
  items: ClosingItemDto[];
  pendencies: ClosingPendencyDto[];
};

/** Monta todos os itens do fechamento (sem filtros) a partir das fontes de verdade. */
export async function buildClosingItems(db: Db, weekStart: string): Promise<Built> {
  const tz = await tzOf(db);
  const weekEnd = closingWeekEnd(weekStart);
  const startAt = zonedDateTime(weekStart, '00:00', tz);
  const endAt = zonedDateTime(plusDays(weekEnd, 1), '00:00', tz);
  const local = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  const startDate = new Date(`${weekStart}T00:00:00Z`);
  const items: ClosingItemDto[] = [];
  const pendencies: ClosingPendencyDto[] = [];

  // ── Tapeçaria ──
  const labor = await db.productionPayable.findMany({
    where: {
      status: { not: 'CANCELADO' },
      OR: [
        { eligibleAt: null },
        {
          eligibleAt: { lt: endAt },
          OR: [
            { status: { not: 'PAGO' } },
            { eligibleAt: { gte: startAt } },
            { payments: { some: { paidAt: { gte: startDate } } } },
          ],
        },
      ],
    },
    include: laborInclude,
    orderBy: { number: 'asc' },
  });
  const reviews = await openReviewIndex(db, labor);
  for (const p of labor) {
    const review = reviews.get(`${p.serviceOrderId}|${p.serviceOrderItemId ?? ''}`) ?? null;
    const due = laborDue(p);
    const payments = p.payments.map((x) => ({
      id: x.id,
      amountCents: x.amountCents,
      paidAt: dateOnly(x.paidAt)!,
      reversed: Boolean(x.reversal),
    }));
    const paidValid = payments.filter((x) => !x.reversed).reduce((a, x) => a + x.amountCents, 0);
    const stages = p.item
      ? [p.item.fulfillmentStage]
      : p.serviceOrder.items.map((i) => i.fulfillmentStage);
    const situation = laborSituation({
      status: p.status as LaborStatus,
      inReview: Boolean(review),
      eligibility: p.eligibility as EligibilityRule,
      stages,
    });
    const competence = p.eligibleAt ? local(p.eligibleAt) : null;
    const state: ClosingItemDto['state'] = review
      ? 'EM_REVISAO'
      : competence
        ? 'DEVIDO'
        : situation === 'AGUARDANDO_QUALIDADE'
          ? 'AGUARDANDO_QUALIDADE'
          : 'PREVISTO';
    const base = {
      kind: 'MAO_DE_OBRA' as const,
      id: p.id,
      code: productionPayableCode(p.number),
      category: 'TAPECARIA' as const,
      beneficiary: { userId: p.professional.id, displayName: p.professional.displayName },
      state,
      description: p.service,
      serviceOrders: [
        { id: p.serviceOrder.id, code: serviceOrderCode(p.serviceOrder.number), amountCents: null },
      ],
      piece: p.item
        ? {
            id: p.item.id,
            code: formatServiceOrderItemCode(p.serviceOrder.number, p.item.position),
          }
        : null,
      competence,
      agreedCents: p.agreedCents,
      adjustmentsCents: p.adjustmentsCents,
      totalDueCents: due,
      payments,
      notes: [] as string[],
    };
    if (review) base.notes.push(`Revisão financeira aberta: liberação e pagamento travados.`);
    if (p.item?.fulfillmentStage === 'DEVOLVIDA' || p.serviceOrder.status === 'CANCELADA') {
      base.notes.push('Peça devolvida/OS cancelada com valor ativo: revisar.');
      pendencies.push({
        kind: 'PECA_DEVOLVIDA',
        blocking: false,
        message: `${base.code}: peça devolvida ou OS cancelada com valor ativo — revise (ajuste/cancelamento).`,
        ref: { kind: 'production_payable', id: p.id, code: base.code },
      });
    }
    if (state === 'DEVIDO' && competence) {
      const f = closingFigures({ dueCents: due, competence, payments }, weekStart, weekEnd);
      if (!f.bucket) continue;
      items.push({ ...base, ...f, bucket: f.bucket, payable: f.currentOpenCents > 0 });
    } else {
      const open = Math.max(0, due - paidValid);
      items.push({
        ...base,
        bucket: 'FORECAST',
        dueCents: 0,
        paidInWeekCents: 0,
        openAtEndCents: 0,
        paidAfterCents: 0,
        currentOpenCents: open,
        payable: false,
      });
    }
  }

  // ── Logística ──
  const settings = await db.companySettings.findUnique({
    where: { id: 1 },
    include: { logisticsPayee: { include: { employee: { select: { active: true } } } } },
  });
  const configured = settings?.logisticsPayee
    ? { userId: settings.logisticsPayee.id, displayName: settings.logisticsPayee.displayName }
    : { userId: null, displayName: 'Recebedor não configurado' };
  const costs = await db.logisticsCost.findMany({
    where: {
      cancelledAt: null,
      OR: [
        { status: 'PREVISTO' },
        { status: 'DEVIDO', payableId: null },
        {
          status: 'DEVIDO',
          dueAt: { lt: endAt },
          OR: [
            { payable: { status: { not: 'PAGO' } } },
            { dueAt: { gte: startAt } },
            { payable: { payments: { some: { paidAt: { gte: startDate } } } } },
          ],
        },
        {
          status: 'LANCADO',
          payableId: { not: null },
          date: { lte: new Date(`${weekEnd}T00:00:00Z`) },
          OR: [
            { payable: { status: { notIn: ['PAGO', 'CANCELADO'] } } },
            { date: { gte: startDate } },
            { payable: { payments: { some: { paidAt: { gte: startDate } } } } },
          ],
        },
      ],
    },
    include: {
      ...tripCostInclude,
      payable: { include: { payments: { include: { reversal: true } } } },
    },
    orderBy: { number: 'asc' },
  });
  for (const c of costs) {
    if (c.status === 'LANCADO' && c.payable?.status === 'CANCELADO') continue;
    const allocations = c.allocations
      .filter((a) => a.revision === c.allocationRevision)
      .map((a) => ({
        id: a.serviceOrderId,
        code: serviceOrderCode(a.serviceOrder.number),
        amountCents: a.amountCents,
      }));
    const trip = c.pickup
      ? `Retirada ${pickupCode(c.pickup.number)}`
      : c.delivery
        ? `Entrega ${deliveryCode(c.delivery.number)}`
        : c.description;
    const code = logisticsCostCode(c.number);
    const payments = (c.payable?.payments ?? []).map((x) => ({
      id: x.id,
      amountCents: x.amountCents,
      paidAt: dateOnly(x.paidAt)!,
      reversed: Boolean(x.reversal),
    }));
    const notes: string[] = [];
    if (c.kind === 'TENTATIVA_FRUSTRADA') notes.push('Taxa de tentativa frustrada autorizada.');
    if (c.participants.length)
      notes.push(`Participantes: ${c.participants.map((p) => p.user.displayName).join(', ')}.`);
    const baseDue = c.amountCents + c.adjustmentsCents;
    const common = {
      kind: 'LOGISTICA' as const,
      id: c.id,
      code,
      category: 'LOGISTICA' as const,
      description: `${trip} — ${c.description}`,
      serviceOrders: allocations,
      piece: null,
      agreedCents: c.amountCents,
      adjustmentsCents: c.adjustmentsCents,
      payments,
      notes,
    };
    if (c.status === 'PREVISTO') {
      items.push({
        ...common,
        beneficiary: configured,
        state: 'PREVISTO',
        bucket: 'FORECAST',
        competence: null,
        totalDueCents: baseDue,
        dueCents: 0,
        paidInWeekCents: 0,
        openAtEndCents: 0,
        paidAfterCents: 0,
        currentOpenCents: baseDue,
        payable: false,
      });
      continue;
    }
    if (c.status === 'DEVIDO' && !c.payable) {
      const competence = local(c.dueAt!);
      if (competence > weekEnd) continue;
      items.push({
        ...common,
        beneficiary: configured,
        state: 'PENDENTE_CONFIGURACAO',
        bucket: 'FORECAST',
        competence,
        totalDueCents: baseDue,
        dueCents: 0,
        paidInWeekCents: 0,
        openAtEndCents: 0,
        paidAfterCents: 0,
        currentOpenCents: baseDue,
        payable: false,
        notes: [...notes, 'Realizada sem recebedor ativo: nenhuma conta a pagar criada.'],
      });
      pendencies.push({
        kind: 'SEM_RECEBEDOR',
        blocking: true,
        message: `${code}: valor devido sem recebedor ativo — configure o recebedor e gere a conta.`,
        ref: { kind: 'logistics_cost', id: c.id, code },
      });
      continue;
    }
    const payable = c.payable!;
    const legacy = c.status === 'LANCADO';
    const competence = legacy ? dateOnly(c.date)! : local(c.dueAt!);
    if (!legacy && payable.amountCents !== baseDue)
      pendencies.push({
        kind: 'DIVERGENCIA_CONTA',
        blocking: true,
        message: `${code}: conta a pagar (${(payable.amountCents / 100).toFixed(2)}) difere do custo devido (${(baseDue / 100).toFixed(2)}).`,
        ref: { kind: 'logistics_cost', id: c.id, code },
      });
    const f = closingFigures(
      { dueCents: payable.amountCents, competence, payments },
      weekStart,
      weekEnd,
    );
    if (!f.bucket) continue;
    items.push({
      ...common,
      beneficiary: legacy
        ? { userId: null, displayName: `${payable.beneficiary} (lançamento avulso)` }
        : c.payee
          ? { userId: c.payee.id, displayName: c.payee.displayName }
          : { userId: null, displayName: payable.beneficiary },
      state: 'DEVIDO',
      competence,
      totalDueCents: payable.amountCents,
      ...f,
      bucket: f.bucket,
      payable: !legacy && f.currentOpenCents > 0,
      notes: legacy ? [...notes, 'Custo avulso (Fase 11): pague pela conta a pagar.'] : notes,
    });
  }

  // ── Viagens realizadas na semana sem custo (≠ gratuita confirmada) ──
  const free = await db.logisticsFreeTrip.findMany({
    select: { pickupId: true, deliveryId: true },
  });
  const freePickups = new Set(free.map((f) => f.pickupId).filter(Boolean));
  const freeDeliveries = new Set(free.map((f) => f.deliveryId).filter(Boolean));
  const deliveries = await db.delivery.findMany({
    where: {
      status: 'CONCLUIDA',
      completedAt: { gte: startAt, lt: endAt },
      logisticsCosts: { none: { kind: 'ENTREGA', cancelledAt: null } },
    },
    select: { id: true, number: true },
  });
  for (const d of deliveries.filter((x) => !freeDeliveries.has(x.id)))
    pendencies.push({
      kind: 'CUSTO_NAO_INFORMADO',
      blocking: true,
      message: `Entrega ${deliveryCode(d.number)} realizada sem custo informado — combine o custo ou confirme como gratuita.`,
      ref: { kind: 'delivery', id: d.id, code: deliveryCode(d.number) },
    });
  const realizedPickups = await db.pickupEvent.findMany({
    where: {
      toStatus: { in: ['RETIRADA_REALIZADA', 'RECEBIDA_NA_OFICINA'] },
      occurredAt: { gte: startAt, lt: endAt },
      pickup: { logisticsCosts: { none: { kind: 'RETIRADA', cancelledAt: null } } },
    },
    select: { pickup: { select: { id: true, number: true } } },
  });
  const seen = new Set<string>();
  for (const e of realizedPickups) {
    if (seen.has(e.pickup.id) || freePickups.has(e.pickup.id)) continue;
    seen.add(e.pickup.id);
    pendencies.push({
      kind: 'CUSTO_NAO_INFORMADO',
      blocking: true,
      message: `Retirada ${pickupCode(e.pickup.number)} realizada sem custo informado — combine o custo ou confirme como gratuita.`,
      ref: { kind: 'pickup', id: e.pickup.id, code: pickupCode(e.pickup.number) },
    });
  }

  // ── Revisões financeiras abertas (ação administrativa explícita) ──
  const open = await db.laborReview.findMany({
    where: { status: 'ABERTA' },
    select: { id: true, number: true, serviceOrder: { select: { number: true } } },
  });
  for (const r of open) {
    const code = `RF-${String(r.number).padStart(5, '0')}`;
    pendencies.push({
      kind: 'REVISAO_ABERTA',
      blocking: true,
      message: `${code} (${serviceOrderCode(r.serviceOrder.number)}): revisão financeira aberta — resolva antes de conferir.`,
      ref: { kind: 'labor_review', id: r.id, code },
    });
  }
  return { weekStart, weekEnd, timezone: tz, items, pendencies };
}

const emptyTotals = () => ({
  items: 0,
  forecastCents: 0,
  awaitingCents: 0,
  weekDueCents: 0,
  previousOpenCents: 0,
  dueCents: 0,
  paidInWeekCents: 0,
  openAtEndCents: 0,
  paidAfterCents: 0,
  currentOpenCents: 0,
  adjustmentsCents: 0,
});

function addItem(t: ReturnType<typeof emptyTotals>, i: ClosingItemDto) {
  t.items += 1;
  if (i.state === 'PREVISTO') t.forecastCents += i.currentOpenCents;
  else if (i.bucket === 'FORECAST') t.awaitingCents += i.currentOpenCents;
  if (i.bucket === 'WEEK') t.weekDueCents += i.dueCents;
  if (i.bucket === 'PREVIOUS') t.previousOpenCents += i.dueCents;
  if (i.bucket === 'WEEK' || i.bucket === 'PREVIOUS') {
    t.dueCents += i.dueCents;
    t.paidInWeekCents += i.paidInWeekCents;
    t.openAtEndCents += i.openAtEndCents;
    t.paidAfterCents += i.paidAfterCents;
    t.currentOpenCents += i.currentOpenCents;
    t.adjustmentsCents += i.adjustmentsCents;
  }
}

/** Linhas por recebedor e categoria; total geral = soma das linhas (sem previsão no pagável). */
export async function summarize(db: Db, items: ClosingItemDto[]) {
  const groups = new Map<string, ClosingItemDto[]>();
  for (const i of items) {
    const k = `${i.beneficiary.userId ?? i.beneficiary.displayName}|${i.category}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const users = new Map(
    (
      await db.user.findMany({
        where: {
          id: { in: items.map((i) => i.beneficiary.userId).filter((x): x is string => !!x) },
        },
        select: { id: true, active: true },
      })
    ).map((u) => [u.id, u.active]),
  );
  const rows: ClosingRowDto[] = [...groups.values()].map((list) => {
    const t = emptyTotals();
    for (const i of list) addItem(t, i);
    const b = list[0]!.beneficiary;
    return {
      beneficiary: b,
      category: list[0]!.category,
      ...t,
      canPay: Boolean(b.userId && users.get(b.userId) && list.some((i) => i.payable)),
    };
  });
  rows.sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      a.beneficiary.displayName.localeCompare(b.beneficiary.displayName),
  );
  const totals = emptyTotals();
  for (const r of rows)
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r[k];
  return { rows, totals };
}

const snapshotOf = (items: ClosingItemDto[]) =>
  items
    .filter((i) => i.bucket === 'WEEK' || i.bucket === 'PREVIOUS')
    .map((i) => ({
      id: i.id,
      code: i.code,
      bucket: i.bucket,
      dueCents: i.dueCents,
      totalDueCents: i.totalDueCents,
    }))
    .sort((a, b) => a.code.localeCompare(b.code));

export async function weeklyClosing(
  db: Db,
  weekStart: string,
  filters: z.output<typeof closingQuerySchema> = { format: 'json' },
): Promise<WeeklyClosingDto> {
  const built = await buildClosingItems(db, weekStart);
  const row = await db.weeklyClosing.findUnique({
    where: { weekStart: new Date(`${weekStart}T00:00:00Z`) },
    include: { checkedBy: { select: { displayName: true } } },
  });
  // Divergência: o devido conferido (por item) mudou depois da conferência.
  const divergences: string[] = [];
  if (row?.status === 'CONFERIDO') {
    const before = row.snapshot as unknown as ReturnType<typeof snapshotOf>;
    const now = snapshotOf(built.items);
    const map = new Map(before.map((x) => [x.id, x]));
    for (const n of now) {
      const b = map.get(n.id);
      if (!b) divergences.push(`${n.code}: item novo depois da conferência.`);
      else if (b.totalDueCents !== n.totalDueCents)
        divergences.push(
          `${n.code}: devido mudou de ${(b.totalDueCents / 100).toFixed(2)} para ${(n.totalDueCents / 100).toFixed(2)}.`,
        );
      map.delete(n.id);
    }
    for (const b of map.values())
      if (b.dueCents > 0) divergences.push(`${b.code}: saiu do fechamento depois da conferência.`);
  }
  const items = built.items.filter(
    (i) =>
      (!filters.beneficiaryUserId || i.beneficiary.userId === filters.beneficiaryUserId) &&
      (!filters.category || i.category === filters.category) &&
      (!filters.state || i.state === filters.state),
  );
  const { rows, totals } = await summarize(db, items);
  const payments = await db.closingPayment.findMany({
    where: { weekStart: new Date(`${weekStart}T00:00:00Z`) },
    include: {
      beneficiary: { select: { displayName: true } },
      reversal: true,
      parts: {
        include: {
          professionalPayment: { select: { payable: { select: { number: true } } } },
          payablePayment: {
            select: { payable: { select: { logisticsCost: { select: { number: true } } } } },
          },
        },
      },
    },
    orderBy: { number: 'asc' },
  });
  const events = await db.weeklyClosingEvent.findMany({
    where: { weekStart: new Date(`${weekStart}T00:00:00Z`) },
    orderBy: { createdAt: 'asc' },
  });
  const actors = new Map(
    (
      await db.user.findMany({
        where: { id: { in: events.map((e) => e.actorId).filter((x): x is string => !!x) } },
        select: { id: true, displayName: true },
      })
    ).map((u) => [u.id, u.displayName]),
  );
  return {
    weekStart,
    weekEnd: built.weekEnd,
    timezone: built.timezone,
    status: (row?.status as WeeklyClosingDto['status']) ?? 'ABERTO',
    version: row?.version ?? 0,
    checkedBy: row?.checkedBy?.displayName ?? null,
    checkedAt: row?.checkedAt?.toISOString() ?? null,
    note: row?.note ?? null,
    reopenReason: row?.reopenReason ?? null,
    divergent: divergences.length > 0,
    divergences,
    rows,
    totals,
    items,
    pendencies: built.pendencies,
    payments: payments.map((p) => ({
      id: p.id,
      code: closingPaymentCode(p.number),
      beneficiary: p.beneficiary.displayName,
      category: p.category as 'TAPECARIA' | 'LOGISTICA',
      amountCents: p.amountCents,
      paidAt: dateOnly(p.paidAt)!,
      method: p.method as PaymentMethod,
      reference: p.reference,
      reversed: Boolean(p.reversal),
      parts: p.parts.map((x) => ({
        code: x.professionalPayment
          ? productionPayableCode(x.professionalPayment.payable.number)
          : x.payablePayment?.payable.logisticsCost
            ? logisticsCostCode(x.payablePayment.payable.logisticsCost.number)
            : '—',
        amountCents: x.amountCents,
      })),
    })),
    history: events.map((e) => ({
      kind: e.kind,
      note: e.note,
      actor: e.actorId ? (actors.get(e.actorId) ?? null) : null,
      createdAt: e.createdAt.toISOString(),
      data: e.data,
    })),
  };
}

async function closingEvent(
  tx: Tx,
  actor: ActorContext,
  weekStart: string,
  kind: string,
  note: string | null,
  data?: unknown,
) {
  await tx.weeklyClosingEvent.create({
    data: {
      weekStart: new Date(`${weekStart}T00:00:00Z`),
      kind,
      note,
      data: (data as Prisma.InputJsonValue | undefined) ?? undefined,
      actorId: actor.userId,
    },
  });
  // Tempo real só para o financeiro; sem valores no payload.
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.FINANCE_COST_UPDATED,
    aggregateType: 'weekly_closing',
    aggregateId: '00000000-0000-0000-0000-000000000000',
    payload: { weekStart, kind },
    audience: FINANCE_AUDIENCE,
  });
}

/** Conferência: retrato versionado; recusada com pendência bloqueante não resolvida. */
export async function confirmClosing(
  tx: Tx,
  actor: ActorContext,
  weekStart: string,
  input: z.output<typeof confirmClosingSchema>,
) {
  // Uma conferência por vez por semana (bloqueio consultivo pela semana).
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `closing:${weekStart}`);
  const row = await tx.weeklyClosing.findUnique({
    where: { weekStart: new Date(`${weekStart}T00:00:00Z`) },
  });
  if ((row?.version ?? 0) !== input.version) throw Errors.versionConflict(row?.version ?? 0);
  if (row?.status === 'CONFERIDO')
    throw Errors.business('Semana já conferida: reabra (com motivo) para conferir de novo.');
  const built = await buildClosingItems(tx, weekStart);
  const blocking = built.pendencies.filter((p) => p.blocking);
  if (blocking.length)
    throw Errors.business(
      `Há ${blocking.length} pendência(s) que precisam de resolução explícita: ${blocking
        .slice(0, 5)
        .map((p) => p.message)
        .join(' | ')}`,
    );
  const { totals } = await summarize(tx, built.items);
  const snapshot = snapshotOf(built.items);
  const data = {
    status: 'CONFERIDO',
    note: input.note ?? null,
    reopenReason: null,
    snapshot: snapshot as unknown as Prisma.InputJsonValue,
    dueCents: totals.dueCents,
    paidCents: totals.paidInWeekCents,
    openCents: totals.openAtEndCents,
    checkedById: actor.userId,
    checkedAt: new Date(),
  };
  if (row)
    await tx.weeklyClosing.update({
      where: { id: row.id },
      data: { ...data, version: { increment: 1 } },
    });
  else
    await tx.weeklyClosing.create({
      data: { ...data, weekStart: new Date(`${weekStart}T00:00:00Z`), version: 1 },
    });
  await closingEvent(tx, actor, weekStart, 'CONFERIDO', input.note ?? null, {
    dueCents: totals.dueCents,
    paidInWeekCents: totals.paidInWeekCents,
    openAtEndCents: totals.openAtEndCents,
    items: snapshot.length,
  });
  await audit(tx, actor, {
    action: 'finance.weekly_closing_confirmed',
    entityType: 'weekly_closing',
    entityId: row?.id ?? '00000000-0000-0000-0000-000000000000',
    summary: `Fechamento da semana ${weekStart} conferido (devido ${(totals.dueCents / 100).toFixed(2)}).`,
  });
}

export async function reopenClosing(
  tx: Tx,
  actor: ActorContext,
  weekStart: string,
  input: z.output<typeof reopenClosingSchema>,
) {
  await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `closing:${weekStart}`);
  const row = await tx.weeklyClosing.findUnique({
    where: { weekStart: new Date(`${weekStart}T00:00:00Z`) },
  });
  if (!row) throw Errors.business('Semana ainda não conferida.');
  if (row.version !== input.version) throw Errors.versionConflict(row.version);
  if (row.status !== 'CONFERIDO') throw Errors.business('Semana já reaberta.');
  await tx.weeklyClosing.update({
    where: { id: row.id },
    data: { status: 'REABERTO', reopenReason: input.reason, version: { increment: 1 } },
  });
  await closingEvent(tx, actor, weekStart, 'REABERTO', input.reason);
  await audit(tx, actor, {
    action: 'finance.weekly_closing_reopened',
    entityType: 'weekly_closing',
    entityId: row.id,
    summary: `Fechamento da semana ${weekStart} reaberto: ${input.reason}`,
  });
}

/**
 * Pix/transferência feito FORA do sistema: distribui o valor pelas obrigações em aberto do
 * recebedor neste fechamento (mais antigas primeiro) e registra a baixa em cada obrigação
 * original. Nunca cria conta a pagar nem despesa; nunca passa do saldo.
 */
export async function registerClosingPayment(
  tx: Tx,
  actor: ActorContext,
  weekStart: string,
  input: z.output<typeof closingPaymentSchema>,
) {
  if (input.paidAt > todayIso()) throw Errors.business('A data do pagamento não pode ser futura.');
  const user = await tx.user.findUnique({ where: { id: input.beneficiaryUserId } });
  if (!user?.active) throw Errors.business('Recebedor inválido ou inativo.');
  // Trava as obrigações candidatas (ordem fixa) e recalcula com os valores travados.
  const pre = (await buildClosingItems(tx, weekStart)).items.filter(
    (i) => i.beneficiary.userId === user.id && i.category === input.category && i.payable,
  );
  const laborIds = pre
    .filter((i) => i.kind === 'MAO_DE_OBRA')
    .map((i) => i.id)
    .sort();
  const costIds = pre.filter((i) => i.kind === 'LOGISTICA').map((i) => i.id);
  const payableIds = (
    await tx.logisticsCost.findMany({ where: { id: { in: costIds } }, select: { payableId: true } })
  )
    .map((c) => c.payableId!)
    .sort();
  for (const id of laborIds) await lockRow(tx, 'production_payables', id, 'Mão de obra');
  for (const id of payableIds) await lockRow(tx, 'account_payables', id, 'Conta a pagar');
  const candidates = (await buildClosingItems(tx, weekStart)).items.filter(
    (i) => i.beneficiary.userId === user.id && i.category === input.category && i.payable,
  );
  const available = candidates.reduce((a, i) => a + i.currentOpenCents, 0);
  if (input.amountCents > available)
    throw Errors.business(
      `O valor passa do saldo a pagar de ${user.displayName} neste fechamento (${(available / 100).toFixed(2)}).`,
    );
  const { parts } = allocateClosingPayment(
    input.amountCents,
    candidates.map((i) => ({
      ...i,
      openCents: i.currentOpenCents,
      order: `${i.competence}|${i.code}`,
    })),
  );
  const header = await tx.closingPayment.create({
    data: {
      weekStart: new Date(`${weekStart}T00:00:00Z`),
      beneficiaryUserId: user.id,
      category: input.category,
      amountCents: input.amountCents,
      paidAt: new Date(`${input.paidAt}T00:00:00Z`),
      method: input.method,
      reference: input.reference ?? null,
      note: input.note ?? null,
      createdById: actor.userId,
    },
  });
  const code = closingPaymentCode(header.number);
  const note = `${code} (fechamento ${weekStart})${input.reference ? ` · ref. ${input.reference}` : ''}`;
  for (const part of parts) {
    if (part.item.kind === 'MAO_DE_OBRA') {
      const p = await tx.productionPayable.findUniqueOrThrow({ where: { id: part.item.id } });
      const r = await payLabor(tx, actor, p.id, {
        amountCents: part.amountCents,
        paidAt: input.paidAt,
        method: input.method,
        note,
        version: p.version,
      });
      await tx.closingPaymentPart.create({
        data: {
          closingPaymentId: header.id,
          professionalPaymentId: r.paymentId,
          amountCents: part.amountCents,
        },
      });
    } else {
      const c = await tx.logisticsCost.findUniqueOrThrow({ where: { id: part.item.id } });
      const p = await tx.accountPayable.findUniqueOrThrow({ where: { id: c.payableId! } });
      const r = await payPayable(tx, actor, p.id, {
        amountCents: part.amountCents,
        paidAt: input.paidAt,
        method: input.method,
        note,
        version: p.version,
      });
      await tx.closingPaymentPart.create({
        data: {
          closingPaymentId: header.id,
          payablePaymentId: r.paymentId,
          amountCents: part.amountCents,
        },
      });
    }
  }
  await closingEvent(tx, actor, weekStart, 'PAGAMENTO', input.note ?? null, {
    code,
    beneficiary: user.displayName,
    category: input.category,
    amountCents: input.amountCents,
    parts: parts.map((p) => ({ code: p.item.code, amountCents: p.amountCents })),
  });
  await audit(tx, actor, {
    action: 'finance.closing_payment',
    entityType: 'closing_payment',
    entityId: header.id,
    summary: `${code}: pagamento externo de ${(input.amountCents / 100).toFixed(2)} a ${user.displayName} (${input.method}) baixado em ${parts.length} obrigação(ões).`,
  });
  return header.id;
}

/** Estorno do lote: estorna cada baixa nas obrigações originais (nada é apagado). */
export async function reverseClosingPayment(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: z.output<typeof reverseClosingPaymentSchema>,
) {
  await lockRow(tx, 'closing_payments', id, 'Pagamento do fechamento');
  const h = await tx.closingPayment.findUniqueOrThrow({
    where: { id },
    include: { parts: true, reversal: true },
  });
  if (h.reversal) throw Errors.conflict('Este pagamento já foi estornado.');
  for (const part of h.parts) {
    if (part.professionalPaymentId)
      await reverseLaborPayment(tx, actor, part.professionalPaymentId, { reason: input.reason });
    else {
      const pay = await tx.payablePayment.findUniqueOrThrow({
        where: { id: part.payablePaymentId! },
      });
      const p = await tx.accountPayable.findUniqueOrThrow({ where: { id: pay.payableId } });
      await reversePayablePayment(tx, actor, pay.id, { reason: input.reason, version: p.version });
    }
  }
  await tx.closingPaymentReversal.create({
    data: { closingPaymentId: id, reason: input.reason, createdById: actor.userId },
  });
  const weekStart = dateOnly(h.weekStart)!;
  await closingEvent(tx, actor, weekStart, 'ESTORNO', input.reason, {
    code: closingPaymentCode(h.number),
    amountCents: h.amountCents,
  });
  await audit(tx, actor, {
    action: 'finance.closing_payment_reversed',
    entityType: 'closing_payment',
    entityId: id,
    summary: `${closingPaymentCode(h.number)} estornado: ${input.reason}`,
  });
}

/** Viagem realizada sem custo confirmada como GRATUITA (distinta de "não informado"). */
export async function confirmFreeTrip(
  tx: Tx,
  actor: ActorContext,
  input: z.output<typeof freeTripSchema>,
) {
  const live = await tx.logisticsCost.count({
    where: {
      cancelledAt: null,
      ...(input.pickupId
        ? { pickupId: input.pickupId, kind: 'RETIRADA' }
        : { deliveryId: input.deliveryId!, kind: 'ENTREGA' }),
    },
  });
  if (live) throw Errors.business('A viagem já tem custo combinado: não pode ser gratuita.');
  if (input.pickupId && !(await tx.pickupRequest.count({ where: { id: input.pickupId } })))
    throw Errors.notFound('Retirada');
  if (input.deliveryId && !(await tx.delivery.count({ where: { id: input.deliveryId } })))
    throw Errors.notFound('Entrega');
  const r = await tx.logisticsFreeTrip.create({
    data: {
      pickupId: input.pickupId ?? null,
      deliveryId: input.deliveryId ?? null,
      reason: input.reason,
      confirmedById: actor.userId,
    },
  });
  await audit(tx, actor, {
    action: 'finance.trip_free_confirmed',
    entityType: 'logistics_free_trip',
    entityId: r.id,
    summary: `Viagem confirmada como gratuita: ${input.reason}`,
  });
}

function closingCsv(d: WeeklyClosingDto) {
  const money = (c: number) => (c / 100).toFixed(2).replace('.', ',');
  return toCsv(
    [
      'Semana',
      'Recebedor',
      'Categoria',
      'Código',
      'Situação',
      'Grupo',
      'Competência',
      'Devido',
      'Pago na semana',
      'Saldo ao fim',
      'Pago depois',
      'Saldo atual',
    ],
    d.items.map((i) => [
      d.weekStart,
      i.beneficiary.displayName,
      i.category,
      i.code,
      i.state,
      i.bucket ?? '',
      i.competence ?? '',
      money(i.dueCents),
      money(i.paidInWeekCents),
      money(i.openAtEndCents),
      money(i.paidAfterCents),
      money(i.currentOpenCents),
    ]),
  );
}

// ─────────────────────────── Rotas ───────────────────────────

export async function closingRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  const tx = <T>(fn: (t: Tx) => Promise<T>) => prisma.$transaction(fn, { timeout: 60_000 });

  app.get('/api/v1/finance/weekly-closings', { config: { access: FIN_VIEW } }, async () => {
    const rows = await prisma.weeklyClosing.findMany({
      orderBy: { weekStart: 'desc' },
      take: 60,
      include: { checkedBy: { select: { displayName: true } } },
    });
    return rows.map((r) => ({
      weekStart: dateOnly(r.weekStart),
      status: r.status,
      version: r.version,
      dueCents: r.dueCents,
      paidCents: r.paidCents,
      openCents: r.openCents,
      checkedBy: r.checkedBy?.displayName ?? null,
      checkedAt: r.checkedAt?.toISOString() ?? null,
    }));
  });

  app.get(
    '/api/v1/finance/weekly-closings/:weekStart',
    { config: { access: FIN_VIEW } },
    async (request, reply) => {
      const { weekStart } = weekStartParamsSchema.parse(request.params);
      const q = closingQuerySchema.parse(request.query);
      const d = await weeklyClosing(prisma, weekStart, q);
      if (q.format === 'csv')
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('cache-control', 'no-store')
          .header('content-disposition', `attachment; filename="fechamento-${weekStart}.csv"`)
          .send(closingCsv(d));
      return d;
    },
  );

  app.post(
    '/api/v1/finance/weekly-closings/:weekStart/confirm',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request) => {
      const { weekStart } = weekStartParamsSchema.parse(request.params);
      const input = confirmClosingSchema.parse(request.body);
      await tx((t) => confirmClosing(t, actorFrom(request), weekStart, input));
      return weeklyClosing(prisma, weekStart);
    },
  );

  app.post(
    '/api/v1/finance/weekly-closings/:weekStart/reopen',
    { config: { access: FIN_ADJUST, idempotent: true } },
    async (request) => {
      const { weekStart } = weekStartParamsSchema.parse(request.params);
      const input = reopenClosingSchema.parse(request.body);
      await tx((t) => reopenClosing(t, actorFrom(request), weekStart, input));
      return weeklyClosing(prisma, weekStart);
    },
  );

  app.post(
    '/api/v1/finance/weekly-closings/:weekStart/payments',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request, reply) => {
      const { weekStart } = weekStartParamsSchema.parse(request.params);
      const input = closingPaymentSchema.parse(request.body);
      await tx((t) => registerClosingPayment(t, actorFrom(request), weekStart, input));
      return reply.status(201).send(await weeklyClosing(prisma, weekStart));
    },
  );

  app.post(
    '/api/v1/finance/closing-payments/:id/reverse',
    { config: { access: FIN_ADJUST, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = reverseClosingPaymentSchema.parse(request.body);
      const h = await prisma.closingPayment.findUnique({ where: { id } });
      if (!h) throw Errors.notFound('Pagamento do fechamento');
      await tx((t) => reverseClosingPayment(t, actorFrom(request), id, input));
      return weeklyClosing(prisma, dateOnly(h.weekStart)!);
    },
  );

  app.post(
    '/api/v1/finance/labor/:id/payments/:paymentId/reverse',
    { config: { access: FIN_ADJUST, idempotent: true } },
    async (request) => {
      const { id, paymentId } = z
        .object({ id: z.string().uuid(), paymentId: z.string().uuid() })
        .parse(request.params);
      const input = reverseLaborPaymentSchema.parse(request.body);
      await tx(async (t) => {
        const pay = await t.professionalPayment.findUnique({ where: { id: paymentId } });
        if (!pay || pay.productionPayableId !== id) throw Errors.notFound('Pagamento');
        await reverseLaborPayment(t, actorFrom(request), paymentId, input);
      });
      return { ok: true };
    },
  );

  app.post(
    '/api/v1/finance/trip-costs/free',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request) => {
      const input = freeTripSchema.parse(request.body);
      await tx((t) => confirmFreeTrip(t, actorFrom(request), input));
      return { ok: true };
    },
  );
}
