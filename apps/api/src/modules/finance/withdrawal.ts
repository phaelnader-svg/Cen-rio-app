import { EVENT_TYPES, productionPayableCode } from '@cenario/shared';
import type { Prisma, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { onServiceOrderCancelled } from '../production/cancellation';
import { notifyUsersWith } from '../quality/common';
import { financeEvent, lockRow } from './common';
import { laborReviewCode, openReviewOf } from './labor';

/**
 * Fase 12 — valores de produção de peças devolvidas (ou de OS cancelada).
 *
 * - Sem execução, sem pagamento e sem condição atingida → o valor previsto é cancelado com
 *   justificativa registrada (histórico financeiro + auditoria). Nada é apagado.
 * - Com trabalho executado, condição já atingida ou pagamento feito → nada é alterado
 *   automaticamente (nenhum desconto em pagamento de funcionário): o gestor é avisado para
 *   revisar e, se for o caso, ajustar com justificativa.
 * - R1 (P0-2): devolução PARCIAL com mão de obra da OS inteira (legado, sem peça) → revisão
 *   financeira aberta (valor integral EM REVISÃO, liberação e pagamento travados). Nada é
 *   reduzido nem rateado: o gestor define o devido na resolução.
 */
export async function settleLaborOfWithdrawal(
  tx: Tx,
  actor: ActorContext,
  serviceOrderId: string,
  scope: { itemIds: readonly string[] } | 'OS_INTEIRA',
  reason: string,
) {
  const where: Prisma.ProductionPayableWhereInput =
    scope === 'OS_INTEIRA'
      ? { serviceOrderId, status: { not: 'CANCELADO' } }
      : {
          serviceOrderId,
          serviceOrderItemId: { in: [...scope.itemIds] },
          status: { not: 'CANCELADO' },
        };
  const rows = await tx.productionPayable.findMany({ where });
  const cancelled: string[] = [];
  const review: string[] = [];
  for (const p of rows) {
    await tx.$queryRaw`SELECT id FROM production_payables WHERE id = ${p.id}::uuid FOR UPDATE`;
    const cur = await tx.productionPayable.findUniqueOrThrow({ where: { id: p.id } });
    if (cur.status === 'CANCELADO') continue;
    const executed = await tx.productionTask.count({
      where: {
        serviceOrderId,
        assigneeUserId: cur.professionalUserId,
        status: 'CONCLUIDA',
        ...(cur.serviceOrderItemId ? { serviceOrderItemId: cur.serviceOrderItemId } : {}),
      },
    });
    const code = productionPayableCode(cur.number);
    if (cur.paidCents === 0 && cur.eligibleAt === null && executed === 0) {
      await tx.productionPayable.update({
        where: { id: cur.id },
        data: {
          status: 'CANCELADO',
          cancelReason: `Sem execução: ${reason}`.slice(0, 500),
          version: { increment: 1 },
        },
      });
      await financeEvent(tx, actor, {
        entityType: 'production_payable',
        entityId: cur.id,
        kind: 'CANCELADO_DEVOLUCAO',
        note: `Valor previsto cancelado (peça sem execução): ${reason}`,
        data: { agreedCents: cur.agreedCents, adjustmentsCents: cur.adjustmentsCents },
        type: EVENT_TYPES.FINANCE_COST_UPDATED,
        status: 'CANCELADO',
      });
      await audit(tx, actor, {
        action: 'finance.labor_cancelled_on_return',
        entityType: 'production_payable',
        entityId: cur.id,
        summary: `${code}: valor previsto cancelado — ${reason}.`,
        changes: { status: { from: cur.status, to: 'CANCELADO' }, reason },
      });
      cancelled.push(cur.id);
    } else {
      await financeEvent(tx, actor, {
        entityType: 'production_payable',
        entityId: cur.id,
        kind: 'REVISAO_DEVOLUCAO',
        note: `Peça devolvida/OS cancelada com ${cur.paidCents > 0 ? 'pagamento registrado' : executed ? 'trabalho executado' : 'condição já atingida'}: revisar o valor (${reason}).`,
      });
      await notifyUsersWith(
        tx,
        actor,
        'financeiro.gerenciar',
        'REVISAO_DEVOLUCAO',
        `labor-review:${cur.id}`,
        `${code}: ${reason}. Há trabalho executado ou valor devido — revise o valor de produção (nenhum desconto automático).`,
        serviceOrderId,
      );
      review.push(cur.id);
    }
  }
  if (scope !== 'OS_INTEIRA')
    review.push(...(await reviewWholeOrderLabor(tx, actor, serviceOrderId, reason)));
  return { cancelled, review };
}

/** Mão de obra da OS inteira numa devolução parcial: abre (uma) revisão financeira no escopo. */
async function reviewWholeOrderLabor(
  tx: Tx,
  actor: ActorContext,
  serviceOrderId: string,
  reason: string,
) {
  const whole = await tx.productionPayable.findMany({
    where: { serviceOrderId, serviceOrderItemId: null, status: { not: 'CANCELADO' } },
    orderBy: { id: 'asc' },
  });
  if (!whole.length) return [];
  for (const p of whole) await lockRow(tx, 'production_payables', p.id, 'Mão de obra');
  const live = await tx.productionPayable.findMany({
    where: { id: { in: whole.map((p) => p.id) }, status: { not: 'CANCELADO' } },
  });
  if (!live.length) return [];
  const existing = await openReviewOf(tx, { serviceOrderId, serviceOrderItemId: null });
  const codes = live.map((p) => productionPayableCode(p.number)).join(', ');
  if (existing) {
    // Repetição (outra devolução parcial): a revisão aberta já cobre o escopo.
    for (const p of live)
      await financeEvent(tx, actor, {
        entityType: 'production_payable',
        entityId: p.id,
        kind: 'REVISAO_DEVOLUCAO',
        note: `Nova devolução parcial (${reason}): segue na revisão ${laborReviewCode(existing.number)}.`,
      });
    return live.map((p) => p.id);
  }
  const r = await tx.laborReview.create({
    data: {
      serviceOrderId,
      serviceOrderItemId: null,
      reason:
        `Devolução parcial (${reason}) com mão de obra combinada para a OS inteira: defina o valor devido (nada foi descontado).`.slice(
          0,
          500,
        ),
      openedById: actor.userId,
    },
  });
  const code = laborReviewCode(r.number);
  await audit(tx, actor, {
    action: 'finance.labor_review_opened',
    entityType: 'labor_review',
    entityId: r.id,
    summary: `${code} aberta: ${r.reason}`,
  });
  await financeEvent(tx, actor, {
    entityType: 'labor_review',
    entityId: r.id,
    kind: 'REVISAO_ABERTA',
    note: r.reason,
    type: EVENT_TYPES.FINANCE_COST_UPDATED,
  });
  for (const p of live)
    await financeEvent(tx, actor, {
      entityType: 'production_payable',
      entityId: p.id,
      kind: 'REVISAO_DEVOLUCAO',
      note: `Devolução parcial: valor da OS inteira em revisão (${code}); nenhum desconto automático.`,
    });
  await notifyUsersWith(
    tx,
    actor,
    'financeiro.gerenciar',
    'REVISAO_DEVOLUCAO',
    `labor-review:${r.id}`,
    `${codes}: ${reason}. Mão de obra da OS inteira em revisão (${code}) — defina o valor devido (nenhum desconto automático).`,
    serviceOrderId,
  );
  return live.map((p) => p.id);
}

/** OS cancelada (inclusive por devolução total): valores de produção da OS inteira. */
onServiceOrderCancelled(async (tx, actor, serviceOrderId, reason) => {
  await settleLaborOfWithdrawal(tx, actor, serviceOrderId, 'OS_INTEIRA', `OS cancelada: ${reason}`);
});
