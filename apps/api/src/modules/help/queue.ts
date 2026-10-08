import {
  EVENT_TYPES,
  HELP_KIND_LABEL,
  HELP_KIND_SKILL,
  helpRequestCode,
  pickCandidate,
  taskCode,
  type HelpKind,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import { Errors } from '../../lib/errors';
import type { ActorContext } from '../../core/types';
import { clock, notifyManagers } from '../attendance/common';
import { notify } from '../notifications/notify';
import { domainTaskEvent, lockTasks, taskEvent } from '../production/common';
import {
  SYSTEM,
  WAIT_ALERT_MINUTES,
  assignTo,
  evaluateCandidates,
  helpDomainEvent,
  helpEvent,
  planningAction,
  reasonText,
  type HelpRow,
} from './engine';
import { obsoleteProposals, proposeUrgentInterruption } from './reschedule';

/** Serializa as atribuições (duas solicitações simultâneas nunca pegam o mesmo ajudante). */
export async function lockAssignments(tx: Tx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('help-assignments'))`;
}

export async function lockHelpRequest(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM help_requests WHERE id = ${id}::uuid FOR UPDATE`;
  return tx.helpRequest.findUnique({ where: { id } });
}

/**
 * Cancela uma solicitação aberta (pelo solicitante, pelo gestor ou porque a tarefa
 * principal foi encerrada). Se já havia tarefa de apoio ainda não iniciada, ela é
 * cancelada junto; apoio em execução não é interrompido.
 */
export async function cancelHelp(
  tx: Tx,
  actor: ActorContext,
  req: HelpRow,
  reason: string,
  notifyHelper = true,
) {
  if (!['PENDENTE', 'ATRIBUIDA', 'ESCALADA'].includes(req.status)) return req;
  const now = clock();
  if (req.supportTaskId) {
    await lockTasks(tx, [req.supportTaskId]);
    const s = await tx.productionTask.findUniqueOrThrow({ where: { id: req.supportTaskId } });
    if (s.status === 'LIBERADA' || s.status === 'PROGRAMADA' || s.status === 'BLOQUEADA') {
      const u = await tx.productionTask.update({
        where: { id: s.id },
        data: { status: 'CANCELADA', cancelReason: reason, version: { increment: 1 } },
      });
      await taskEvent(tx, actor, null, s, {
        kind: 'CANCELADA',
        from: s.status,
        to: 'CANCELADA',
        note: reason,
      });
      await domainTaskEvent(tx, actor, EVENT_TYPES.PRODUCTION_TASK_CANCELLED, u);
    }
  }
  const updated = await tx.helpRequest.update({
    where: { id: req.id },
    data: {
      status: 'CANCELADA',
      cancelledAt: now,
      cancelledById: actor.userId,
      cancelReason: reason.slice(0, 300),
      version: { increment: 1 },
    },
  });
  await helpEvent(tx, actor, req, {
    kind: 'CANCELADA',
    from: req.status,
    to: 'CANCELADA',
    note: reason,
  });
  // Propostas pendentes ligadas ao pedido perdem o efeito.
  const proposals = await tx.rescheduleProposal.findMany({
    where: { helpRequestId: req.id, status: 'PENDENTE' },
  });
  for (const p of proposals) {
    await tx.rescheduleProposal.update({
      where: { id: p.id },
      data: {
        status: 'OBSOLETA',
        decidedAt: now,
        decisionNote: 'Pedido de ajuda cancelado.',
        version: { increment: 1 },
      },
    });
    await planningAction(tx, actor, {
      kind: 'PROPOSTA_OBSOLETA',
      automatic: true,
      reason: `Pedido ${helpRequestCode(req.number)} cancelado: proposta sem efeito.`,
      proposalId: p.id,
      helpRequestId: req.id,
    });
  }
  await audit(tx, actor, {
    action: 'help.cancelled',
    entityType: 'help_request',
    entityId: req.id,
    summary: `${helpRequestCode(req.number)} cancelada: ${reason}`,
  });
  await helpDomainEvent(tx, actor, EVENT_TYPES.HELP_CANCELLED, updated);
  const kind = HELP_KIND_LABEL[req.kind as HelpKind];
  await notify(tx, actor, [
    {
      userId: req.requesterUserId,
      kind: 'AJUDA_CANCELADA',
      dedupeKey: `AJUDA_CANCELADA:${req.id}`,
      body: `Pedido ${helpRequestCode(req.number)} (${kind}) cancelado: ${reason}`,
      taskId: req.taskId,
    },
    ...(notifyHelper && req.helperUserId
      ? [
          {
            userId: req.helperUserId,
            kind: 'AJUDA_CANCELADA' as const,
            dedupeKey: `AJUDA_CANCELADA:${req.id}`,
            body: `O apoio ${helpRequestCode(req.number)} (${kind}) não é mais necessário.`,
            taskId: req.supportTaskId,
          },
        ]
      : []),
  ]);
  return updated;
}

/** Tarefa principal encerrada: pedidos ainda não iniciados perdem o sentido. */
export async function cancelHelpForClosedTask(tx: Tx, actor: ActorContext, taskId: string) {
  const open = await tx.helpRequest.findMany({
    where: { taskId, status: { in: ['PENDENTE', 'ATRIBUIDA', 'ESCALADA'] } },
  });
  for (const r of open) {
    const locked = await lockHelpRequest(tx, r.id);
    if (locked) await cancelHelp(tx, actor, locked, 'a tarefa principal foi encerrada.');
  }
}

/**
 * Tenta atribuir um ajudante a uma solicitação pendente. Sem candidato:
 * - normal: fica na fila (avisa o solicitante uma vez);
 * - urgente: se alguém só está ocupado com tarefa não crítica, encaminha ao gestor a
 *   proposta de interromper (nada é interrompido automaticamente).
 */
export async function tryAssign(tx: Tx, actor: ActorContext, requestId: string, now = clock()) {
  await lockAssignments(tx);
  const req = await lockHelpRequest(tx, requestId);
  if (!req || req.status !== 'PENDENTE') return req;
  const task = await tx.productionTask.findUniqueOrThrow({ where: { id: req.taskId } });
  if (task.status === 'CONCLUIDA' || task.status === 'CANCELADA') {
    return cancelHelp(tx, SYSTEM, req, 'a tarefa principal foi encerrada.');
  }
  const { candidates, interruptible } = await evaluateCandidates(
    tx,
    {
      requesterUserId: req.requesterUserId,
      skill: HELP_KIND_SKILL[req.kind as HelpKind],
      estimatedMinutes: req.estimatedMinutes,
    },
    now,
  );
  const evaluation = { at: now.toISOString(), candidates };
  const best = pickCandidate(candidates);
  if (best) {
    const others = candidates.filter((c) => c.userId !== best.userId);
    const note = `Automático: ${best.name} escolhido (impacto ${best.score}${
      others.length
        ? `; ${others.map((c) => `${c.name}: ${c.eligible ? `impacto ${c.score}` : reasonText(c)}`).join('; ')}`
        : ''
    }).`;
    const assigned = await assignTo(
      tx,
      SYSTEM,
      req,
      best.userId,
      best.name,
      now,
      evaluation,
      note,
      true,
    );
    // Fase 9: a proposta de conflito (risco de atraso) perde o efeito com a atribuição.
    await obsoleteProposals(
      tx,
      SYSTEM,
      { helpRequestId: req.id },
      `${helpRequestCode(req.number)} atribuída automaticamente a ${best.name}.`,
    );
    return assigned;
  }
  // Urgente: encaminha ao gestor uma única vez (se ele rejeitar, o pedido segue na fila).
  const escalatedBefore = await tx.rescheduleProposal.count({ where: { helpRequestId: req.id } });
  if (req.urgent && interruptible.length && !escalatedBefore) {
    return proposeUrgentInterruption(tx, SYSTEM, req, interruptible, evaluation);
  }
  const waited = await tx.helpRequestEvent.findFirst({
    where: { helpRequestId: req.id, kind: 'EM_ESPERA' },
  });
  if (!waited) {
    const why =
      candidates.map((c) => `${c.name} (${reasonText(c)})`).join('; ') ||
      'nenhum ajudante cadastrado';
    await helpEvent(tx, SYSTEM, req, {
      kind: 'EM_ESPERA',
      note: `Sem ajudante disponível: ${why}.`,
      evaluation,
    });
    await planningAction(tx, SYSTEM, {
      kind: 'AJUDA_EM_ESPERA',
      automatic: true,
      reason: `${helpRequestCode(req.number)} aguardando ajudante disponível: ${why}.`,
      helpRequestId: req.id,
      taskId: req.taskId,
    });
    await helpDomainEvent(tx, SYSTEM, EVENT_TYPES.HELP_QUEUED, req);
    await notify(tx, SYSTEM, [
      {
        userId: req.requesterUserId,
        kind: 'AJUDA_EM_ESPERA',
        dedupeKey: `AJUDA_EM_ESPERA:${req.id}`,
        body: `Nenhum ajudante disponível agora para ${HELP_KIND_LABEL[req.kind as HelpKind]}. Seu pedido ${helpRequestCode(req.number)} está na fila e será atribuído assim que alguém ficar livre.`,
        taskId: req.taskId,
      },
    ]);
  }
  return req;
}

let running: Promise<number> | null = null;

/**
 * Reavalia a fila (urgentes primeiro, depois por ordem de chegada) e avisa o gestor de
 * pedidos esperando além do limite. Chamado após mudanças de disponibilidade (chegada,
 * conclusão, pausa, encerramento) e periodicamente; idempotente.
 */
export function processHelpQueue(prisma: PrismaClient, now?: Date): Promise<number> {
  // Execuções concorrentes no mesmo processo se encadeiam (o lock do banco protege entre processos).
  const run = (running ?? Promise.resolve(0))
    .catch(() => 0)
    .then(() => runQueue(prisma, now ?? clock()));
  running = run;
  return run;
}

async function runQueue(prisma: PrismaClient, now: Date) {
  const pending = await prisma.helpRequest.findMany({
    where: { status: 'PENDENTE' },
    orderBy: [{ urgent: 'desc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
  let assigned = 0;
  for (const p of pending) {
    const r = await prisma.$transaction((tx) => tryAssign(tx, SYSTEM, p.id, now));
    if (r?.status === 'ATRIBUIDA') assigned += 1;
  }
  // Risco de atraso: alerta único ao gestor por pedido.
  const waiting = await prisma.helpRequest.findMany({
    where: { status: 'PENDENTE', delayAlertedAt: null },
  });
  for (const w of waiting) {
    const limit = w.urgent ? WAIT_ALERT_MINUTES.urgent : WAIT_ALERT_MINUTES.normal;
    const minutes = Math.floor((now.getTime() - w.createdAt.getTime()) / 60_000);
    if (minutes < limit) continue;
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.helpRequest.updateMany({
        where: { id: w.id, delayAlertedAt: null, status: 'PENDENTE' },
        data: { delayAlertedAt: now },
      });
      if (!fresh.count) return;
      const requester = await tx.user.findUniqueOrThrow({ where: { id: w.requesterUserId } });
      const task = await tx.productionTask.findUniqueOrThrow({ where: { id: w.taskId } });
      await helpEvent(tx, SYSTEM, w, {
        kind: 'RISCO_ATRASO',
        note: `Aguardando há ${minutes} min (limite ${limit} min): gestor avisado.`,
      });
      // Fase 9: falta de ajudante com risco de atraso → proposta de CONFLITO ao gestor,
      // quando alguém poderia ser liberado (nada é interrompido sem aprovação).
      const locked = await lockHelpRequest(tx, w.id);
      if (
        locked?.status === 'PENDENTE' &&
        !(await tx.rescheduleProposal.count({ where: { helpRequestId: w.id } }))
      ) {
        const { candidates, interruptible } = await evaluateCandidates(
          tx,
          {
            requesterUserId: w.requesterUserId,
            skill: HELP_KIND_SKILL[w.kind as HelpKind],
            estimatedMinutes: w.estimatedMinutes,
          },
          now,
        );
        if (interruptible.length)
          await proposeUrgentInterruption(
            tx,
            SYSTEM,
            locked,
            interruptible,
            { at: now.toISOString(), candidates },
            'ATRASO',
          );
      }
      await notifyManagers(
        tx,
        SYSTEM,
        'AJUDA_EM_ESPERA',
        `AJUDA_RISCO:${w.id}`,
        `${helpRequestCode(w.number)} de ${requester.displayName} (${HELP_KIND_LABEL[w.kind as HelpKind]}${w.urgent ? ', urgente' : ''}) em ${taskCode(task.number)} aguarda ajudante há ${minutes} min — risco de atraso.`,
        w.taskId,
      );
    });
  }
  return assigned;
}

const IMPOSSIBLE = ['SEM_COMPETENCIA', 'NAO_CONFIRMOU', 'AUSENTE', 'EXTERNO', 'ENCERRADO'];

/**
 * Fase 9 — escolha manual do ajudante pelo gestor. Atribuições impossíveis (sem competência,
 * ausente, sem chegada, externo, encerrado) são recusadas; conflito (ocupado, tarefa
 * importante, agenda) exige aprovação explícita e o impacto fica registrado. O histórico
 * guarda a avaliação, como na escolha automática.
 */
export async function manualAssign(
  tx: Tx,
  actor: ActorContext,
  requestId: string,
  input: { helperUserId: string; confirmConflict: boolean; note?: string | null; version?: number },
  now = clock(),
) {
  await lockAssignments(tx);
  const req = await lockHelpRequest(tx, requestId);
  if (!req) throw Errors.notFound('Pedido de ajuda');
  if (input.version !== undefined && req.version !== input.version)
    throw Errors.versionConflict(req.version);
  if (req.status !== 'PENDENTE' && req.status !== 'ESCALADA')
    throw Errors.business('Este pedido já tem ajudante ou foi encerrado.');
  const { candidates } = await evaluateCandidates(
    tx,
    {
      requesterUserId: req.requesterUserId,
      skill: HELP_KIND_SKILL[req.kind as HelpKind],
      estimatedMinutes: req.estimatedMinutes,
    },
    now,
  );
  const c = candidates.find((x) => x.userId === input.helperUserId);
  if (!c) throw Errors.business('Escolha alguém da equipe da oficina (não quem pediu).');
  const impossible = c.reasons.filter((r) => IMPOSSIBLE.includes(r));
  if (impossible.length)
    throw Errors.business(
      `${c.name} não pode ajudar agora: ${reasonText({ ...c, reasons: impossible })}.`,
    );
  const conflicts = c.reasons.filter((r) => !IMPOSSIBLE.includes(r));
  if (conflicts.length && !input.confirmConflict)
    throw Errors.conflict(
      `${c.name} tem conflito: ${reasonText({ ...c, reasons: conflicts })}. Confirme para atribuir mesmo assim.`,
      { reasons: conflicts, notes: c.notes },
    );
  const impact = conflicts.length
    ? ` Conflito aprovado: ${reasonText({ ...c, reasons: conflicts })}${c.notes.length ? ` (${c.notes.join('; ')})` : ''}${input.note ? ` — ${input.note}` : ''}.`
    : input.note
      ? ` ${input.note}`
      : '';
  const note = `Manual: gestor escolheu ${c.name}.${impact}`;
  const assigned = await assignTo(
    tx,
    actor,
    req,
    c.userId,
    c.name,
    now,
    { at: now.toISOString(), candidates, manual: true },
    note,
    false,
  );
  await obsoleteProposals(
    tx,
    actor,
    { helpRequestId: req.id },
    `${helpRequestCode(req.number)}: ajudante escolhido manualmente (${c.name}).`,
  );
  return assigned;
}
