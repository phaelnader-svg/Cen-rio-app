/**
 * Evolução, Fase 3 — distribuição automática de tarefas por OS e peça (planos FILA_SEMANAL).
 *
 * Regras (definitivas):
 * - cada peça que exige tapeçaria tem UM tapeceiro titular (service_order_items.upholsterer);
 *   todas as etapas TAPECARIA da peça são dele — nunca divididas por disponibilidade/ausência;
 * - PREPARACAO vai ao responsável padrão configurado (ou ao único ajudante elegível); OUTRA fica
 *   para o gestor; sem elegível = pendência visível, nunca atribuição arbitrária;
 * - gerar não libera: as tarefas nascem em rascunho (ou bloqueadas e reavaliadas, se o plano já
 *   está publicado) e seguem a liberação/fila da Fase 2;
 * - idempotente: chave (peça, modelo, posição da etapa) com índice único parcial; repetir só
 *   completa o que falta e nunca troca um responsável já gravado;
 * - substituir titular é ação do gestor (motivo + confirmação + CAS), não move tarefa iniciada
 *   nem concluída e não mexe em valores: só sinaliza revisão financeira.
 * Planos LEGADO continuam usando a geração anterior (plans.ts `generateTasks`), sem mudança.
 */
import {
  DISTRIBUTION_PENDENCY_LABEL,
  EVENT_TYPES,
  STEP_CLASS_ROLE,
  distributeSchema,
  formatServiceOrderItemCode,
  setUpholstererSchema,
  taskCode,
  type DistributionPendency,
  type DistributionPendencyDto,
  type OwnerChangeKind,
  type PieceDistributionDto,
  type PlanDistributionDto,
  type StepClass,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { loadUserPermissions } from '../../core/permissions';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { serviceOrderCode } from '../commercial/common';
import { openLaborReviews } from '../finance/labor-review';
import { notify, taskNotice } from '../notifications/notify';
import { idParams } from '../presenters';
import { mainInspector } from '../quality/common';
import { ACTIVITY_SKILL } from '../help/reschedule';
import {
  MANAGEMENT,
  PLAN,
  VIEW,
  audienceFor,
  lockPlan,
  lockTasks,
  reevaluateTasks,
  taskEvent,
} from './common';
import { announceAssignments, reviseIfPublishedBy } from './plans';

const STARTED = ['EM_EXECUCAO', 'PAUSADA'];
const DONE = ['CONCLUIDA', 'CANCELADA'];
const PENDING = ['RASCUNHO', 'BLOQUEADA', 'PROGRAMADA', 'LIBERADA'];

// ─────────────────────────── Equipe ───────────────────────────

type Member = {
  userId: string;
  displayName: string;
  canExecute: boolean;
  isTapeceiro: boolean;
  isHelper: boolean;
  skills: Set<string>;
};

/** Retrato da equipe ativa (uma leitura por distribuição). */
export async function loadTeam(db: Tx | PrismaClient) {
  const employees = await db.employee.findMany({
    where: { active: true, user: { active: true } },
    include: {
      skills: true,
      user: { include: { roles: { include: { role: { select: { key: true } } } } } },
    },
    orderBy: { displayName: 'asc' },
  });
  const team = new Map<string, Member>();
  for (const e of employees) {
    const keys = e.user.roles.map((r) => r.role.key);
    team.set(e.userId, {
      userId: e.userId,
      displayName: e.user.displayName,
      canExecute: (await loadUserPermissions(db, e.userId)).has('producao.executar'),
      isTapeceiro: keys.includes('tapeceiro'),
      isHelper: keys.includes('ajudante'),
      skills: new Set(e.skills.map((s) => s.skill)),
    });
  }
  return team;
}
type Team = Awaited<ReturnType<typeof loadTeam>>;

const upholstererOk = (team: Team, userId: string | null | undefined) => {
  const m = userId ? team.get(userId) : undefined;
  return Boolean(m && m.canExecute && (m.isTapeceiro || m.skills.has('CORTE_COSTURA')));
};

/** Responsável padrão de uma etapa de preparação (ou o motivo de não haver). */
async function preparationAssignee(
  db: Tx | PrismaClient,
  team: Team,
  activity: keyof typeof ACTIVITY_SKILL,
): Promise<string | null> {
  const skill = ACTIVITY_SKILL[activity];
  const settings = await db.companySettings.findUnique({ where: { id: 1 } });
  const ok = (m: Member | undefined) => Boolean(m && m.canExecute && m.skills.has(skill));
  if (settings?.preparationAssigneeUserId) {
    // Configurado mas inelegível (inativo, sem competência): pendência, nunca outro no lugar.
    return ok(team.get(settings.preparationAssigneeUserId))
      ? settings.preparationAssigneeUserId
      : null;
  }
  const helpers = [...team.values()].filter((m) => m.isHelper && ok(m));
  return helpers.length === 1 ? helpers[0]!.userId : null;
}

// ─────────────────────────── Geração ───────────────────────────

/** Tarefas de produção da peça sem marcador de geração (apoio/ocorrência/qualidade não contam). */
const manualTaskWhere = (itemId: string): Prisma.ProductionTaskWhereInput => ({
  serviceOrderItemId: itemId,
  templateId: null,
  status: { not: 'CANCELADA' },
  supportForTaskId: null,
  issueId: null,
  inspectionId: null,
  activity: { notIn: ['CORRECAO', 'EMBALAGEM'] },
});

type ItemRow = {
  id: string;
  position: number;
  pieceType: string;
  serviceType: string;
  upholstererUserId: string | null;
  serviceOrderId: string;
};

async function lockItems(tx: Tx, ids: string[]) {
  if (!ids.length) return;
  const sorted = [...ids].sort();
  await tx.$queryRaw`SELECT id FROM service_order_items WHERE id = ANY(${sorted}::uuid[]) ORDER BY id FOR UPDATE`;
}

async function templateFor(tx: Tx, pieceType: string, templateId?: string | null) {
  const include = { steps: { orderBy: { position: 'asc' as const } } };
  if (templateId) {
    const t = await tx.productionTemplate.findUnique({ where: { id: templateId }, include });
    if (!t || !t.active) throw Errors.business('Modelo inexistente ou inativo.');
    return t;
  }
  const all = await tx.productionTemplate.findMany({
    where: { active: true },
    include,
    orderBy: { createdAt: 'asc' },
  });
  return all.find((t) => t.pieceTypes.includes(pieceType as never)) ?? null;
}

/** Grava o titular (definição ou substituição) com histórico imutável. Uso interno. */
async function recordOwner(
  tx: Tx,
  actor: ActorContext,
  item: ItemRow,
  toUserId: string,
  kind: OwnerChangeKind,
  reason: string | null,
  movedTaskIds: string[],
  financialReviewRequired: boolean,
) {
  await tx.serviceOrderItem.update({
    where: { id: item.id },
    data: { upholstererUserId: toUserId },
  });
  const change = await tx.serviceOrderItemOwnerChange.create({
    data: {
      serviceOrderItemId: item.id,
      kind,
      fromUserId: item.upholstererUserId,
      toUserId,
      reason,
      movedTaskIds,
      financialReviewRequired,
      createdById: actor.userId,
    },
  });
  // Evolução Fase 5: valor já combinado com outra pessoa abre a revisão financeira (trava
  // liberação e pagamento); nada é transferido automaticamente.
  if (financialReviewRequired)
    await openLaborReviews(tx, actor, {
      serviceOrderId: item.serviceOrderId,
      itemId: item.id,
      newOwnerId: toUserId,
      ownerChangeId: change.id,
    });
  return change.id;
}

/** Mão de obra combinada (peça ou OS inteira) com outra pessoa: só sinaliza, nunca altera. */
async function financialReviewNeeded(
  tx: Tx | PrismaClient,
  serviceOrderId: string,
  itemId: string,
  userId: string,
) {
  const n = await tx.productionPayable.count({
    where: {
      serviceOrderId,
      OR: [{ serviceOrderItemId: itemId }, { serviceOrderItemId: null }],
      status: { not: 'CANCELADO' },
      professionalUserId: { not: userId },
    },
  });
  return n > 0;
}

/**
 * Distribui as peças de uma OS num plano FILA_SEMANAL. Chamado na inclusão da OS e no
 * reprocessamento; devolve as tarefas criadas e as atribuídas agora (as duas listas podem ser
 * vazias — repetir é seguro).
 */
export async function distributeServiceOrder(
  tx: Tx,
  actor: ActorContext,
  args: {
    planId: string;
    serviceOrderId: string;
    priority: Prisma.ProductionTaskCreateInput['priority'];
    proposedUpholsterer: string | null;
    pieces?: {
      serviceOrderItemId: string;
      upholstererUserId?: string | null;
      templateId?: string | null;
    }[];
    regenerate?: boolean;
    reason?: string | null;
    generate?: boolean;
  },
) {
  const plan = await tx.productionPlan.findUniqueOrThrow({ where: { id: args.planId } });
  if (plan.mode !== 'FILA_SEMANAL')
    throw Errors.business('A distribuição automática vale para planejamentos em fila semanal.');
  const so = await tx.serviceOrder.findUniqueOrThrow({
    where: { id: args.serviceOrderId },
    include: { items: { orderBy: { position: 'asc' } } },
  });
  for (const p of args.pieces ?? [])
    if (!so.items.some((i) => i.id === p.serviceOrderItemId))
      throw Errors.business('A peça não pertence a esta OS.');
  await lockItems(
    tx,
    so.items.map((i) => i.id),
  );
  const items = await tx.serviceOrderItem.findMany({
    where: { serviceOrderId: so.id },
    orderBy: { position: 'asc' },
  });
  const team = await loadTeam(tx);
  const created: string[] = [];
  const assigned: string[] = [];
  for (const item of items) {
    const input = args.pieces?.find((p) => p.serviceOrderItemId === item.id);
    const template = await templateFor(tx, item.pieceType, input?.templateId);
    const needsUpholstery = Boolean(template?.steps.some((s) => s.stepClass === 'TAPECARIA'));

    // 1. Titular: escolha explícita da peça > titular já definido > proposta da OS (principal).
    let owner = item.upholstererUserId;
    const wanted =
      input?.upholstererUserId ??
      (owner ? null : needsUpholstery ? args.proposedUpholsterer : null);
    if (wanted && wanted !== owner) {
      if (owner)
        throw Errors.business(
          `A peça ${formatServiceOrderItemCode(so.number, item.position)} já tem titular: use a substituição de titular (com motivo).`,
        );
      if (!upholstererOk(team, wanted))
        throw Errors.business('O titular escolhido precisa ser um tapeceiro ativo.');
      const financial = await financialReviewNeeded(tx, so.id, item.id, wanted);
      await recordOwner(tx, actor, item, wanted, 'DEFINICAO', args.reason ?? null, [], financial);
      owner = wanted;
    }
    if (!template || args.generate === false) continue;

    // 2. Tarefas já geradas para a peça (qualquer semana).
    const existing = await tx.productionTask.findMany({
      where: {
        serviceOrderItemId: item.id,
        templateId: { not: null },
        status: { not: 'CANCELADA' },
      },
    });
    if (existing.some((t) => t.planId !== plan.id)) continue; // pendência JA_GERADA_EM_OUTRA_SEMANA
    // Tarefas sem marcador de modelo (Fase 2, legado ou avulsas): nunca gerar por cima.
    if (await tx.productionTask.count({ where: manualTaskWhere(item.id) })) continue;
    const stale = existing.filter(
      (t) => t.templateId !== template.id || t.templateVersion !== template.version,
    );
    if (stale.length) {
      const started = stale.some((t) => t.startedAt || !PENDING.includes(t.status));
      if (!args.regenerate || started) continue; // pendência MODELO_ALTERADO
      if (!args.reason || args.reason.trim().length < 3)
        throw Errors.validation(
          [{ path: 'reason', message: 'Informe o motivo da troca de modelo.' }],
          'Informe o motivo da troca de modelo.',
        );
      await lockTasks(
        tx,
        stale.map((t) => t.id),
      );
      for (const t of stale) {
        if (t.status === 'RASCUNHO') {
          await tx.productionTask.delete({ where: { id: t.id } });
          continue;
        }
        await tx.productionTask.update({
          where: { id: t.id },
          data: { status: 'CANCELADA', cancelReason: args.reason, version: { increment: 1 } },
        });
        await taskEvent(tx, actor, null, t, {
          kind: 'CANCELADA',
          from: t.status,
          to: 'CANCELADA',
          note: `Modelo alterado: ${args.reason}`,
        });
      }
    }
    const keep = existing.filter((t) => !stale.includes(t));
    const byPosition = new Map<number, string[]>();
    for (const t of keep) byPosition.set(t.templateStepPosition!, [t.id]);

    // 3. Etapas do modelo: cria as que faltam; completa responsável ainda vazio.
    const prepCache = new Map<string, string | null>();
    for (const step of template.steps) {
      const deps = [...new Set(step.dependsOn.flatMap((p) => byPosition.get(p) ?? []))];
      if (step.optional && item.serviceType === 'FABRICACAO') {
        if (!byPosition.has(step.position)) byPosition.set(step.position, deps);
        continue;
      }
      const cls = step.stepClass as StepClass | null;
      let who: string | null = null;
      if (cls === 'TAPECARIA') who = owner && upholstererOk(team, owner) ? owner : null;
      else if (cls === 'PREPARACAO') {
        if (!prepCache.has(step.activity))
          prepCache.set(
            step.activity,
            await preparationAssignee(tx, team, step.activity as keyof typeof ACTIVITY_SKILL),
          );
        who = prepCache.get(step.activity)!;
      }
      const current = keep.find((t) => t.templateStepPosition === step.position);
      if (current) {
        if (!current.assigneeUserId && who && PENDING.includes(current.status)) {
          await tx.productionTask.update({
            where: { id: current.id },
            data: { assigneeUserId: who, version: { increment: 1 } },
          });
          assigned.push(current.id);
        }
        continue;
      }
      const task = await tx.productionTask.create({
        data: {
          planId: plan.id,
          serviceOrderId: so.id,
          serviceOrderItemId: item.id,
          activity: step.activity,
          title: `${step.name} — ${formatServiceOrderItemCode(so.number, item.position)}`,
          role: cls ? STEP_CLASS_ROLE[cls] : step.role,
          assigneeUserId: who,
          priority: args.priority,
          sequence: item.position * 100 + step.position,
          requiresMaterials: step.requiresMaterials,
          completionRequirement: step.completionRequirement,
          stepClass: cls,
          templateId: template.id,
          templateVersion: template.version,
          templateStepPosition: step.position,
          status: plan.status === 'PUBLICADO' ? 'BLOQUEADA' : 'RASCUNHO',
        },
      });
      for (const d of deps)
        await tx.taskDependency.create({ data: { taskId: task.id, dependsOnId: d } });
      byPosition.set(step.position, [task.id]);
      created.push(task.id);
    }
  }
  return { created, assigned };
}

// ─────────────────────────── Leitura (pendências) ───────────────────────────

export async function pieceDistribution(
  db: Tx | PrismaClient,
  team: Team,
  inspector: { id: string; displayName: string } | null,
  planId: string,
  so: { id: string; number: number },
  item: ItemRow & { description: string },
): Promise<PieceDistributionDto> {
  const pend: DistributionPendencyDto[] = [];
  const add = (kind: DistributionPendency, taskIds: string[] = [], extra = '') =>
    pend.push({
      kind,
      message: `${DISTRIBUTION_PENDENCY_LABEL[kind]}${extra ? ` — ${extra}` : ''}.`,
      taskIds,
    });
  const tasks = await db.productionTask.findMany({
    where: { serviceOrderItemId: item.id, status: { not: 'CANCELADA' } },
    include: { assignee: { select: { id: true, displayName: true } } },
    orderBy: [{ sequence: 'asc' }, { number: 'asc' }],
  });
  const generated = tasks.filter((t) => t.templateId);
  const templateId = generated[0]?.templateId ?? null;
  const template = templateId
    ? await db.productionTemplate.findUnique({
        where: { id: templateId },
        include: { steps: true },
      })
    : ((
        await db.productionTemplate.findMany({
          where: { active: true },
          include: { steps: true },
          orderBy: { createdAt: 'asc' },
        })
      ).find((t) => t.pieceTypes.includes(item.pieceType as never)) ?? null);
  if (!template) add('SEM_MODELO');
  const needsUpholstery = Boolean(
    template?.steps.some((s) => s.stepClass === 'TAPECARIA') ||
      tasks.some((t) => t.stepClass === 'TAPECARIA'),
  );
  const owner = item.upholstererUserId ? team.get(item.upholstererUserId) : undefined;
  const upholsteryTasks = tasks.filter((t) => t.stepClass === 'TAPECARIA');
  if (needsUpholstery && !item.upholstererUserId)
    add(
      'SEM_TITULAR',
      upholsteryTasks.map((t) => t.id),
    );
  else if (needsUpholstery && !upholstererOk(team, item.upholstererUserId))
    add(
      'TITULAR_INELEGIVEL',
      upholsteryTasks.map((t) => t.id),
    );
  const unclassified = template?.steps.filter((s) => !s.stepClass) ?? [];
  if (unclassified.length)
    add('ETAPA_SEM_CLASSIFICACAO', [], unclassified.map((s) => s.name).join(', '));
  const prepOpen = tasks.filter(
    (t) => t.stepClass === 'PREPARACAO' && !t.assigneeUserId && !DONE.includes(t.status),
  );
  if (prepOpen.length)
    add(
      'SEM_RESPONSAVEL_PADRAO',
      prepOpen.map((t) => t.id),
    );
  if (
    template &&
    generated.some((t) => t.templateVersion !== template.version && !DONE.includes(t.status))
  )
    add(
      'MODELO_ALTERADO',
      generated.map((t) => t.id),
    );
  const manual = await db.productionTask.findMany({
    where: manualTaskWhere(item.id),
    select: { id: true },
  });
  if (manual.length && !generated.length)
    add(
      'TAREFAS_ANTERIORES',
      manual.map((t) => t.id),
    );
  const elsewhere = generated.filter((t) => t.planId !== planId);
  if (elsewhere.length)
    add(
      'JA_GERADA_EM_OUTRA_SEMANA',
      elsewhere.map((t) => t.id),
    );
  if (!inspector) add('SEM_INSPETOR');
  // Evolução Fase 5: a pendência acompanha a revisão financeira ABERTA (peça ou OS inteira).
  if (
    await db.laborReview.count({
      where: {
        serviceOrderId: so.id,
        status: 'ABERTA',
        OR: [{ serviceOrderItemId: item.id }, { serviceOrderItemId: null }],
      },
    })
  )
    add('REVISAO_FINANCEIRA');
  const changes = await db.serviceOrderItemOwnerChange.findMany({
    where: { serviceOrderItemId: item.id },
    include: {
      fromUser: { select: { displayName: true } },
      toUser: { select: { displayName: true } },
      createdBy: { select: { displayName: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  return {
    item: {
      id: item.id,
      code: formatServiceOrderItemCode(so.number, item.position),
      pieceType: item.pieceType,
      description: item.description,
    },
    serviceOrder: { id: so.id, code: serviceOrderCode(so.number) },
    needsUpholstery,
    upholsterer: owner
      ? { userId: owner.userId, displayName: owner.displayName }
      : item.upholstererUserId
        ? { userId: item.upholstererUserId, displayName: '(inativo)' }
        : null,
    template: template ? { id: template.id, name: template.name, version: template.version } : null,
    tasks: tasks.map((t) => ({
      id: t.id,
      code: taskCode(t.number),
      title: t.title,
      stepClass: t.stepClass,
      status: t.status,
      assignee: t.assignee ? { userId: t.assignee.id, displayName: t.assignee.displayName } : null,
      planId: t.planId,
    })),
    inspector: inspector ? { userId: inspector.id, displayName: inspector.displayName } : null,
    pendencies: pend,
    ownerChanges: changes.map((c) => ({
      kind: c.kind as OwnerChangeKind,
      from: c.fromUser?.displayName ?? null,
      to: c.toUser.displayName,
      reason: c.reason,
      financialReviewRequired: c.financialReviewRequired,
      createdBy: c.createdBy?.displayName ?? null,
      createdAt: c.createdAt.toISOString(),
    })),
  };
}

export async function loadDistribution(
  db: Tx | PrismaClient,
  planId: string,
): Promise<PlanDistributionDto> {
  const plan = await db.productionPlan.findUnique({
    where: { id: planId },
    include: {
      items: {
        include: { serviceOrder: { include: { items: { orderBy: { position: 'asc' } } } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!plan) throw Errors.notFound('Planejamento');
  const team = await loadTeam(db);
  const inspector = await mainInspector(db);
  const pieces: PieceDistributionDto[] = [];
  for (const it of plan.items)
    for (const item of it.serviceOrder.items)
      pieces.push(
        await pieceDistribution(
          db,
          team,
          inspector ? { id: inspector.id, displayName: inspector.displayName } : null,
          plan.id,
          it.serviceOrder,
          item,
        ),
      );
  return {
    planId: plan.id,
    mode: plan.mode,
    pieces,
    pendencyCount: pieces.reduce((a, p) => a + p.pendencies.length, 0),
  };
}

// ─────────────────────────── Titular: definir / substituir ───────────────────────────

export async function setUpholsterer(
  tx: Tx,
  actor: ActorContext,
  itemId: string,
  input: z.output<typeof setUpholstererSchema>,
) {
  await lockItems(tx, [itemId]);
  const item = await tx.serviceOrderItem.findUnique({
    where: { id: itemId },
    include: { serviceOrder: { select: { id: true, number: true, status: true } } },
  });
  if (!item) throw Errors.notFound('Peça');
  if (item.serviceOrder.status !== 'ABERTA') throw Errors.business('A OS não está ativa.');
  if (item.upholstererUserId !== input.expectedUserId)
    throw Errors.conflict(
      'O titular desta peça mudou desde que a tela foi aberta: atualize e tente de novo.',
    );
  if (item.upholstererUserId === input.userId) return { changed: false, moved: [] as string[] };
  const team = await loadTeam(tx);
  if (!upholstererOk(team, input.userId))
    throw Errors.business('O titular precisa ser um tapeceiro ativo com permissão de produção.');
  const kind: OwnerChangeKind = item.upholstererUserId ? 'SUBSTITUICAO' : 'DEFINICAO';
  const reason = input.reason?.trim() || null;
  if (kind === 'SUBSTITUICAO') {
    if (!reason || reason.length < 3)
      throw Errors.validation(
        [{ path: 'reason', message: 'Informe o motivo da substituição.' }],
        'Informe o motivo da substituição.',
      );
    if (!input.confirm)
      throw Errors.business('Confirme a substituição do titular (ação excepcional e auditada).');
  }
  const tasks = await tx.productionTask.findMany({
    where: { serviceOrderItemId: itemId, stepClass: 'TAPECARIA', status: { notIn: DONE as never } },
  });
  await lockTasks(
    tx,
    tasks.map((t) => t.id),
  );
  const started = tasks.filter((t) => STARTED.includes(t.status));
  if (started.length)
    throw Errors.business(
      `Há etapa de tapeçaria iniciada (${started.map((t) => taskCode(t.number)).join(', ')}): conclua-a ou cancele-a com motivo antes de trocar o titular. Registros de execução nunca mudam de dono.`,
    );
  const toMove = tasks.filter((t) => t.assigneeUserId !== input.userId);
  const financial = await financialReviewNeeded(tx, item.serviceOrder.id, item.id, input.userId);
  await recordOwner(
    tx,
    actor,
    item,
    input.userId,
    kind,
    reason,
    toMove.map((t) => t.id),
    financial,
  );
  const plans = new Set<string>();
  for (const t of toMove) {
    const u = await tx.productionTask.update({
      where: { id: t.id },
      data: { assigneeUserId: input.userId, version: { increment: 1 } },
    });
    if (t.status !== 'RASCUNHO') {
      await taskEvent(tx, actor, null, t, {
        kind: 'RESPONSAVEL_ALTERADO',
        note: reason,
        changes: { from: t.assigneeUserId, to: input.userId, ownerChange: kind },
      });
      if (t.assigneeUserId)
        await notify(
          tx,
          actor,
          taskNotice(t, 'TAREFA_REMOVIDA', 'passou para o novo titular da peça.'),
        );
      if (t.planId) plans.add(t.planId);
    }
    void u;
  }
  for (const p of plans)
    await reviseIfPublishedBy(
      tx,
      actor,
      p,
      reason,
      `titular da peça ${formatServiceOrderItemCode(item.serviceOrder.number, item.position)}`,
    );
  await reevaluateTasks(
    tx,
    actor,
    toMove.map((t) => t.id),
  );
  await announceAssignments(
    tx,
    actor,
    toMove.filter((t) => t.status !== 'RASCUNHO').map((t) => t.id),
  );
  const code = formatServiceOrderItemCode(item.serviceOrder.number, item.position);
  await audit(tx, actor, {
    action:
      kind === 'DEFINICAO' ? 'production.piece_owner_defined' : 'production.piece_owner_replaced',
    entityType: 'service_order_item',
    entityId: item.id,
    summary: `${code}: titular ${kind === 'DEFINICAO' ? 'definido' : 'substituído'} (${team.get(input.userId)?.displayName}); ${toMove.length} tarefa(s) pendente(s) acompanharam${reason ? `. Motivo: ${reason}` : ''}${financial ? '. Revisão financeira aberta: liberação e pagamento travados até o gestor definir os valores; nenhum valor foi alterado.' : ''}`,
  });
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.PRODUCTION_PIECE_OWNER_CHANGED,
    aggregateType: 'service_order_item',
    aggregateId: item.id,
    payload: { id: item.id, serviceOrderId: item.serviceOrder.id, kind },
    audience: audienceFor(item.upholstererUserId, input.userId),
  });
  return { changed: true, moved: toMove.map((t) => t.id), financialReviewRequired: financial };
}

/** Uma tarefa de tapeçaria de peça com titular só pode ficar com o titular (API). */
export async function assertUpholstererRule(
  db: Tx | PrismaClient,
  t: {
    stepClass: StepClass | null;
    serviceOrderItemId: string | null;
    assigneeUserId: string | null;
  },
) {
  if (t.stepClass !== 'TAPECARIA' || !t.serviceOrderItemId || !t.assigneeUserId) return;
  const item = await db.serviceOrderItem.findUnique({
    where: { id: t.serviceOrderItemId },
    include: { upholsterer: { select: { displayName: true } } },
  });
  if (item?.upholstererUserId && item.upholstererUserId !== t.assigneeUserId)
    throw Errors.business(
      `A tapeçaria desta peça é do titular ${item.upholsterer?.displayName}: para trocar, use a substituição de titular (com motivo).`,
    );
}

// ─────────────────────────── Rotas ───────────────────────────

export async function productionDistributionRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  /** Distribuição proposta/atual do plano: titular, responsáveis e pendências por peça. */
  app.get('/api/v1/production-plans/:id/distribution', { config: { access: VIEW } }, (request) =>
    loadDistribution(prisma, idParams.parse(request.params).id),
  );

  /** Reprocessa a distribuição de uma OS do plano (idempotente: só completa o que falta). */
  app.post(
    '/api/v1/production-plans/:id/items/:itemId/distribute',
    { config: { access: PLAN, idempotent: true } },
    async (request) => {
      const { id, itemId } = z
        .object({ id: z.string().uuid(), itemId: z.string().uuid() })
        .parse(request.params);
      const input = distributeSchema.parse(request.body ?? {});
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const plan = await lockPlan(tx, id);
        const planItem = await tx.productionPlanItem.findUnique({ where: { id: itemId } });
        if (!planItem || planItem.planId !== id) throw Errors.notFound('OS do planejamento');
        const r = await distributeServiceOrder(tx, actor, {
          planId: id,
          serviceOrderId: planItem.serviceOrderId,
          priority: planItem.priority,
          proposedUpholsterer: planItem.principalUserId,
          regenerate: input.regenerate,
          reason: input.reason,
        });
        const touched = [...r.created, ...r.assigned];
        if (!touched.length) return; // nada a fazer: repetir é seguro
        if (plan.status === 'PUBLICADO') {
          for (const tId of r.created)
            await taskEvent(
              tx,
              actor,
              null,
              { id: tId },
              {
                kind: 'PUBLICADA',
                to: 'BLOQUEADA',
                note: input.reason ?? null,
              },
            );
          await reviseIfPublishedBy(tx, actor, id, input.reason, 'redistribuição de tarefas');
          await reevaluateTasks(tx, actor, touched);
          await announceAssignments(tx, actor, touched);
        }
        await audit(tx, actor, {
          action: 'production.distribution_processed',
          entityType: 'production_plan',
          entityId: id,
          summary: `Distribuição reprocessada: ${r.created.length} tarefa(s) criada(s), ${r.assigned.length} atribuída(s).`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.PRODUCTION_DISTRIBUTION_UPDATED,
          aggregateType: 'production_plan',
          aggregateId: id,
          payload: { id },
          audience: MANAGEMENT,
        });
      });
      return loadDistribution(prisma, id);
    },
  );

  /** Define (primeira vez) ou substitui (motivo + confirmação) o titular de uma peça. */
  app.put(
    '/api/v1/service-order-items/:id/upholsterer',
    { config: { access: PLAN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = setUpholstererSchema.parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction((tx) => setUpholsterer(tx, actor, id, input));
    },
  );

  /** Responsável padrão da preparação (vazio = único ajudante elegível). */
  app.get('/api/v1/production/distribution-settings', { config: { access: VIEW } }, async () => {
    const s = await prisma.companySettings.findUnique({ where: { id: 1 } });
    return { preparationAssigneeUserId: s?.preparationAssigneeUserId ?? null };
  });
  app.put(
    '/api/v1/production/distribution-settings',
    { config: { access: PLAN } },
    async (request) => {
      const input = z
        .object({ preparationAssigneeUserId: z.string().uuid().nullable() })
        .parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        if (input.preparationAssigneeUserId) {
          const m = (await loadTeam(tx)).get(input.preparationAssigneeUserId);
          if (!m?.canExecute)
            throw Errors.business('Escolha um funcionário ativo que execute tarefas de produção.');
        }
        await tx.companySettings.update({
          where: { id: 1 },
          data: { preparationAssigneeUserId: input.preparationAssigneeUserId },
        });
        await audit(tx, actor, {
          action: 'production.distribution_settings',
          entityType: 'company_settings',
          entityId: null,
          summary: `Responsável padrão da preparação: ${input.preparationAssigneeUserId ?? 'automático (único ajudante elegível)'}.`,
        });
      });
      return input;
    },
  );
}
