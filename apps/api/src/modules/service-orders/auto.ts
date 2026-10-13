import type { ServiceOrder, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { orderCode, receiptCode, serviceOrderCode } from '../commercial/common';
import { itemAllocations } from '../commercial/status';
import { laborEligible } from '../orders/planned-intent';
import { loadTeam, upholstererOk, type Team } from '../production/distribution';
import { createServiceOrder, type NewServiceOrderInput } from './service';

/** Sem intenção prevista, a geração automática não usa nenhuma permissão extra. */
const NO_EXTRA_PERMISSIONS = { has: () => false };
/**
 * Com intenção prevista no fechamento: aplicar o titular e a mão de obra JÁ AUTORIZADOS ali (por
 * quem tinha `producao.planejar` / `financeiro.gerenciar`). Nada além disso é concedido.
 */
const PLANNED_INTENT_PERMISSIONS = {
  has: (p: string) =>
    p === 'producao.planejar' || p === 'financeiro.ver' || p === 'financeiro.gerenciar',
};

/**
 * Simplificação Fase 2 (decisão D1): a OS nasce AUTOMATICAMENTE quando a chegada física das
 * peças é confirmada — nunca no fechamento comercial. Regra determinística e idempotente:
 *
 * - só para pedidos do fluxo "Novo serviço" (`auto_service_order`); pedidos antigos seguem o
 *   fluxo anterior (OS criada manualmente);
 * - UMA OS por recebimento, contendo SOMENTE as peças desse recebimento ainda sem OS
 *   (quantidade = min(recebida nesta linha, recebida − devolvida − já em OS));
 * - repetir a chamada para o mesmo recebimento devolve a OS já gerada (índice único
 *   `service_orders.source_receipt_id` garante no banco);
 * - recebimento parcial: só as peças que chegaram entram; as ausentes continuam no pedido e
 *   ganham a própria OS quando chegarem (novo recebimento → nova OS);
 * - peça já incluída manualmente em outra OS não é duplicada;
 * - sem planejamento e sem tarefas: a OS fica disponível para o planejamento (Fase 4). A
 *   receita continua a do pedido (rateio proporcional existente);
 * - titular e mão de obra PREVISTOS no fechamento (estabilização da Fase 2) viram titular da
 *   peça e mão de obra combinada = valor por unidade × quantidade desta OS (chegadas parciais
 *   somam o total previsto, sem duplicar). Se o titular previsto não puder mais ser titular
 *   (inativo, sem produção), a OS nasce SEM titular e sem mão de obra — a chegada nunca é
 *   bloqueada —, com aviso na OS e na auditoria; idem só para a mão de obra quando o titular
 *   deixou de ser tapeceiro principal.
 *
 * Deve ser chamada DENTRO da transação do recebimento, com o pedido e as peças já travados.
 */
export async function autoServiceOrderForReceipt(
  tx: Tx,
  actor: ActorContext,
  receiptId: string,
): Promise<ServiceOrder | null> {
  const receipt = await tx.receipt.findUniqueOrThrow({
    where: { id: receiptId },
    include: { lines: true, order: { include: { items: true } } },
  });
  const order = receipt.order;
  if (!order.autoServiceOrder || order.status === 'CANCELADO') return null;
  const existing = await tx.serviceOrder.findUnique({ where: { sourceReceiptId: receipt.id } });
  if (existing) return existing;

  const alloc = await itemAllocations(tx, order.id);
  const items: NewServiceOrderInput['items'] = [];
  const skipped: { description: string; userId: string; what: 'TITULAR' | 'MAO_DE_OBRA' }[] = [];
  let team: Team | null = null;
  // Ordem determinística: a mesma das peças no serviço fechado.
  for (const oi of [...order.items].sort((a, b) => a.position - b.position)) {
    const line = receipt.lines.find((l) => l.orderItemId === oi.id);
    if (!line) continue;
    const free = oi.receivedQuantity - oi.returnedQuantity - alloc.inServiceOrders(oi.id);
    const quantity = Math.min(line.quantity, free);
    if (quantity <= 0) continue;
    let upholstererUserId: string | null = null;
    let labor: NewServiceOrderInput['items'][number]['labor'] = null;
    const planned = oi.plannedUpholstererUserId;
    if (planned) {
      team ??= await loadTeam(tx);
      if (!upholstererOk(team, planned)) {
        skipped.push({ description: oi.description, userId: planned, what: 'TITULAR' });
      } else {
        upholstererUserId = planned;
        if (oi.plannedLaborUnitCents) {
          if (laborEligible(team, planned))
            labor = {
              agreedCents: oi.plannedLaborUnitCents * quantity,
              eligibility: 'QUALIDADE_APROVADA',
              service: null,
              notes: `Prevista no fechamento: ${quantity} × ${(oi.plannedLaborUnitCents / 100).toFixed(2).replace('.', ',')} por unidade.`,
            };
          else skipped.push({ description: oi.description, userId: planned, what: 'MAO_DE_OBRA' });
        }
      }
    }
    items.push({
      orderItemId: oi.id,
      quantity,
      serviceType: oi.serviceType ?? 'OUTRO',
      description: oi.description,
      fabricName: oi.fabricName,
      fabricColor: oi.fabricColor,
      fabricReference: oi.fabricReference,
      foamSpecs: null,
      technicalNotes: oi.technicalNotes ?? oi.notes,
      upholstererUserId,
      labor,
    });
  }
  if (!items.length) return null;

  const rc = receiptCode(receipt.number);
  const names = new Map(
    (
      await tx.user.findMany({
        where: { id: { in: skipped.map((x) => x.userId) } },
        select: { id: true, displayName: true },
      })
    ).map((u) => [u.id, u.displayName]),
  );
  const warnings = skipped.map((x) =>
    x.what === 'TITULAR'
      ? `"${x.description}": titular previsto (${names.get(x.userId)}) indisponível na chegada — defina o titular no planejamento.`
      : `"${x.description}": mão de obra prevista não lançada — ${names.get(x.userId)} não é mais tapeceiro principal.`,
  );
  const so = await createServiceOrder(
    tx,
    actor,
    items.some((i) => i.upholstererUserId) ? PLANNED_INTENT_PERMISSIONS : NO_EXTRA_PERMISSIONS,
    {
      orderId: order.id,
      technicalInstructions: order.technicalNotes,
      notes: [`Gerada automaticamente na chegada das peças (${rc}).`, ...warnings]
        .join('\n')
        .slice(0, 2000), // limite da coluna: o aviso nunca pode impedir a chegada
      promisedDate: order.promisedDate ? order.promisedDate.toISOString().slice(0, 10) : null,
      priority: 'NORMAL',
      technicalLeadId: null,
      items,
    },
    {
      sourceReceiptId: receipt.id,
      locked: true,
      summary: (code) =>
        `OS ${code} gerada automaticamente pelo recebimento ${rc} do pedido ${orderCode(order.number)}.`,
    },
  );
  if (skipped.length)
    await audit(tx, actor, {
      action: 'service_order.planned_intent_not_applied',
      entityType: 'service_order',
      entityId: so.id,
      summary: `OS ${serviceOrderCode(so.number)}: intenção do fechamento não aplicada em ${skipped.length} peça(s).`,
      changes: { skipped: skipped.map((x) => ({ description: x.description, what: x.what })) },
    });
  return so;
}
