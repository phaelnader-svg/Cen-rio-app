import {
  EVENT_TYPES,
  HELP_OPEN,
  PRINCIPAL_ACTIVITIES,
  PROLONGED_SUPPORT,
  helpRequestCode,
  pickCandidate,
  proposalCode,
  taskCode,
  type CandidateEvaluation,
  type ProposalAlternative,
  type ProlongedSupportInput,
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
import { assignTo, evaluateCandidates, helpDomainEvent, helpEvent, reasonText } from './engine';
import { lockHelpRequest } from './queue';
import { ACTIVITY_SKILL, createProposal } from './reschedule';

/**
 * Simplificação Fase 7 — pedidos que só valem com aprovação do gestor:
 *  - APOIO PROLONGADO (desenho original: HelpRequest kind APOIO_PROLONGADO): o principal pede; o
 *    pedido nasce encaminhado ao gestor (nunca entra na fila automática); a proposta lista os
 *    possíveis ajudantes; aprovar cria a tarefa de apoio (o vínculo); recusar encerra o pedido.
 *    Apoio não gera mão de obra (D14): nenhuma ProductionPayable nasce aqui.
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

// ─────────────────────────── Apoio prolongado ───────────────────────────

export async function requestProlongedSupport(
  tx: Tx,
  actor: ActorContext,
  me: string,
  input: ProlongedSupportInput,
) {
  await lockTasks(tx, [input.taskId]);
  const task = await tx.productionTask.findUnique({
    where: { id: input.taskId },
    include: { serviceOrder: { select: { status: true } } },
  });
  if (!task) throw Errors.notFound('Tarefa');
  if (task.assigneeUserId !== me)
    throw Errors.forbidden('Só é possível pedir apoio nas próprias tarefas.');
  if (task.supportForTaskId) throw Errors.business('Tarefa de apoio: peça na tarefa principal.');
  if (!['LIBERADA', 'PROGRAMADA', 'BLOQUEADA', 'EM_EXECUCAO', 'PAUSADA'].includes(task.status))
    throw Errors.business('Peça apoio em uma tarefa ainda não concluída.');
  if (task.serviceOrder.status !== 'ABERTA') throw Errors.business('A OS não está ativa.');
  const open = await tx.helpRequest.findFirst({
    where: { taskId: task.id, requesterUserId: me, status: { in: [...HELP_OPEN] } },
  });
  if (open)
    throw Errors.conflict(
      `Já existe um pedido aberto para esta tarefa (${helpRequestCode(open.number)}).`,
      { helpRequestId: open.id },
    );
  const { candidates } = await evaluateCandidates(tx, {
    requesterUserId: me,
    skill: 'APOIO_GERAL',
    estimatedMinutes: input.estimatedMinutes,
  });
  const options = capable(candidates);
  if (input.helperUserId && !options.some((c) => c.userId === input.helperUserId))
    throw Errors.business('O ajudante sugerido não tem a competência de apoio.');
  if (!options.length) throw Errors.business('Ninguém da equipe tem a competência de apoio.');
  const now = clock();
  const req = await tx.helpRequest.create({
    data: {
      taskId: task.id,
      serviceOrderId: task.serviceOrderId,
      requesterUserId: me,
      kind: PROLONGED_SUPPORT,
      estimatedMinutes: input.estimatedMinutes,
      urgent: false,
      justification: input.justification,
      status: 'ESCALADA',
      escalatedAt: now,
      createdAt: now,
    },
  });
  const code = helpRequestCode(req.number);
  const requester = await tx.user.findUniqueOrThrow({ where: { id: me } });
  await helpEvent(tx, actor, req, {
    kind: 'SOLICITADA',
    to: 'ESCALADA',
    note: `Apoio prolongado (${Math.round(input.estimatedMinutes / 60)} h) — ${input.justification}. Aguarda aprovação do gestor.`,
    evaluation: { at: now.toISOString(), candidates },
  });
  const alternatives: ProposalAlternative[] = ordered(options, input.helperUserId).map((c, i) => ({
    id: `AJUDANTE_${i + 1}`,
    title: `Aprovar: ${c.name} apoia ${requester.displayName} em ${taskCode(task.number)}`,
    actions: [
      {
        type: 'ASSIGN_PROLONGED_SUPPORT',
        taskId: task.id,
        toUserId: c.userId,
        helpRequestId: req.id,
      },
    ],
    impacts: [
      `${c.name} (${situationOf(c)}) fica vinculado ao apoio de ${task.title} por cerca de ${Math.round(input.estimatedMinutes / 60)} h.`,
      'Apoio não muda o titular nem gera valor de mão de obra.',
    ],
    critical: false,
    recommended: i === 0,
  }));
  const proposal = await createProposal(tx, actor, {
    kind: 'APOIO_PROLONGADO',
    critical: false,
    situation: `${requester.displayName} pediu apoio prolongado em ${taskCode(task.number)} · ${task.title} (${code}): ${input.justification}`,
    problem: `Apoio prolongado para ${requester.displayName} precisa de aprovação.`,
    affectedTaskIds: [task.id],
    alternatives,
    proposedAlternativeId: alternatives[0]!.id,
    dedupeKey: `APOIO_PROLONGADO:${req.id}`,
    helpRequestId: req.id,
    requestedById: me,
  });
  await audit(tx, actor, {
    action: 'help.prolonged_requested',
    entityType: 'help_request',
    entityId: req.id,
    summary: `${code}: apoio prolongado pedido por ${requester.displayName} em ${taskCode(task.number)} (${proposal ? proposalCode(proposal.number) : 'proposta'}).`,
  });
  await helpDomainEvent(tx, actor, EVENT_TYPES.HELP_ESCALATED, req);
  await notify(tx, actor, [
    {
      userId: me,
      kind: 'AJUDA_SOLICITADA',
      dedupeKey: `AJUDA_SOLICITADA:${req.id}`,
      body: `Pedido de apoio prolongado ${code} enviado ao gestor. Você recebe a decisão aqui.`,
      taskId: task.id,
      includeActor: true,
    },
  ]);
  return req.id;
}

/** Aprovado pelo gestor (proposta): o vínculo é a tarefa de apoio do ajudante escolhido. */
export async function approveProlongedSupport(
  tx: Tx,
  actor: ActorContext,
  helpRequestId: string,
  helperUserId: string,
  reason: string,
) {
  const req = await lockHelpRequest(tx, helpRequestId);
  if (!req || req.kind !== PROLONGED_SUPPORT) throw Errors.notFound('Pedido de apoio prolongado');
  if (req.status !== 'ESCALADA')
    throw Errors.business('O pedido de apoio já foi decidido ou cancelado.');
  const { candidates } = await evaluateCandidates(tx, {
    requesterUserId: req.requesterUserId,
    skill: 'APOIO_GERAL',
    estimatedMinutes: req.estimatedMinutes,
  });
  const c = capable(candidates).find((x) => x.userId === helperUserId);
  if (!c) throw Errors.business('O ajudante escolhido não tem a competência de apoio.');
  return assignTo(
    tx,
    actor,
    req,
    c.userId,
    c.name,
    clock(),
    { at: clock().toISOString(), candidates, approved: true },
    `Apoio prolongado aprovado pelo gestor: ${reason}`.slice(0, 480),
    false,
  );
}

/** Recusado pelo gestor: o pedido é encerrado (nunca volta à fila automática). */
export async function refuseProlongedSupport(
  tx: Tx,
  actor: ActorContext,
  helpRequestId: string,
  note: string,
) {
  const req = await lockHelpRequest(tx, helpRequestId);
  if (!req || req.kind !== PROLONGED_SUPPORT || req.status !== 'ESCALADA') return null;
  const u = await tx.helpRequest.update({
    where: { id: req.id },
    data: {
      status: 'CANCELADA',
      cancelledAt: clock(),
      cancelledById: actor.userId,
      cancelReason: `Recusado pelo gestor: ${note}`.slice(0, 300),
      version: { increment: 1 },
    },
  });
  await helpEvent(tx, actor, req, {
    kind: 'RECUSADA',
    from: 'ESCALADA',
    to: 'CANCELADA',
    note: `Apoio prolongado recusado pelo gestor: ${note}`,
  });
  await audit(tx, actor, {
    action: 'help.prolonged_refused',
    entityType: 'help_request',
    entityId: req.id,
    summary: `${helpRequestCode(req.number)}: apoio prolongado recusado — ${note}`.slice(0, 300),
  });
  await helpDomainEvent(tx, actor, EVENT_TYPES.HELP_CANCELLED, u);
  return u;
}

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
