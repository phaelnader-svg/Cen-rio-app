import {
  PAYMENT_METHOD_LABEL,
  confirmPaymentReportSchema,
  discardPaymentReportSchema,
  formatCents,
  receivableCode,
  type AttentionItemDto,
  type LogisticsJobDto,
  type PaymentInstructionDto,
  type paymentReportSchema,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { orderCode, serviceOrderCode } from '../commercial/common';
import { FIN_MANAGE, FIN_VIEW, checkVersion, financeEvent, lockRow } from './common';
import {
  dueContext,
  dueOf,
  lockOrder,
  receivePayment,
  reportInclude,
  toPaymentReportDto,
} from './revenue';

/**
 * Cobrança na operação (AM-8/AM-9): a equipe da retirada/entrega vê SÓ a instrução de pagamento
 * da própria parada e INFORMA o que aconteceu; o escritório (financeiro.gerenciar) confirma —
 * só então nasce o recebimento real. O tablet nunca cria `customer_payment`.
 */

const OPEN = ['ABERTO', 'PARCIAL'];

type Stop = { kind: 'RETIRADA' | 'ENTREGA'; id: string };

/**
 * Instrução de pagamento por parada, só para o RESPONSÁVEL da parada, com a cobrança aberta cujo
 * gatilho corresponde (RETIRADA → retiradas do pedido; ENTREGA → entregas com peças do pedido).
 * Uma cobrança por parada (a mais antiga em aberto); quitada ou cancelada, some.
 */
export async function paymentInstructionsFor(
  db: Tx | PrismaClient,
  stops: Stop[],
  viewerUserId: string | null,
): Promise<Map<string, PaymentInstructionDto>> {
  const out = new Map<string, PaymentInstructionDto>();
  if (!viewerUserId || !stops.length) return out;
  const pickupIds = stops.filter((s) => s.kind === 'RETIRADA').map((s) => s.id);
  const deliveryIds = stops.filter((s) => s.kind === 'ENTREGA').map((s) => s.id);
  const pickups = pickupIds.length
    ? await db.pickupRequest.findMany({
        where: {
          id: { in: pickupIds },
          logisticsUserId: viewerUserId,
          status: { not: 'CANCELADA' },
        },
        select: { id: true, orderId: true },
      })
    : [];
  const deliveries = deliveryIds.length
    ? await db.delivery.findMany({
        where: {
          id: { in: deliveryIds },
          responsibleUserId: viewerUserId,
          status: { not: 'CANCELADA' },
        },
        select: {
          id: true,
          items: {
            where: { active: true },
            select: {
              serviceOrderItem: { select: { serviceOrder: { select: { orderId: true } } } },
            },
          },
        },
      })
    : [];
  const deliveryOrders = new Map(
    deliveries.map((d) => [
      d.id,
      [...new Set(d.items.map((i) => i.serviceOrderItem.serviceOrder.orderId))],
    ]),
  );
  const orderIds = [
    ...new Set([...pickups.map((p) => p.orderId), ...[...deliveryOrders.values()].flat()]),
  ];
  if (!orderIds.length) return out;
  const receivables = await db.customerReceivable.findMany({
    where: {
      orderId: { in: orderIds },
      status: { in: OPEN },
      dueTrigger: { in: ['RETIRADA', 'ENTREGA'] },
      order: { status: { not: 'CANCELADO' } },
    },
    orderBy: [{ createdAt: 'asc' }, { number: 'asc' }],
    include: {
      reports: { where: { status: 'PENDENTE' }, select: { pickupId: true, deliveryId: true } },
    },
  });
  const pick = (orderIdsOfStop: string[], trigger: string) =>
    receivables.find(
      (r) =>
        orderIdsOfStop.includes(r.orderId) &&
        r.dueTrigger === trigger &&
        r.amountCents > r.receivedCents,
    );
  for (const p of pickups) {
    const r = pick([p.orderId], 'RETIRADA');
    if (r)
      out.set(`RETIRADA:${p.id}`, {
        action: 'PAGAMENTO_NA_RETIRADA',
        receivableId: r.id,
        amountCents: r.amountCents - r.receivedCents,
        method: r.expectedMethod,
        installments: r.installments,
        reported: r.reports.some((x) => x.pickupId === p.id),
      });
  }
  for (const [deliveryId, oids] of deliveryOrders) {
    const r = pick(oids, 'ENTREGA');
    if (r)
      out.set(`ENTREGA:${deliveryId}`, {
        action: 'PAGAMENTO_NA_ENTREGA',
        receivableId: r.id,
        amountCents: r.amountCents - r.receivedCents,
        method: r.expectedMethod,
        installments: r.installments,
        reported: r.reports.some((x) => x.deliveryId === deliveryId),
      });
  }
  return out;
}

/** Acrescenta a instrução de pagamento às paradas (só a do próprio responsável). */
export async function withPaymentInstructions<T extends LogisticsJobDto>(
  db: Tx | PrismaClient,
  jobs: T[],
  viewerUserId: string | null,
): Promise<T[]> {
  const map = await paymentInstructionsFor(
    db,
    jobs.map((j) => ({ kind: j.kind, id: j.id })),
    viewerUserId,
  );
  return jobs.map((j) => ({ ...j, paymentInstruction: map.get(`${j.kind}:${j.id}`) ?? null }));
}

/** A equipe informa o pagamento da parada (registro operacional; nunca baixa financeira). */
export async function reportStopPayment(
  tx: Tx,
  actor: ActorContext,
  stop: Stop,
  input: z.infer<typeof paymentReportSchema>,
) {
  const r = await tx.customerReceivable.findUnique({ where: { id: input.receivableId } });
  if (!r) throw Errors.notFound('Cobrança');
  await lockOrder(tx, r.orderId);
  await lockRow(tx, 'customer_receivables', r.id, 'Cobrança');
  const instr = (await paymentInstructionsFor(tx, [stop], actor.userId)).get(
    `${stop.kind}:${stop.id}`,
  );
  if (!instr || instr.receivableId !== r.id)
    throw Errors.business(
      'Não há pagamento a informar nesta parada (cobrança quitada ou cancelada).',
    );
  if (instr.reported) throw Errors.conflict('O pagamento desta parada já foi informado.');
  if (input.collected && !input.method)
    throw Errors.validation(undefined, 'Informe a forma de pagamento usada.');
  const row = await tx.customerPaymentReport.create({
    data: {
      receivableId: r.id,
      pickupId: stop.kind === 'RETIRADA' ? stop.id : null,
      deliveryId: stop.kind === 'ENTREGA' ? stop.id : null,
      collected: input.collected,
      method: input.collected ? (input.method ?? null) : null,
      note: input.note ?? null,
      reportedById: actor.userId!,
    },
  });
  await audit(tx, actor, {
    action: 'finance.payment_reported',
    entityType: 'customer_receivable',
    entityId: r.id,
    summary: `${receivableCode(r.number)}: equipe informou ${input.collected ? `pagamento (${input.method})` : 'que NÃO houve pagamento'} na ${stop.kind === 'RETIRADA' ? 'retirada' : 'entrega'}.`,
    changes: { reportId: row.id, collected: input.collected, method: input.method ?? null },
  });
  await financeEvent(tx, actor, {
    entityType: 'customer_receivable',
    entityId: r.id,
    kind: input.collected ? 'PAGAMENTO_INFORMADO' : 'PAGAMENTO_NAO_REALIZADO',
    note: input.note ?? null,
    data: { reportId: row.id, stop, method: input.method ?? null },
  });
  return row;
}

/** Lock: pedido → cobrança → registro. */
async function lockReport(tx: Tx, id: string) {
  const p = await tx.customerPaymentReport.findUnique({
    where: { id },
    select: { receivable: { select: { id: true, orderId: true } } },
  });
  if (!p) throw Errors.notFound('Pagamento informado');
  await lockOrder(tx, p.receivable.orderId);
  await lockRow(tx, 'customer_receivables', p.receivable.id, 'Cobrança');
  await lockRow(tx, 'customer_payment_reports', id, 'Pagamento informado');
  return tx.customerPaymentReport.findUniqueOrThrow({ where: { id } });
}

export async function confirmReport(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: z.infer<typeof confirmPaymentReportSchema>,
) {
  const rep = await lockReport(tx, id);
  if (rep.status === 'CONFIRMADO') throw Errors.conflict('Este pagamento já foi confirmado.');
  if (rep.status !== 'PENDENTE') throw Errors.conflict('Este registro já foi descartado.');
  checkVersion(rep, input.version);
  const rec = await tx.customerReceivable.findUniqueOrThrow({ where: { id: rep.receivableId } });
  const { payment } = await receivePayment(tx, actor, rec.id, {
    amountCents: input.amountCents,
    receivedAt: input.receivedAt,
    method: input.method,
    installments: input.installments ?? null,
    note: input.note ?? `Informado pela equipe na ${rep.pickupId ? 'retirada' : 'entrega'}`,
    version: rec.version,
  });
  await tx.customerPaymentReport.update({
    where: { id },
    data: {
      status: 'CONFIRMADO',
      paymentId: payment.id,
      decidedById: actor.userId,
      decidedAt: new Date(),
      decisionNote: input.note ?? null,
      version: { increment: 1 },
    },
  });
  await audit(tx, actor, {
    action: 'finance.payment_report_confirmed',
    entityType: 'customer_receivable',
    entityId: rec.id,
    summary: `${receivableCode(rec.number)}: pagamento informado pela equipe confirmado (${formatCents(input.amountCents)}).`,
    changes: { reportId: id, paymentId: payment.id },
  });
  await financeEvent(tx, actor, {
    entityType: 'customer_receivable',
    entityId: rec.id,
    kind: 'INFORMADO_CONFIRMADO',
    note: input.note ?? null,
    data: { reportId: id, paymentId: payment.id },
  });
}

export async function discardReport(
  tx: Tx,
  actor: ActorContext,
  id: string,
  input: z.infer<typeof discardPaymentReportSchema>,
) {
  const rep = await lockReport(tx, id);
  if (rep.status !== 'PENDENTE') throw Errors.conflict('Este registro já foi decidido.');
  checkVersion(rep, input.version);
  await tx.customerPaymentReport.update({
    where: { id },
    data: {
      status: 'DESCARTADO',
      decidedById: actor.userId,
      decidedAt: new Date(),
      decisionNote: input.reason,
      version: { increment: 1 },
    },
  });
  await audit(tx, actor, {
    action: 'finance.payment_report_discarded',
    entityType: 'customer_receivable',
    entityId: rep.receivableId,
    summary: `Pagamento informado pela equipe descartado: ${input.reason}`,
    changes: { reportId: id },
  });
  await financeEvent(tx, actor, {
    entityType: 'customer_receivable',
    entityId: rep.receivableId,
    kind: 'INFORMADO_DESCARTADO',
    note: input.reason,
    data: { reportId: id },
  });
}

// ─────────────────────────── Central (tipo COBRANCA) ───────────────────────────

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Itens de cobrança da Central (derivados a cada consulta; nada é gravado). Só para quem tem
 * financeiro.ver. Um item por fato (chave estável):
 * - COBRANCA:VENCIDA:<cobrança> — com data passada (ATENCAO) ou entregue/retirado com saldo
 *   (CRITICO, "entregue com saldo");
 * - COBRANCA:ENTREGA:<entrega> — entrega agendada nos próximos 2 dias com saldo do pedido (ACAO);
 * - COBRANCA:INFORMADO:<registro> — pagamento informado pela equipe aguardando o escritório (ACAO).
 */
export async function billingAttention(db: PrismaClient): Promise<AttentionItemDto[]> {
  const items: AttentionItemDto[] = [];
  const open = await db.customerReceivable.findMany({
    where: { status: { in: OPEN }, order: { status: { not: 'CANCELADO' } } },
    include: {
      order: { select: { id: true, number: true } },
      customer: { select: { name: true } },
      serviceOrder: { select: { id: true, number: true } },
    },
  });
  const ctx = await dueContext(
    db,
    open.map((r) => r.orderId),
  );
  for (const r of open) {
    const d = dueOf(r, ctx);
    if (!d.overdue) continue;
    const delivered = r.dueTrigger !== 'DATA';
    const code = orderCode(r.order.number);
    items.push({
      key: `COBRANCA:VENCIDA:${r.id}`,
      type: 'COBRANCA',
      category: delivered ? 'CRITICO' : 'ATENCAO',
      title: `${code} · ${r.customer.name} — ${delivered ? (r.dueTrigger === 'ENTREGA' ? 'ENTREGUE COM SALDO' : 'RETIRADO COM SALDO') : 'COBRANÇA VENCIDA'}`,
      description: `${receivableCode(r.number)} ${r.description}: saldo ${formatCents(d.openCents)}${d.daysOverdue ? ` · ${d.daysOverdue} dia(s) em atraso` : ''}.`,
      serviceOrder: r.serviceOrder
        ? { id: r.serviceOrder.id, code: serviceOrderCode(r.serviceOrder.number) }
        : null,
      task: null,
      employee: null,
      priority: 'NORMAL',
      status: 'VENCIDA',
      statusLabel: 'Vencida',
      at: (d.effectiveDue ? new Date(`${d.effectiveDue}T12:00:00Z`) : r.updatedAt).toISOString(),
      deadline: d.effectiveDue,
      solver: null,
      impacts: [],
      nextActions: ['Cobrar o cliente e registrar o recebimento'],
      link: `/painel/pedidos/${r.order.id}`,
    });
  }
  // Entregas próximas (hoje até +2 dias) de pedidos com saldo.
  const soon = await db.delivery.findMany({
    where: {
      status: { in: ['AGENDADA', 'EM_TRANSPORTE', 'NO_DESTINO'] },
      scheduledDate: { lte: new Date(`${addDays(ctx.today, 2)}T00:00:00Z`) },
    },
    select: {
      id: true,
      number: true,
      scheduledDate: true,
      updatedAt: true,
      customer: { select: { name: true } },
      items: {
        where: { active: true },
        select: { serviceOrderItem: { select: { serviceOrder: { select: { orderId: true } } } } },
      },
    },
  });
  const openByOrder = new Map<string, number>();
  for (const r of open)
    openByOrder.set(r.orderId, (openByOrder.get(r.orderId) ?? 0) + r.amountCents - r.receivedCents);
  for (const dl of soon) {
    const oids = [...new Set(dl.items.map((i) => i.serviceOrderItem.serviceOrder.orderId))];
    const balance = oids.reduce((a, o) => a + (openByOrder.get(o) ?? 0), 0);
    if (balance <= 0) continue;
    items.push({
      key: `COBRANCA:ENTREGA:${dl.id}`,
      type: 'COBRANCA',
      category: 'ACAO',
      title: `Entrega com saldo · ${dl.customer.name}`,
      description: `Saldo em aberto ${formatCents(balance)} na entrega de ${dl.scheduledDate?.toISOString().slice(0, 10) ?? '—'}.`,
      serviceOrder: null,
      task: null,
      employee: null,
      priority: 'NORMAL',
      status: 'ENTREGA_COM_SALDO',
      statusLabel: 'Entrega com saldo',
      at: dl.updatedAt.toISOString(),
      deadline: dl.scheduledDate?.toISOString().slice(0, 10) ?? null,
      solver: null,
      impacts: [],
      nextActions: ['Combinar o pagamento com o cliente antes da entrega'],
      link: `/painel/entregas/${dl.id}`,
    });
  }
  const reports = await db.customerPaymentReport.findMany({
    where: { status: 'PENDENTE', collected: true },
    include: reportInclude,
  });
  for (const p of reports) {
    const dto = toPaymentReportDto(p);
    items.push({
      key: `COBRANCA:INFORMADO:${p.id}`,
      type: 'COBRANCA',
      category: 'ACAO',
      title: `Pagamento informado pela equipe — confirmar · ${dto.customerName}`,
      description: `${dto.order.code} · ${dto.stop.code}: ${dto.method ? PAYMENT_METHOD_LABEL[dto.method] : '—'} informado por ${dto.reportedBy}.`,
      serviceOrder: null,
      task: null,
      employee: null,
      priority: 'NORMAL',
      status: 'INFORMADO',
      statusLabel: 'Aguardando confirmação',
      at: dto.reportedAt,
      deadline: null,
      solver: null,
      impacts: [],
      nextActions: ['Conferir o pagamento e confirmar a baixa'],
      // Fase 10: a confirmação/descarte fica em Financeiro → Receitas e recebimentos.
      link: '/painel/financeiro?tab=receitas',
    });
  }
  return items;
}

// ─────────────────────────── Rotas do escritório ───────────────────────────

export async function billingRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  const tx = <T>(fn: (t: Tx) => Promise<T>) => prisma.$transaction(fn);
  const params = z.object({ id: z.string().uuid() });

  app.get('/api/v1/finance/payment-reports', { config: { access: FIN_VIEW } }, async (request) => {
    const q = z
      .object({ status: z.enum(['PENDENTE', 'CONFIRMADO', 'DESCARTADO']).optional() })
      .parse(request.query);
    const rows = await prisma.customerPaymentReport.findMany({
      where: { status: q.status ?? 'PENDENTE' },
      include: reportInclude,
      orderBy: { reportedAt: 'desc' },
      take: 200,
    });
    return rows.map(toPaymentReportDto);
  });

  const reportDto = async (id: string) =>
    toPaymentReportDto(
      await prisma.customerPaymentReport.findUniqueOrThrow({
        where: { id },
        include: reportInclude,
      }),
    );

  app.post(
    '/api/v1/finance/payment-reports/:id/confirm',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request) => {
      const { id } = params.parse(request.params);
      const input = confirmPaymentReportSchema.parse(request.body);
      await tx((t) => confirmReport(t, actorFrom(request), id, input));
      return reportDto(id);
    },
  );

  app.post(
    '/api/v1/finance/payment-reports/:id/discard',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request) => {
      const { id } = params.parse(request.params);
      const input = discardPaymentReportSchema.parse(request.body);
      await tx((t) => discardReport(t, actorFrom(request), id, input));
      return reportDto(id);
    },
  );
}
