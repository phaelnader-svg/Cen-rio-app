import { EVENT_TYPES, HELP_KIND_LABEL, helpRequestCode, type HelpKind } from '@cenario/shared';
import type { Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import { Errors } from '../../lib/errors';
import type { ActorContext } from '../../core/types';
import { clock } from '../attendance/common';
import { notify } from '../notifications/notify';
import { helpDomainEvent, helpEvent, planningAction } from './engine';
import { lockHelpRequest } from './queue';

/**
 * Sincroniza o pedido de ajuda com a tarefa de apoio executada no tablet do ajudante.
 * A tarefa principal nunca é alterada aqui (os dois trabalham na mesma OS ao mesmo tempo).
 */
async function requestOf(tx: Tx, supportTaskId: string) {
  const r = await tx.helpRequest.findUnique({ where: { supportTaskId } });
  return r ? lockHelpRequest(tx, r.id) : null;
}

export async function supportStarted(
  tx: Tx,
  actor: ActorContext,
  supportTaskId: string,
  now: Date,
) {
  const req = await requestOf(tx, supportTaskId);
  if (!req || req.status !== 'ATRIBUIDA') return;
  const u = await tx.helpRequest.update({
    where: { id: req.id },
    data: { status: 'EM_EXECUCAO', version: { increment: 1 } },
  });
  await helpEvent(tx, actor, req, {
    kind: 'INICIADA',
    from: 'ATRIBUIDA',
    to: 'EM_EXECUCAO',
    note: `Apoio iniciado às ${now.toISOString()}`,
  });
  await helpDomainEvent(tx, actor, EVENT_TYPES.HELP_STARTED, u);
}

export async function supportCompleted(
  tx: Tx,
  actor: ActorContext,
  supportTaskId: string,
  now: Date,
) {
  const req = await requestOf(tx, supportTaskId);
  if (!req || !['ATRIBUIDA', 'EM_EXECUCAO'].includes(req.status)) return;
  const u = await tx.helpRequest.update({
    where: { id: req.id },
    data: { status: 'CONCLUIDA', completedAt: now, version: { increment: 1 } },
  });
  await helpEvent(tx, actor, req, { kind: 'CONCLUIDA', from: req.status, to: 'CONCLUIDA' });
  const helper = req.helperUserId
    ? await tx.user.findUnique({ where: { id: req.helperUserId } })
    : null;
  await audit(tx, actor, {
    action: 'help.completed',
    entityType: 'help_request',
    entityId: req.id,
    summary: `${helpRequestCode(req.number)}: apoio concluído por ${helper?.displayName ?? 'ajudante'} (a tarefa principal segue em andamento).`,
  });
  await helpDomainEvent(tx, actor, EVENT_TYPES.HELP_COMPLETED, u);
  await notify(tx, actor, [
    {
      userId: req.requesterUserId,
      kind: 'AJUDA_CONCLUIDA',
      dedupeKey: `AJUDA_CONCLUIDA:${req.id}`,
      body: `${helper?.displayName ?? 'O ajudante'} concluiu o apoio (${HELP_KIND_LABEL[req.kind as HelpKind]}, ${helpRequestCode(req.number)}). Sua tarefa continua com você.`,
      taskId: req.taskId,
    },
  ]);
}

/** O gestor cancelou a tarefa de apoio: o pedido é encerrado junto (sem tocar na principal). */
export async function supportCancelled(
  tx: Tx,
  actor: ActorContext,
  supportTaskId: string,
  reason: string,
) {
  const req = await requestOf(tx, supportTaskId);
  if (!req || !['ATRIBUIDA', 'EM_EXECUCAO'].includes(req.status)) return;
  const u = await tx.helpRequest.update({
    where: { id: req.id },
    data: {
      status: 'CANCELADA',
      cancelledAt: clock(),
      cancelledById: actor.userId,
      cancelReason: `Tarefa de apoio cancelada: ${reason}`.slice(0, 300),
      version: { increment: 1 },
    },
  });
  await helpEvent(tx, actor, req, {
    kind: 'CANCELADA',
    from: req.status,
    to: 'CANCELADA',
    note: `Tarefa de apoio cancelada pelo gestor: ${reason}`,
  });
  await helpDomainEvent(tx, actor, EVENT_TYPES.HELP_CANCELLED, u);
  await notify(tx, actor, [
    {
      userId: req.requesterUserId,
      kind: 'AJUDA_CANCELADA',
      dedupeKey: `AJUDA_CANCELADA:${req.id}`,
      body: `O apoio ${helpRequestCode(req.number)} foi cancelado pelo gestor: ${reason}`,
      taskId: req.taskId,
    },
  ]);
}

/**
 * Simplificação Fase 7: a tarefa de apoio mudou de executor (reprogramação aprovada, ausência,
 * transferência ou troca manual no planejamento). O pedido de ajuda acompanha na MESMA transação:
 * nunca fica Task.assignee = B com HelpRequest.helperUserId = A. Chamar depois de travar a tarefa.
 */
export async function supportReassigned(
  tx: Tx,
  actor: ActorContext,
  supportTaskId: string,
  toUserId: string | null,
  reason: string,
) {
  const req = await requestOf(tx, supportTaskId);
  if (!req || !['ATRIBUIDA', 'EM_EXECUCAO'].includes(req.status)) return null;
  if (req.helperUserId === toUserId) return req;
  if (!toUserId)
    throw Errors.business(
      `${helpRequestCode(req.number)} está ativo: o apoio precisa de um ajudante (cancele o pedido para retirá-lo).`,
    );
  if (toUserId === req.requesterUserId)
    throw Errors.business('Quem pediu a ajuda não pode ser o próprio ajudante.');
  const [from, to] = await Promise.all([
    req.helperUserId ? tx.user.findUnique({ where: { id: req.helperUserId } }) : null,
    tx.user.findUniqueOrThrow({ where: { id: toUserId } }),
  ]);
  const u = await tx.helpRequest.update({
    where: { id: req.id },
    data: { helperUserId: toUserId, version: { increment: 1 } },
  });
  const note = `Apoio passou de ${from?.displayName ?? 'sem ajudante'} para ${to.displayName}: ${reason}`;
  await helpEvent(tx, actor, req, { kind: 'AJUDANTE_ALTERADO', note });
  await planningAction(tx, actor, {
    kind: 'AJUDANTE_REATRIBUIDO',
    automatic: actor.userId === null,
    reason: `${helpRequestCode(req.number)}: ${note}`,
    taskId: supportTaskId,
    helpRequestId: req.id,
    before: { helperUserId: req.helperUserId },
    after: { helperUserId: toUserId },
  });
  await audit(tx, actor, {
    action: 'help.helper_changed',
    entityType: 'help_request',
    entityId: req.id,
    summary: `${helpRequestCode(req.number)}: ${note}`.slice(0, 300),
  });
  await helpDomainEvent(tx, actor, EVENT_TYPES.HELP_ASSIGNED, u);
  await notify(tx, actor, [
    {
      userId: req.requesterUserId,
      kind: 'AJUDA_ATRIBUIDA',
      dedupeKey: `AJUDA_ATRIBUIDA:${req.id}:${toUserId}`,
      body: `${to.displayName} vai ajudar agora (${HELP_KIND_LABEL[req.kind as HelpKind]}, ${helpRequestCode(req.number)}).`,
      taskId: req.taskId,
    },
  ]);
  return u;
}
