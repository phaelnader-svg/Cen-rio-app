/**
 * Propostas dos agentes envelhecem: a OS foi planejada, o estoque foi reservado, a compra saiu.
 * Antes de mostrar e no momento da aprovação, cada proposta pendente é conferida contra os
 * registros atuais; se não vale mais, vira OBSOLETA com o motivo e a ação atual da OS.
 */
import type { AiAgentProposal, PrismaClient, Tx } from '@cenario/db';
import { FULFILLMENT_STAGE_LABEL, type FulfillmentStage } from '@cenario/shared';
import { serviceOrderCode } from '../commercial/common';
import { orderRevenue } from '../finance/revenue';

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
  // Tarefas do Atendimento (escritório trabalhando sozinho, 2026-11-25).
  if (pl.task === 'AGENDAR_ENTREGA') {
    const ids = ((pl.itemIds as string[] | undefined) ?? []).filter(Boolean);
    const ready = await db.serviceOrderItem.count({
      where: { id: { in: ids }, fulfillmentStage: 'PRONTA_ENTREGA' },
    });
    return ready === ids.length && ids.length
      ? null
      : 'A peça já tem entrega marcada ou não está mais pronta na expedição.';
  }
  if (pl.task === 'CONFIRMAR_RETIRADA') {
    const r = await db.pickupRequest.findUnique({ where: { id: String(pl.pickupId ?? '') } });
    if (!r || r.status !== 'AGENDADA') return 'A retirada não está mais agendada.';
    if (r.scheduledDate?.toISOString().slice(0, 10) !== pl.date) return 'A retirada mudou de dia.';
    return null;
  }
  if (pl.task === 'CONFIRMAR_ENTREGA') {
    const d = await db.delivery.findUnique({ where: { id: String(pl.deliveryId ?? '') } });
    if (!d || d.status !== 'AGENDADA') return 'A entrega não está mais agendada.';
    if (d.scheduledDate.toISOString().slice(0, 10) !== pl.date) return 'A entrega mudou de dia.';
    return null;
  }
  if (pl.task === 'PEDIR_AVALIACAO' || pl.task === 'CLIENTE_ANTIGO') return null;
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
  // Pedido ao fornecedor: todos os itens já foram comprados, chegaram ou saíram da lista.
  if (p.kind === 'PEDIR_FORNECEDOR') {
    const ids = ((pl.materialIds as string[] | undefined) ?? []).filter(Boolean);
    const left = await db.serviceOrderMaterial.count({
      where: {
        id: { in: ids },
        removedAt: null,
        purchased: false,
        available: false,
        serviceOrder: { status: 'ABERTA' },
      },
    });
    return left
      ? null
      : 'Os itens deste pedido já foram comprados ou não estão mais na lista da OS.';
  }
  // Cobrança: o recebível foi pago ou cancelado.
  if (p.kind === 'COBRAR_CLIENTE') {
    const r = await db.customerReceivable.findUnique({
      where: { id: String(pl.receivableId ?? '') },
    });
    if (!r || !['ABERTO', 'PARCIAL'].includes(r.status))
      return 'Este valor já foi recebido ou cancelado.';
    return null;
  }
  // Retorno de orçamento: o cliente já fechou (virou OS) ou o orçamento foi apagado.
  if (p.kind === 'ENVIAR_MENSAGEM' && pl.quoteId) {
    const q = await db.quote.findUnique({ where: { id: String(pl.quoteId) } });
    if (!q || q.deletedAt) return 'O orçamento foi apagado.';
    if (q.workOrder) return `O orçamento nº ${q.number} já virou ordem de serviço.`;
    return null;
  }
  // Aviso de peça pronta: a OS saiu da expedição.
  if (p.kind === 'ENVIAR_MENSAGEM' && pl.serviceOrderId) {
    const so = await db.serviceOrder.findUnique({
      where: { id: String(pl.serviceOrderId) },
      include: { items: { select: { fulfillmentStage: true } } },
    });
    if (!so || so.status !== 'ABERTA') return 'A OS não está mais aberta.';
    if (!so.items.some((i) => i.fulfillmentStage === 'PRONTA_ENTREGA'))
      return `${serviceOrderCode(so.number)} ${await currentActionOf(db, so.id)}.`;
    return null;
  }
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
