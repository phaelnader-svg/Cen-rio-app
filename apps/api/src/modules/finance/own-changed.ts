import { EVENT_TYPES } from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';

type Db = Tx | PrismaClient;

/**
 * Rodada 2 (F8-15b) — aviso ao vivo "seus ganhos mudaram" (`finance.own_changed`).
 *
 * - Audiência `user:<id>`: só as sessões do próprio profissional (painel ou tablet) recebem; a
 *   regra de audiência do canal é a de sempre (nada de F1-09 é afrouxado).
 * - SEM valores no payload (só o motivo genérico): o Meus Ganhos aberto recarrega pela API, que
 *   continua exigindo o desbloqueio por PIN (D12) e só devolve os valores do próprio usuário.
 * - Um aviso por pessoa por transação (várias mudanças na mesma operação geram um só).
 *
 * Disparo centralizado: `financeEvent` (histórico financeiro canônico, usado por toda mutação de
 * mão de obra, viagem, conta a pagar da viagem, pagamento/estorno, confirmação, exceção e pedido
 * de alteração) chama `notifyOwnersOf`. Os poucos caminhos que mudam o Meus Ganhos sem passar por
 * ele chamam `notifyOwnChanged` diretamente (recebedor da logística, participantes da viagem,
 * pedido obsoleto, etapa da peça que muda a situação "aguardando qualidade").
 */
const sent = new WeakMap<object, Set<string>>();

export async function notifyOwnChanged(
  tx: Tx,
  actor: ActorContext,
  userIds: readonly (string | null | undefined)[],
  reason: string,
) {
  let done = sent.get(tx);
  if (!done) sent.set(tx, (done = new Set()));
  for (const userId of new Set(userIds)) {
    if (!userId || done.has(userId)) continue;
    done.add(userId);
    await appendEvent(tx, actor, {
      type: EVENT_TYPES.FINANCE_OWN_CHANGED,
      aggregateType: 'user',
      aggregateId: userId,
      payload: { reason },
      audience: `user:${userId}`,
    });
  }
}

/** Quem vê o registro financeiro no próprio Meus Ganhos (mesma atribuição do fechamento). */
export async function ownersOf(db: Db, entityType: string, entityId: string): Promise<string[]> {
  switch (entityType) {
    case 'production_payable': {
      const p = await db.productionPayable.findUnique({
        where: { id: entityId },
        select: { professionalUserId: true },
      });
      return p ? [p.professionalUserId] : [];
    }
    case 'logistics_cost': {
      const c = await db.logisticsCost.findUnique({
        where: { id: entityId },
        select: { status: true, payeeUserId: true, payableId: true },
      });
      if (!c) return [];
      // Mesma atribuição de `buildClosingItems`: previsto ou devido sem conta a pagar aparece
      // para o recebedor configurado; com conta, para o recebedor da viagem.
      if (c.status === 'PREVISTO' || (c.status === 'DEVIDO' && !c.payableId))
        return configuredPayee(db);
      return c.payeeUserId ? [c.payeeUserId] : [];
    }
    case 'account_payable': {
      const c = await db.logisticsCost.findFirst({
        where: { payableId: entityId },
        select: { payeeUserId: true },
      });
      return c?.payeeUserId ? [c.payeeUserId] : [];
    }
    case 'weekly_closing_confirmation': {
      const r = await db.weeklyClosingConfirmation.findUnique({
        where: { id: entityId },
        select: { beneficiaryUserId: true },
      });
      return r ? [r.beneficiaryUserId] : [];
    }
    case 'value_change_request': {
      const r = await db.valueChangeRequest.findUnique({
        where: { id: entityId },
        select: { beneficiaryUserId: true },
      });
      return r ? [r.beneficiaryUserId] : [];
    }
    case 'labor_review': {
      // Revisão aberta/resolvida muda a situação das obrigações do escopo (OS ou peça).
      const r = await db.laborReview.findUnique({
        where: { id: entityId },
        select: { serviceOrderId: true, serviceOrderItemId: true },
      });
      return r ? laborOwners(db, r.serviceOrderId, r.serviceOrderItemId) : [];
    }
    default:
      return [];
  }
}

export async function laborOwners(
  db: Db,
  serviceOrderId: string,
  serviceOrderItemId?: string | null,
) {
  const rows = await db.productionPayable.findMany({
    where: {
      serviceOrderId,
      status: { not: 'CANCELADO' },
      ...(serviceOrderItemId ? { serviceOrderItemId } : {}),
    },
    select: { professionalUserId: true },
  });
  return [...new Set(rows.map((r) => r.professionalUserId))];
}

export async function configuredPayee(db: Db) {
  const s = await db.companySettings.findUnique({
    where: { id: 1 },
    select: { logisticsPayeeUserId: true },
  });
  return s?.logisticsPayeeUserId ? [s.logisticsPayeeUserId] : [];
}

export async function notifyOwnersOf(
  tx: Tx,
  actor: ActorContext,
  entityType: string,
  entityId: string,
) {
  const owners = await ownersOf(tx, entityType, entityId);
  if (owners.length) await notifyOwnChanged(tx, actor, owners, entityType);
}
