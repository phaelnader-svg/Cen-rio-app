import { EVENT_TYPES, HELP_KIND_LABEL, helpRequestCode, type HelpKind } from '@cenario/shared';
import type { Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { clock } from '../attendance/common';
import { notify } from '../notifications/notify';
import { helpDomainEvent, helpEvent } from './engine';
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
