import { EVENT_TYPES, productionPayableCode } from '@cenario/shared';
import type { Prisma, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { onServiceOrderCancelled } from '../production/cancellation';
import { notifyUsersWith } from '../quality/common';
import { financeEvent } from './common';

/**
 * Fase 12 — valores de produção de peças devolvidas (ou de OS cancelada).
 *
 * - Sem execução, sem pagamento e sem condição atingida → o valor previsto é cancelado com
 *   justificativa registrada (histórico financeiro + auditoria). Nada é apagado.
 * - Com trabalho executado, condição já atingida ou pagamento feito → nada é alterado
 *   automaticamente (nenhum desconto em pagamento de funcionário): o gestor é avisado para
 *   revisar e, se for o caso, ajustar com justificativa.
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
  return { cancelled, review };
}

/** OS cancelada (inclusive por devolução total): valores de produção da OS inteira. */
onServiceOrderCancelled(async (tx, actor, serviceOrderId, reason) => {
  await settleLaborOfWithdrawal(tx, actor, serviceOrderId, 'OS_INTEIRA', `OS cancelada: ${reason}`);
});
