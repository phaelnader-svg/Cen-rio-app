import {
  PRINCIPAL_ACTIVITIES,
  pickCandidate,
  proposalCode,
  taskCode,
  type CandidateEvaluation,
  type ProposalAlternative,
  type Skill,
  type TransferRequestInput,
} from '@cenario/shared';
import type { Tx } from '@cenario/db';
import { audit } from '../../core/audit';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { clock } from '../attendance/common';
import { notify } from '../notifications/notify';
import { lockTasks } from '../production/common';
import { evaluateCandidates, reasonText } from './engine';
import { ACTIVITY_SKILL, createProposal } from './reschedule';

/**
 * Simplificação Fase 7 — pedido que só vale com aprovação do gestor (o apoio prolongado saiu com
 * os pedidos de ajuda):
 *  - TRANSFERÊNCIA de tarefa (desenho original: proposta de reatribuição): o responsável pede; o
 *    gestor aprova uma alternativa. Etapa do titular → CHANGE_PRINCIPAL (regra canônica da R1:
 *    setUpholsterer, tarefas da peça e LaborReview); demais → REASSIGN com CAS do responsável.
 */

/** Possíveis ajudantes/destinos: equipe com a competência (os outros motivos ficam informados). */
const capable = (list: CandidateEvaluation[]) =>
  list.filter((c) => !c.reasons.includes('SEM_COMPETENCIA'));

function ordered(list: CandidateEvaluation[], suggested?: string | null) {
  const best = pickCandidate(list);
  return [...list].sort((a, b) => {
    const rank = (c: CandidateEvaluation) =>
      c.userId === suggested ? 0 : c.userId === best?.userId ? 1 : c.eligible ? 2 : 3;
    return rank(a) - rank(b) || a.score - b.score || a.name.localeCompare(b.name, 'pt-BR');
  });
}

const situationOf = (c: CandidateEvaluation) =>
  c.eligible ? 'disponível agora' : `agora: ${reasonText(c).toLowerCase()}`;

// ─────────────────────────── Transferência de tarefa ───────────────────────────

/** Etapa ligada ao titular da peça (tapeçaria/principal): só pela regra canônica da R1. */
const titularBound = (t: { stepClass: string | null; activity: string }) =>
  t.stepClass === 'TAPECARIA' || PRINCIPAL_ACTIVITIES.includes(t.activity as never);

export async function requestTransfer(
  tx: Tx,
  actor: ActorContext,
  me: string,
  taskId: string,
  input: TransferRequestInput,
) {
  await lockTasks(tx, [taskId]);
  const t = await tx.productionTask.findUnique({
    where: { id: taskId },
    include: { serviceOrder: { select: { status: true } } },
  });
  if (!t) throw Errors.notFound('Tarefa');
  if (t.assigneeUserId !== me)
    throw Errors.forbidden('Só é possível pedir a transferência das próprias tarefas.');
  if (input.version !== undefined && t.version !== input.version)
    throw Errors.versionConflict(t.version);
  if (!['BLOQUEADA', 'PROGRAMADA', 'LIBERADA'].includes(t.status))
    throw Errors.business(
      'Só tarefas que ainda não começaram podem ser transferidas (registros de execução nunca mudam de dono).',
    );
  if (t.serviceOrder.status !== 'ABERTA') throw Errors.business('A OS não está ativa.');
  const pending = await tx.rescheduleProposal.findFirst({
    where: { kind: 'TRANSFERENCIA', status: 'PENDENTE', affectedTaskIds: { has: t.id } },
  });
  if (pending)
    throw Errors.conflict(
      `Já existe um pedido de transferência para ${taskCode(t.number)} (${proposalCode(pending.number)}).`,
      { proposalId: pending.id },
    );
  const titular = titularBound(t);
  const skill: Skill = titular
    ? 'CORTE_COSTURA'
    : ACTIVITY_SKILL[t.activity as keyof typeof ACTIVITY_SKILL];
  const { candidates } = await evaluateCandidates(tx, {
    requesterUserId: me,
    skill,
    estimatedMinutes: t.estimatedMinutes ?? 60,
  });
  const options = capable(candidates);
  if (input.toUserId && !options.some((c) => c.userId === input.toUserId))
    throw Errors.business('A pessoa sugerida não tem a competência desta etapa.');
  if (!options.length) throw Errors.business('Ninguém da equipe tem a competência desta etapa.');
  const requester = await tx.user.findUniqueOrThrow({ where: { id: me } });
  const alternatives: ProposalAlternative[] = ordered(options, input.toUserId).map((c, i) => ({
    id: `TRANSFERIR_${i + 1}`,
    title: titular
      ? `Trocar o titular para ${c.name} (regra de titular)`
      : `Transferir ${taskCode(t.number)} para ${c.name}`,
    actions: [
      titular
        ? { type: 'CHANGE_PRINCIPAL' as const, taskId: t.id, toUserId: c.userId, fromUserId: me }
        : { type: 'REASSIGN' as const, taskId: t.id, toUserId: c.userId, fromUserId: me },
    ],
    impacts: [
      `${taskCode(t.number)} · ${t.title} passa de ${requester.displayName} para ${c.name} (${situationOf(c)}).`,
      ...(titular
        ? [
            'Etapa do tapeceiro titular: troca o titular da peça (tarefas pendentes da peça e revisão financeira, sem transferir valores).',
          ]
        : []),
    ],
    critical: titular,
    recommended: i === 0,
  }));
  const proposal = await createProposal(tx, actor, {
    kind: 'TRANSFERENCIA',
    critical: titular,
    situation: `${requester.displayName} pediu para transferir ${taskCode(t.number)} · ${t.title}: ${input.reason}`,
    problem: `Transferência de ${taskCode(t.number)} precisa de aprovação.`,
    affectedTaskIds: [t.id],
    alternatives,
    proposedAlternativeId: alternatives[0]!.id,
    dedupeKey: `TRANSFERENCIA:${t.id}:${t.version}:${clock().getTime()}`,
    requestedById: me,
  });
  if (!proposal) throw Errors.conflict('Pedido de transferência já registrado.');
  await audit(tx, actor, {
    action: 'task.transfer_requested',
    entityType: 'production_task',
    entityId: t.id,
    summary:
      `${proposalCode(proposal.number)}: ${requester.displayName} pediu a transferência de ${taskCode(t.number)} — ${input.reason}`.slice(
        0,
        300,
      ),
  });
  await notify(tx, actor, [
    {
      userId: me,
      kind: 'REPROGRAMACAO_PENDENTE',
      dedupeKey: `TRANSFERENCIA_PEDIDA:${proposal.id}`,
      body: `Pedido de transferência de ${taskCode(t.number)} enviado ao gestor (${proposalCode(proposal.number)}). A tarefa continua com você até a decisão.`,
      taskId: t.id,
      includeActor: true,
    },
  ]);
  return proposal;
}
