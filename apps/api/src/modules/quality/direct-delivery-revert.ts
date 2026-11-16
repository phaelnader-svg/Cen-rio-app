import {
  DIRECT_DELIVERY_REVERT_DAYS,
  DIRECT_DELIVERY_REVERT_PERMISSIONS,
  closingWeekStart,
  deliveryCode,
  productionPayableCode,
  receivableCode,
  type DirectDeliveryRevertPreviewDto,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import { now as clockNow } from '../../core/clock';
import { audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { dateOnly, serviceOrderCode } from '../commercial/common';
import { lockRow } from '../finance/common';
import { laborChangesAfterRelease, laborInclude } from '../finance/labor';
import { company } from '../production/common';
import { moveItem, moveItemToKey, pieceCode, refreshItemStage } from './common';
import { deliveryDomainEvent, deliveryEvent } from './shipping';

/**
 * Reformulação, Fase 3 (D5) — desfazer a ÚLTIMA entrega direta da OS.
 * Regra aprovada: docs/REFORMULACAO-FASE-3-REGRA-REVERSAO-ENTREGA.md.
 *
 * Nada é apagado: a entrega continua registrada (CONCLUIDA) e é marcada como desfeita (quem,
 * quando, por quê); os itens dela passam a NAO_ENTREGUE e inativos — todas as leituras de
 * "entregue" (etapa, vencimento por entrega, prazo, pedido, conclusão da OS) exigem item
 * ENTREGUE/DIVERGENTE e deixam de contá-los. Pelo mesmo caminho de sempre (`refreshItemStage`),
 * a peça volta a "pronta para entrega" e a mão de obra "entregue ao cliente" volta a prevista; a
 * data de liberação dela é limpa (é a competência do fechamento — sem isso, o fechamento ainda a
 * contaria como devida). Lançamentos independentes (outras obrigações, pagamentos, recebimentos,
 * custos) não são tocados.
 *
 * Bloqueios (a reversão é recusada sem gravar nada): mão de obra relacionada paga (mesmo em
 * parte); semana do fechamento conferida; cobrança vinculada paga depois da entrega; nova
 * entrega, devolução, cancelamento ou alteração técnica depois dela; prazo de 7 dias vencido.
 * Tudo é recalculado DENTRO da transação, depois das travas (OS → peças), na confirmação.
 */
export const DIRECT_REVERT_ACCESS = {
  session: 'WEB',
  permissions: [...DIRECT_DELIVERY_REVERT_PERMISSIONS],
} as const;

/** Ganchos só para testes (falha no meio da transação). */
export const revertTestHooks: { beforeFinish?: () => Promise<void> } = {};

const DELIVERED = ['ENTREGUE', 'DIVERGENTE'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** Última entrega direta NÃO desfeita com peças desta OS. */
async function lastDirectDelivery(db: Tx | PrismaClient, serviceOrderId: string) {
  return db.delivery.findFirst({
    where: {
      origin: 'DIRETA',
      status: 'CONCLUIDA',
      revertedAt: null,
      items: {
        some: { status: { in: DELIVERED }, active: true, serviceOrderItem: { serviceOrderId } },
      },
    },
    orderBy: [{ completedAt: 'desc' }, { number: 'desc' }],
    include: {
      createdBy: { select: { displayName: true } },
      items: {
        where: { status: { in: DELIVERED }, active: true },
        include: { serviceOrderItem: { include: { serviceOrder: { select: { number: true } } } } },
      },
    },
  });
}

type Analysis = Awaited<ReturnType<typeof analyze>>;

/** Análise completa (prévia e confirmação usam a MESMA função). */
async function analyze(db: Tx | PrismaClient, serviceOrderId: string) {
  const so = await db.serviceOrder.findUnique({
    where: { id: serviceOrderId },
    include: { order: { select: { id: true } } },
  });
  if (!so) throw Errors.notFound('Ordem de serviço');
  const d = await lastDirectDelivery(db, serviceOrderId);
  const { timezone } = await company(db);
  const local = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(x);
  const now = clockNow();
  const today = local(now);
  if (!d)
    return {
      so,
      d: null,
      pieces: [],
      blocks: ['Não há entrega direta desta OS para desfazer.'],
      labor: [],
      receivables: [],
      deadline: '',
      today,
      local,
    };
  const pieces = d.items.filter((i) => i.serviceOrderItem.serviceOrderId === serviceOrderId);
  const pieceIds = pieces.map((p) => p.serviceOrderItemId);
  const completedAt = d.completedAt!;
  const deadline = local(new Date(completedAt.getTime() + DIRECT_DELIVERY_REVERT_DAYS * DAY_MS));
  const blocks: string[] = [];

  // Prazo e situação da OS.
  if (today > deadline)
    blocks.push(
      `O prazo para desfazer terminou em ${deadline.split('-').reverse().join('/')} (${DIRECT_DELIVERY_REVERT_DAYS} dias após a entrega). Use o fluxo de devolução.`,
    );
  if (so.status === 'CANCELADA') blocks.push('A OS foi cancelada depois da entrega.');

  // Nova entrega depois desta (qualquer origem) com peças da OS.
  const later = await db.delivery.findFirst({
    where: {
      id: { not: d.id },
      status: { not: 'CANCELADA' },
      revertedAt: null,
      createdAt: { gt: d.createdAt },
      items: { some: { serviceOrderItem: { serviceOrderId } } },
    },
    select: { number: true },
  });
  if (later)
    blocks.push(
      `Já existe uma entrega posterior (${deliveryCode(later.number)}) com peças desta OS: só a última pode ser desfeita.`,
    );

  // Devolução registrada depois da entrega.
  const returns = await db.pieceReturn.findMany({
    where: { orderId: so.orderId, cancelledAt: null, createdAt: { gt: completedAt } },
    include: { lines: { select: { serviceOrderItemIds: true } } },
  });
  const returned = returns.filter((r) =>
    r.lines.some((l) => l.serviceOrderItemIds.some((x) => pieceIds.includes(x))),
  );
  if (returned.length || pieces.some((p) => p.serviceOrderItem.fulfillmentStage === 'DEVOLVIDA'))
    blocks.push('Há devolução registrada para peças desta entrega.');

  // Alteração técnica depois da entrega.
  const revisions = await db.serviceOrderRevision.count({
    where: {
      serviceOrderId,
      createdAt: { gt: completedAt },
      OR: [{ itemId: null }, { itemId: { in: pieceIds } }],
    },
  });
  if (revisions) blocks.push(`A OS teve ${revisions} alteração(ões) técnica(s) depois da entrega.`);

  // Mão de obra "entregue ao cliente" das peças (ou da OS inteira).
  const payables = await db.productionPayable.findMany({
    where: {
      serviceOrderId,
      eligibility: 'ENTREGA_CONCLUIDA',
      status: { not: 'CANCELADO' },
      OR: [{ serviceOrderItemId: null }, { serviceOrderItemId: { in: pieceIds } }],
    },
    include: laborInclude,
  });
  const released = payables.filter((p) => p.eligibleAt);
  for (const p of payables)
    if (p.paidCents > 0)
      blocks.push(
        `A mão de obra ${productionPayableCode(p.number)} (${p.professional.displayName}) já tem pagamento registrado.`,
      );
  // Semanas do fechamento: a da liberação e as das mudanças de valor depois dela.
  const changes = await laborChangesAfterRelease(db, released);
  const weeks = new Map<string, string>();
  for (const p of released) {
    weeks.set(closingWeekStart(local(p.eligibleAt!)), productionPayableCode(p.number));
    for (const c of changes.get(p.id) ?? [])
      weeks.set(closingWeekStart(local(c.at)), productionPayableCode(p.number));
  }
  if (weeks.size) {
    const closed = await db.weeklyClosing.findMany({
      where: {
        weekStart: { in: [...weeks.keys()].map((w) => new Date(`${w}T00:00:00Z`)) },
        status: 'CONFERIDO',
      },
      select: { weekStart: true },
    });
    for (const c of closed) {
      const w = dateOnly(c.weekStart)!;
      blocks.push(
        `O fechamento da semana de ${w.split('-').reverse().join('/')} (com a mão de obra ${weeks.get(w)}) já foi conferido. Reabra a semana pelo financeiro antes de desfazer.`,
      );
    }
  }

  // Cobranças com vencimento na entrega do pedido.
  const receivables = await db.customerReceivable.findMany({
    where: { orderId: so.orderId, dueTrigger: 'ENTREGA', status: { not: 'CANCELADO' } },
    include: { payments: true },
  });
  const deliveredDay = local(completedAt);
  for (const r of receivables) {
    // Recebimento estornado (lançamento compensatório) não conta: o dinheiro não ficou.
    const reversed = new Set(r.payments.map((x) => x.reversalOfId).filter(Boolean));
    const after = r.payments.filter(
      (x) =>
        x.amountCents > 0 &&
        !x.refund &&
        !reversed.has(x.id) &&
        dateOnly(x.receivedAt)! >= deliveredDay,
    );
    if (after.length)
      blocks.push(
        `A cobrança ${receivableCode(r.number)} (${r.description}) recebeu pagamento depois da entrega.`,
      );
  }

  return {
    so,
    d,
    pieces,
    blocks,
    labor: released.filter((p) => p.status === 'LIBERADO'),
    receivables,
    deadline,
    today,
    local,
  };
}

function previewOf(a: Analysis): DirectDeliveryRevertPreviewDto {
  return {
    delivery: a.d
      ? {
          id: a.d.id,
          code: deliveryCode(a.d.number),
          completedAt: a.d.completedAt!.toISOString(),
          confirmedBy: a.d.createdBy?.displayName ?? null,
          deadline: a.deadline,
        }
      : null,
    allowed: Boolean(a.d) && a.blocks.length === 0,
    blocks: a.blocks,
    effects: {
      pieces: a.pieces.map((p) => ({
        code: pieceCode(p.serviceOrderItem),
        description: p.serviceOrderItem.description,
      })),
      labor: a.labor.map((p) => ({
        code: productionPayableCode(p.number),
        professional: p.professional.displayName,
        agreedCents: p.agreedCents + p.adjustmentsCents,
      })),
      receivables: a.receivables
        .filter((r) => r.amountCents - r.receivedCents > 0)
        .map((r) => ({
          code: receivableCode(r.number),
          description: r.description,
          openCents: r.amountCents - r.receivedCents,
        })),
      deadline: {
        promisedDate: dateOnly(a.so.promisedDate),
        overdue: Boolean(a.so.promisedDate && dateOnly(a.so.promisedDate)! < a.today),
      },
    },
  };
}

export async function directDeliveryRevertPreview(
  db: Tx | PrismaClient,
  serviceOrderId: string,
): Promise<DirectDeliveryRevertPreviewDto> {
  return previewOf(await analyze(db, serviceOrderId));
}

/** Desfaz a última entrega direta (ver o comentário do módulo). Tudo ou nada. */
export async function revertDirectDelivery(
  tx: Tx,
  actor: ActorContext,
  serviceOrderId: string,
  input: { deliveryId: string; reason: string },
): Promise<{ reverted: boolean; deliveryCode: string }> {
  // Travas na mesma ordem da entrega direta: OS, depois as peças (ordem fixa).
  await lockRow(tx, 'service_orders', serviceOrderId, 'Ordem de serviço');
  const target = await tx.delivery.findUnique({ where: { id: input.deliveryId } });
  if (!target) throw Errors.notFound('Entrega');
  await lockRow(tx, 'deliveries', target.id, 'Entrega');
  const fresh = await tx.delivery.findUniqueOrThrow({ where: { id: target.id } });
  // Repetição (mesma entrega já desfeita): nada a gravar.
  if (fresh.revertedAt) return { reverted: false, deliveryCode: deliveryCode(fresh.number) };
  const items = await tx.deliveryItem.findMany({
    where: { deliveryId: target.id },
    select: { serviceOrderItemId: true },
  });
  for (const id of items.map((i) => i.serviceOrderItemId).sort())
    await tx.$queryRaw`SELECT id FROM service_order_items WHERE id = ${id}::uuid FOR UPDATE`;

  // Revalida TUDO depois das travas.
  const a = await analyze(tx, serviceOrderId);
  if (!a.d || a.d.id !== target.id)
    throw Errors.conflict(
      'Esta não é mais a última entrega direta da OS (algo mudou desde a prévia). Atualize a tela.',
    );
  if (a.blocks.length)
    throw Errors.business(`A entrega não pode ser desfeita: ${a.blocks.join(' ')}`, {
      blocks: a.blocks,
    });

  const now = clockNow();
  const code = deliveryCode(a.d.number);
  const pieceIds = a.pieces.map((p) => p.serviceOrderItemId);
  const reason = input.reason.trim();
  const u = await tx.delivery.update({
    where: { id: a.d.id },
    data: {
      revertedAt: now,
      revertedById: actor.userId,
      revertReason: reason,
      version: { increment: 1 },
    },
  });
  await tx.deliveryItem.updateMany({
    where: { deliveryId: a.d.id, serviceOrderItemId: { in: pieceIds } },
    data: {
      status: 'NAO_ENTREGUE',
      active: false,
      note: `Entrega direta desfeita: ${reason}`.slice(0, 500),
    },
  });
  await deliveryEvent(tx, actor, a.d.id, {
    kind: 'ENTREGA_DIRETA_DESFEITA',
    from: 'CONCLUIDA',
    to: 'CONCLUIDA',
    note: `Entrega direta desfeita (${a.pieces.map((p) => pieceCode(p.serviceOrderItem)).join(', ')}): ${reason}`.slice(
      0,
      1000,
    ),
    data: { reverted: true, items: a.pieces.map((p) => pieceCode(p.serviceOrderItem)) },
  });
  // Peças voltam para onde estavam antes da entrega (ou para a expedição).
  for (const p of a.pieces) {
    const before = await tx.itemLocationEvent.findFirst({
      where: { serviceOrderItemId: p.serviceOrderItemId, createdAt: { lt: a.d.completedAt! } },
      orderBy: { createdAt: 'desc' },
      include: { location: true },
    });
    if (before?.location.active && before.location.key !== 'ENTREGUE')
      await moveItem(tx, actor, p.serviceOrderItemId, before.locationId, 'Entrega direta desfeita');
    else
      await moveItemToKey(tx, actor, p.serviceOrderItemId, 'EXPEDICAO', 'Entrega direta desfeita');
  }
  // Mão de obra "na entrega": a competência (data de liberação) deixa de valer.
  const laborBefore = a.labor.map((p) => ({ id: p.id, code: productionPayableCode(p.number) }));
  if (laborBefore.length)
    await tx.productionPayable.updateMany({
      where: { id: { in: laborBefore.map((p) => p.id) }, paidCents: 0 },
      data: { eligibleAt: null },
    });
  // Etapa (e, por ela, mão de obra, prazos e avisos) pelo caminho de sempre.
  for (const id of pieceIds) await refreshItemStage(tx, actor, id);
  await revertTestHooks.beforeFinish?.();
  await audit(tx, actor, {
    action: 'delivery.direct_reverted',
    entityType: 'delivery',
    entityId: a.d.id,
    summary: `EXCEÇÃO: ${code} (entrega direta da OS ${serviceOrderCode(a.so.number)}) desfeita — ${pieceIds.length} peça(s). Justificativa: ${reason}`,
    changes: {
      serviceOrderId,
      deliveredAt: a.d.completedAt!.toISOString(),
      revertedAt: now.toISOString(),
      reason,
      pieces: a.pieces.map((p) => pieceCode(p.serviceOrderItem)),
      laborBackToForecast: laborBefore.map((p) => p.code),
      receivablesAwaitingDelivery: a.receivables.map((r) => receivableCode(r.number)),
    },
  });
  await deliveryDomainEvent(tx, actor, u);
  return { reverted: true, deliveryCode: code };
}
