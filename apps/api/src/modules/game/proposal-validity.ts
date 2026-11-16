/**
 * Propostas dos agentes envelhecem: a OS foi planejada, o estoque foi reservado, a compra saiu.
 * Antes de mostrar e no momento da aprovação, cada proposta pendente é conferida contra os
 * registros atuais; se não vale mais, vira OBSOLETA com o motivo e a ação atual da OS.
 */
import type { AiAgentProposal, PrismaClient, Tx } from '@cenario/db';
import { FULFILLMENT_STAGE_LABEL, type FulfillmentStage } from '@cenario/shared';
import { serviceOrderCode } from '../commercial/common';
import { orderRevenue } from '../finance/revenue';
import { num } from './common';

type Db = PrismaClient | Tx;
const money = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Ação atual de uma OS já planejada (para explicar por que a proposta antiga caducou). */
async function currentActionOf(db: Db, serviceOrderId: string) {
  const so = await db.serviceOrder.findUnique({
    where: { id: serviceOrderId },
    include: {
      items: { select: { fulfillmentStage: true } },
      productionTasks: {
        where: {
          status: { in: ['EM_EXECUCAO', 'LIBERADA', 'PROGRAMADA', 'BLOQUEADA', 'PAUSADA'] },
        },
        include: { assignee: { select: { displayName: true } } },
        orderBy: { sequence: 'asc' },
      },
    },
  });
  if (!so) return 'a OS não existe mais';
  const stages = so.items.map((i) => i.fulfillmentStage);
  if (
    stages.some((s) =>
      [
        'PRONTA_ENTREGA',
        'ENTREGA_AGENDADA',
        'BLOQUEIO_EXPEDICAO',
        'AGUARDANDO_EMBALAGEM',
        'EM_EMBALAGEM',
      ].includes(s),
    )
  ) {
    const rev = await orderRevenue(db, so.orderId);
    const open = Math.max(0, (rev.finalCents ?? 0) - rev.receivedCents);
    const stage =
      FULFILLMENT_STAGE_LABEL[stages.find((s) => s !== 'EM_PRODUCAO') as FulfillmentStage] ??
      'expedição';
    return `está em "${stage}": agora é ${stages.includes('ENTREGA_AGENDADA') ? 'acompanhar a entrega agendada' : 'agendar a entrega'}${open > 0 ? ` e cobrar o saldo de ${money(open)}` : ' (pedido quitado)'}`;
  }
  const t = so.productionTasks[0];
  if (t)
    return `já está planejada: ${t.title} ${t.status === 'EM_EXECUCAO' ? 'em execução' : 'na fila'} com ${t.assignee?.displayName ?? 'sem responsável'}`;
  return 'já está planejada';
}

export async function obsoleteReason(db: Db, p: AiAgentProposal): Promise<string | null> {
  const pl = (p.payload ?? {}) as Record<string, unknown>;
  if (p.kind === 'PLANEJAR_OS') {
    const id = String(pl.serviceOrderId ?? '');
    const so = await db.serviceOrder.findUnique({
      where: { id },
      include: { _count: { select: { productionPlanItems: true, productionTasks: true } } },
    });
    if (!so) return 'A OS não existe mais.';
    if (so.status !== 'ABERTA')
      return `${serviceOrderCode(so.number)} não está mais aberta (${so.status.toLowerCase()}).`;
    if (so._count.productionPlanItems || so._count.productionTasks)
      return `${serviceOrderCode(so.number)} ${await currentActionOf(db, so.id)}.`;
    return null;
  }
  // O processo formal de compras e as necessidades de material saíram do Cenário (remoção de
  // módulos, 2026-11): propostas antigas de reserva ou compra não têm mais onde ser aplicadas.
  if (p.kind === 'RESERVAR_ESTOQUE' || p.kind === 'CRIAR_COMPRA')
    return 'Compras e necessidades de material não fazem mais parte do Cenário.';
  return null;
}

/** Marca como OBSOLETA (com o motivo) as propostas pendentes que não valem mais. */
export async function refreshPending(db: Db, agentId: string) {
  const pending = await db.aiAgentProposal.findMany({ where: { agentId, status: 'PENDENTE' } });
  let changed = 0;
  for (const p of pending) {
    const why = await obsoleteReason(db, p);
    if (!why) continue;
    await db.aiAgentProposal.updateMany({
      where: { id: p.id, status: 'PENDENTE' },
      data: {
        status: 'OBSOLETA',
        decidedAt: new Date(),
        decisionNote: `Desatualizada: ${why}`.slice(0, 500),
      },
    });
    changed++;
  }
  return changed;
}
