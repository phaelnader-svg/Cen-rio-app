/**
 * Simplificação, Fase 4 — pré-planejamento da produção.
 *
 * O gestor escolhe só a OS, o tapeceiro titular de cada peça e a data pretendida de início; o
 * resto é o mecanismo existente:
 * - semana = segunda-feira da data de início; o plano da semana (um por semana, `weekStart`
 *   único) é encontrado ou criado em FILA_SEMANAL — nunca uma segunda entidade de plano;
 * - as tarefas vêm da distribuição automática da Evolução Fase 3 (`distributeServiceOrder`):
 *   João na preparação, o titular na tapeçaria, dependências do modelo, idempotente;
 * - pré-planejado = tarefas em RASCUNHO (invisíveis nos tablets), mesmo numa semana já publicada;
 *   "Publicar semana" publica o rascunho inteiro (primeira publicação ou nova revisão);
 * - a data de início fica no item do plano e segura a liberação (`evaluateRelease.notBefore`):
 *   antes dela a tarefa fica "Programada", nunca "Liberada".
 *
 * Onde cada OS está (A planejar, Planejado, Aguardando condição, Em produção, Concluído) é
 * calculado dos vínculos reais (item de plano e tarefas) — nunca de uma marcação visual.
 */
import {
  EVENT_TYPES,
  MATERIAL_READINESS_LABEL,
  PIPELINE_STAGE_LABEL,
  RELEASE_BLOCKER_LABEL,
  formatServiceOrderItemCode,
  mondayOf,
  planServicesSchema,
  reschedulePlannedSchema,
  type MaterialReadiness,
  type PipelineServiceDto,
  type PipelineStage,
  type PlanServicesResultDto,
  type ProductionPipelineDto,
  type PublicationPreviewDto,
  type ReleaseBlocker,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { now as clockNow } from '../../core/clock';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { dateOnly, parseDateOnly, serviceOrderCode } from '../commercial/common';
import { notify, taskNotice } from '../notifications/notify';
import { idParams } from '../presenters';
import { readinessOf } from '../purchasing/common';
import {
  MANAGEMENT,
  PLAN,
  VIEW,
  company,
  lockPlan,
  lockTasks,
  reevaluateTasks,
  taskEvent,
} from './common';
import { distributeServiceOrder } from './distribution';
import { reviseIfPublishedBy } from './plans';

const STARTED = ['EM_EXECUCAO', 'PAUSADA', 'CONCLUIDA'];

async function todayIn(db: Tx | PrismaClient) {
  const { timezone } = await company(db);
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(clockNow());
}

async function activeTemplates(db: Tx | PrismaClient) {
  return db.productionTemplate.findMany({
    where: { active: true },
    include: { steps: { select: { stepClass: true } } },
    orderBy: { createdAt: 'asc' },
  });
}
type Templates = Awaited<ReturnType<typeof activeTemplates>>;
const templateOf = (all: Templates, pieceType: string) =>
  all.find((t) => (t.pieceTypes as string[]).includes(pieceType)) ?? null;

/** Trava por OS (dois gestores planejando a mesma OS) e por semana (criação do plano). */
async function advisory(tx: Tx, keys: string[]) {
  for (const k of [...new Set(keys)].sort())
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${k}))`;
}

/** Plano da semana em fila semanal: encontra ou cria (rascunho). Plano por horário = recusa. */
async function weekPlan(tx: Tx, actor: ActorContext, weekStart: string) {
  let plan = await tx.productionPlan.findUnique({
    where: { weekStart: parseDateOnly(weekStart)! },
  });
  if (!plan) {
    plan = await tx.productionPlan.create({
      data: {
        weekStart: parseDateOnly(weekStart)!,
        mode: 'FILA_SEMANAL',
        createdById: actor.userId,
      },
    });
    await audit(tx, actor, {
      action: 'production.plan_created',
      entityType: 'production_plan',
      entityId: plan.id,
      summary: `Planejamento da semana de ${weekStart} criado pelo pré-planejamento (rascunho, fila semanal).`,
    });
    await appendEvent(tx, actor, {
      type: EVENT_TYPES.PRODUCTION_PLAN_CREATED,
      aggregateType: 'production_plan',
      aggregateId: plan.id,
      payload: { id: plan.id, weekStart },
      audience: MANAGEMENT,
    });
  }
  if (plan.mode !== 'FILA_SEMANAL')
    throw Errors.business(
      `A semana de ${weekStart.split('-').reverse().join('/')} usa o planejamento antigo por horário: planeje esta OS pela tela de planejamento de produção ou escolha outra data.`,
    );
  return lockPlan(tx, plan.id);
}

// ─────────────────────────── Leitura ───────────────────────────

export async function loadPipeline(db: Tx | PrismaClient): Promise<ProductionPipelineDto> {
  const templates = await activeTemplates(db);
  const since = new Date(clockNow().getTime() - 30 * 86_400_000);
  const sos = await db.serviceOrder.findMany({
    where: { status: 'ABERTA' },
    include: {
      customer: { select: { name: true } },
      sourceReceipt: { select: { receivedAt: true } },
      items: {
        orderBy: { position: 'asc' },
        include: {
          orderItem: { select: { receivedQuantity: true } },
          upholsterer: { select: { id: true, displayName: true } },
        },
      },
      productionPlanItems: {
        include: {
          plan: { select: { id: true, weekStart: true, status: true } },
          plannedBy: { select: { displayName: true } },
        },
      },
      productionTasks: {
        where: { status: { not: 'CANCELADA' } },
        select: {
          status: true,
          startedAt: true,
          completedAt: true,
          blockers: true,
          assigneeUserId: true,
          planId: true,
        },
      },
    },
    orderBy: [{ promisedDate: 'asc' }, { number: 'asc' }],
  });
  // Chegadas físicas de material aguardando conferência, por OS de destino.
  const conference = new Set(
    (
      await db.purchaseAllocation.findMany({
        where: {
          serviceOrderId: { in: sos.map((s) => s.id) },
          item: { purchaseOrder: { arrivals: { some: { status: 'PENDENTE_CONFERENCIA' } } } },
        },
        select: { serviceOrderId: true },
      })
    ).map((r) => r.serviceOrderId),
  );

  const items: PipelineServiceDto[] = [];
  for (const so of sos) {
    // Só OS com as peças fisicamente recebidas entram na produção.
    if (!so.items.length || so.items.some((i) => i.orderItem.receivedQuantity <= 0)) continue;
    const tasks = so.productionTasks;
    const planItem =
      [...so.productionPlanItems].sort((a, b) => +b.plan.weekStart - +a.plan.weekStart)[0] ?? null;
    let stage: PipelineStage;
    if (!tasks.length && !planItem) stage = 'A_PLANEJAR';
    else if (tasks.length && tasks.every((t) => t.status === 'CONCLUIDA')) {
      const last = Math.max(...tasks.map((t) => t.completedAt?.getTime() ?? 0));
      if (last < since.getTime()) continue;
      stage = 'CONCLUIDO';
    } else if (tasks.some((t) => t.startedAt || STARTED.includes(t.status))) stage = 'EM_PRODUCAO';
    else if (
      tasks.some((t) => t.status === 'RASCUNHO') ||
      (!tasks.length && planItem?.plan.status === 'RASCUNHO')
    )
      stage = 'PLANEJADO_RASCUNHO';
    else if (
      tasks.some((t) => t.status === 'BLOQUEADA' && t.blockers.some((b) => b !== 'NAO_PUBLICADA'))
    )
      stage = 'AGUARDANDO_CONDICAO';
    else stage = 'PLANEJADO_PUBLICADO';

    const readiness = await readinessOf(db, so.id);
    const blockers = [
      ...new Set(
        tasks
          .filter((t) => t.status === 'BLOQUEADA')
          .flatMap((t) => t.blockers)
          .filter((b) => b !== 'NAO_PUBLICADA')
          .map((b) => RELEASE_BLOCKER_LABEL[b as ReleaseBlocker] ?? b),
      ),
    ];
    if (stage !== 'CONCLUIDO' && tasks.some((t) => t.status === 'PROGRAMADA'))
      blockers.push(
        `Aguardando a data de início${planItem?.startDate ? ` (${dateOnly(planItem.startDate)!.split('-').reverse().join('/')})` : ''}`,
      );
    const pieces = so.items.map((i) => {
      const tpl = templateOf(templates, i.pieceType);
      return {
        id: i.id,
        code: formatServiceOrderItemCode(so.number, i.position),
        pieceType: i.pieceType,
        description: i.description,
        quantity: i.quantity,
        serviceType: i.serviceType,
        needsUpholsterer: Boolean(tpl?.steps.some((s) => s.stepClass === 'TAPECARIA')),
        template: tpl?.name ?? null,
        upholsterer: i.upholsterer
          ? { userId: i.upholsterer.id, displayName: i.upholsterer.displayName }
          : null,
      };
    });
    const pendencies: string[] = [];
    for (const p of pieces) {
      if (!p.template) pendencies.push(`${p.code}: sem modelo de produção para este tipo de peça.`);
      else if (p.needsUpholsterer && !p.upholsterer && stage !== 'A_PLANEJAR')
        pendencies.push(`${p.code}: sem tapeceiro titular.`);
    }
    const unassigned = tasks.filter(
      (t) => !t.assigneeUserId && !['CONCLUIDA'].includes(t.status),
    ).length;
    if (unassigned) pendencies.push(`${unassigned} tarefa(s) sem responsável elegível.`);
    if (planItem && !tasks.length) pendencies.push('Nenhuma tarefa gerada para esta OS.');
    items.push({
      serviceOrder: {
        id: so.id,
        code: serviceOrderCode(so.number),
        promisedDate: dateOnly(so.promisedDate),
        priority: so.priority,
      },
      customerName: so.customer.name,
      receivedAt: (so.sourceReceipt?.receivedAt ?? so.createdAt).toISOString(),
      pieces,
      materials: {
        state: readiness.state,
        label: MATERIAL_READINESS_LABEL[readiness.state as MaterialReadiness] ?? readiness.state,
        inConference: conference.has(so.id),
      },
      stage,
      plan: planItem
        ? {
            planId: planItem.plan.id,
            itemId: planItem.id,
            weekStart: dateOnly(planItem.plan.weekStart)!,
            planStatus: planItem.plan.status as 'RASCUNHO' | 'PUBLICADO',
            startDate: dateOnly(planItem.startDate),
            version: planItem.version,
            plannedBy: planItem.plannedBy?.displayName ?? null,
          }
        : null,
      tasks: {
        total: tasks.length,
        done: tasks.filter((t) => t.status === 'CONCLUIDA').length,
        started: tasks.filter((t) => t.startedAt || STARTED.includes(t.status)).length,
        blocked: tasks.filter((t) => t.status === 'BLOQUEADA').length,
        draft: tasks.filter((t) => t.status === 'RASCUNHO').length,
      },
      blockers: stage === 'A_PLANEJAR' ? [] : blockers,
      pendencies,
    });
  }
  const counts = Object.fromEntries(
    (Object.keys(PIPELINE_STAGE_LABEL) as PipelineStage[]).map((s) => [
      s,
      items.filter((i) => i.stage === s).length,
    ]),
  ) as Record<PipelineStage, number>;
  return { counts, items };
}

/** O que "Publicar semana" vai liberar (só tarefas em rascunho do plano). */
export async function publicationPreview(
  db: Tx | PrismaClient,
  planId: string,
): Promise<PublicationPreviewDto> {
  const plan = await db.productionPlan.findUnique({
    where: { id: planId },
    include: { items: { include: { serviceOrder: { select: { number: true } } } } },
  });
  if (!plan) throw Errors.notFound('Planejamento');
  const drafts = await db.productionTask.findMany({
    where: { planId, status: 'RASCUNHO' },
    include: {
      assignee: { select: { id: true, displayName: true } },
      serviceOrder: { select: { id: true, number: true } },
    },
  });
  const soIds = [...new Set(drafts.map((t) => t.serviceOrderId))];
  const byAssignee = new Map<
    string,
    { userId: string | null; displayName: string; tasks: number }
  >();
  for (const t of drafts) {
    const k = t.assigneeUserId ?? '-';
    const cur = byAssignee.get(k) ?? {
      userId: t.assigneeUserId,
      displayName: t.assignee?.displayName ?? 'Sem responsável',
      tasks: 0,
    };
    cur.tasks += 1;
    byAssignee.set(k, cur);
  }
  const code = (id: string) =>
    serviceOrderCode(drafts.find((t) => t.serviceOrderId === id)!.serviceOrder.number);
  const pendencies: string[] = [];
  const unassigned = drafts.filter((t) => !t.assigneeUserId).length;
  if (unassigned)
    pendencies.push(
      `${unassigned} tarefa(s) sem responsável: ficarão bloqueadas até o gestor definir.`,
    );
  const materialsBlocked: PublicationPreviewDto['materialsBlocked'] = [];
  for (const id of soIds) {
    const r = await readinessOf(db, id);
    if (
      r.state !== 'COMPLETO' &&
      drafts.some((t) => t.serviceOrderId === id && t.requiresMaterials)
    )
      materialsBlocked.push({
        code: code(id),
        label: MATERIAL_READINESS_LABEL[r.state as MaterialReadiness] ?? r.state,
      });
  }
  const today = await todayIn(db);
  const startDates = soIds.map((id) => {
    const it = plan.items.find((i) => i.serviceOrderId === id);
    return { code: code(id), startDate: dateOnly(it?.startDate ?? null) };
  });
  const conflicts: string[] = [];
  for (const s of startDates)
    if (s.startDate && s.startDate < today)
      conflicts.push(
        `${s.code}: a data de início (${s.startDate.split('-').reverse().join('/')}) já passou — a OS fica liberada assim que publicada.`,
      );
  return {
    planId,
    weekStart: dateOnly(plan.weekStart)!,
    planStatus: plan.status as 'RASCUNHO' | 'PUBLICADO',
    version: plan.version,
    serviceOrders: soIds.length,
    pieces: new Set(drafts.map((t) => t.serviceOrderItemId).filter(Boolean)).size,
    tasks: drafts.length,
    byAssignee: [...byAssignee.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    startDates,
    pendencies,
    materialsBlocked,
    conflicts,
    publishable: drafts.length > 0,
  };
}

// ─────────────────────────── Rotas ───────────────────────────

export async function preplanningRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/production/pipeline', { config: { access: VIEW } }, () => loadPipeline(prisma));

  app.get(
    '/api/v1/production-plans/:id/publication-preview',
    { config: { access: VIEW } },
    (request) => publicationPreview(prisma, idParams.parse(request.params).id),
  );

  /**
   * Planejamento individual (1 OS) ou em lote: tudo ou nada, numa transação. Repetir a mesma
   * requisição (Idempotency-Key) devolve o mesmo resultado; outra requisição para uma OS já
   * planejada recebe 409 — nunca duplica vínculo nem tarefa.
   */
  app.post(
    '/api/v1/production/plan-services',
    { config: { access: PLAN, idempotent: true } },
    async (request, reply) => {
      const input = planServicesSchema.parse(request.body);
      const actor = actorFrom(request);
      const result = await prisma.$transaction(async (tx) => {
        const today = await todayIn(tx);
        const weeks = input.entries.map((e) => mondayOf(e.startDate));
        await advisory(tx, [
          ...input.entries.map((e) => `so-plan:${e.serviceOrderId}`),
          ...weeks.map((w) => `plan:${w}`),
        ]);
        const templates = await activeTemplates(tx);
        const out: PlanServicesResultDto['planned'] = [];
        const touchedPlans = new Set<string>();
        for (const entry of [...input.entries].sort((a, b) =>
          a.serviceOrderId.localeCompare(b.serviceOrderId),
        )) {
          if (entry.startDate < today)
            throw Errors.validation(
              [{ path: 'startDate', message: 'A data de início não pode estar no passado.' }],
              'A data de início não pode estar no passado.',
            );
          const so = await tx.serviceOrder.findUnique({
            where: { id: entry.serviceOrderId },
            include: {
              items: { orderBy: { position: 'asc' }, include: { orderItem: true } },
              productionPlanItems: { include: { plan: { select: { weekStart: true } } } },
            },
          });
          if (!so) throw Errors.notFound('Ordem de serviço');
          const code = serviceOrderCode(so.number);
          if (so.status !== 'ABERTA') throw Errors.business(`${code}: a OS não está aberta.`);
          if (so.items.some((i) => i.orderItem.receivedQuantity <= 0))
            throw Errors.business(`${code}: as peças ainda não chegaram à oficina.`);
          if (so.productionPlanItems.length) {
            const w = dateOnly(so.productionPlanItems[0]!.plan.weekStart)!;
            throw Errors.conflict(
              `${code} já foi planejada (semana de ${w.split('-').reverse().join('/')}). Atualize a lista.`,
            );
          }
          if (
            await tx.productionTask.count({
              where: { serviceOrderId: so.id, status: { not: 'CANCELADA' } },
            })
          )
            throw Errors.conflict(`${code} já tem tarefas de produção. Atualize a lista.`);
          // Titular obrigatório para cada peça com tapeçaria (escolha nova ou já definido).
          for (const p of entry.pieces)
            if (!so.items.some((i) => i.id === p.serviceOrderItemId))
              throw Errors.validation(undefined, `${code}: peça não pertence à OS.`);
          for (const i of so.items) {
            const tpl = templateOf(templates, i.pieceType);
            const needs = Boolean(tpl?.steps.some((s) => s.stepClass === 'TAPECARIA'));
            const chosen = entry.pieces.find((p) => p.serviceOrderItemId === i.id);
            if (needs && !chosen && !i.upholstererUserId)
              throw Errors.validation(
                [{ path: 'pieces', message: 'Escolha o tapeceiro responsável.' }],
                `${formatServiceOrderItemCode(so.number, i.position)}: escolha o tapeceiro responsável.`,
              );
          }
          const weekStart = mondayOf(entry.startDate);
          const plan = await weekPlan(tx, actor, weekStart);
          const priority = entry.priority ?? so.priority;
          await tx.productionPlanItem.create({
            data: {
              planId: plan.id,
              serviceOrderId: so.id,
              priority,
              startDate: parseDateOnly(entry.startDate)!,
              plannedById: actor.userId,
            },
          });
          const { created } = await distributeServiceOrder(tx, actor, {
            planId: plan.id,
            serviceOrderId: so.id,
            priority,
            proposedUpholsterer: null,
            pieces: entry.pieces.map((p) => ({
              serviceOrderItemId: p.serviceOrderItemId,
              upholstererUserId: p.upholstererUserId,
            })),
            draft: true,
          });
          const owners = await tx.serviceOrderItem.findMany({
            where: { serviceOrderId: so.id },
            include: { upholsterer: { select: { displayName: true } } },
            orderBy: { position: 'asc' },
          });
          await audit(tx, actor, {
            action: 'production.service_planned',
            entityType: 'service_order',
            entityId: so.id,
            summary: `${code} planejada para ${entry.startDate.split('-').reverse().join('/')} (semana de ${weekStart.split('-').reverse().join('/')}, rascunho): ${created.length} tarefa(s).`,
            changes: {
              planId: plan.id,
              startDate: entry.startDate,
              owners: owners.map((o) => ({
                piece: formatServiceOrderItemCode(so.number, o.position),
                upholsterer: o.upholsterer?.displayName ?? null,
              })),
            },
          });
          touchedPlans.add(plan.id);
          out.push({
            serviceOrderId: so.id,
            code,
            planId: plan.id,
            weekStart,
            startDate: entry.startDate,
            tasksCreated: created.length,
          });
        }
        for (const id of touchedPlans)
          await appendEvent(tx, actor, {
            type: EVENT_TYPES.PRODUCTION_PLAN_UPDATED,
            aggregateType: 'production_plan',
            aggregateId: id,
            payload: { id },
            audience: MANAGEMENT,
          });
        return { planned: out } satisfies PlanServicesResultDto;
      });
      return reply.status(201).send(result);
    },
  );

  /**
   * Reprogramação de uma OS planejada: data de início (mesma semana ou outra), prioridade.
   * Versão do item (409 se outro gestor alterou). Trocar de semana só sem tarefa iniciada: as
   * pendentes voltam ao rascunho da nova semana (o gestor publica de novo); nada concluído muda.
   */
  app.put(
    '/api/v1/production/planned/:id',
    { config: { access: PLAN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = reschedulePlannedSchema.parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        const head = await tx.productionPlanItem.findUnique({ where: { id } });
        if (!head) throw Errors.notFound('OS planejada');
        const toWeek = input.startDate ? mondayOf(input.startDate) : null;
        await advisory(tx, [
          `so-plan:${head.serviceOrderId}`,
          ...(toWeek ? [`plan:${toWeek}`] : []),
        ]);
        const item = await tx.productionPlanItem.findUnique({
          where: { id },
          include: { plan: true, serviceOrder: { select: { number: true } } },
        });
        if (!item) throw Errors.notFound('OS planejada');
        if (item.version !== input.version) throw Errors.versionConflict(item.version);
        const code = serviceOrderCode(item.serviceOrder.number);
        const today = await todayIn(tx);
        if (input.startDate && input.startDate < today)
          throw Errors.validation(
            [{ path: 'startDate', message: 'A data de início não pode estar no passado.' }],
            'A data de início não pode estar no passado.',
          );
        await lockPlan(tx, item.planId);
        const tasks = await tx.productionTask.findMany({
          where: {
            planId: item.planId,
            serviceOrderId: item.serviceOrderId,
            status: { not: 'CANCELADA' },
          },
        });
        await lockTasks(
          tx,
          tasks.map((t) => t.id),
        );
        const open = tasks.filter((t) => !STARTED.includes(t.status) && !t.startedAt);
        const published = open.some((t) => t.status !== 'RASCUNHO');
        const fromWeek = dateOnly(item.plan.weekStart)!;
        const changes: string[] = [];
        let targetItemId = item.id;

        if (toWeek && toWeek !== fromWeek) {
          if (tasks.some((t) => STARTED.includes(t.status) || t.startedAt))
            throw Errors.business(
              `${code} já tem tarefas iniciadas: altere a data dentro da semana ou transfira as pendências ao fim da semana.`,
            );
          const target = await weekPlan(tx, actor, toWeek);
          if (
            await tx.productionPlanItem.findUnique({
              where: {
                planId_serviceOrderId: { planId: target.id, serviceOrderId: item.serviceOrderId },
              },
            })
          )
            throw Errors.conflict(`${code} já consta da semana de destino.`);
          const moved = await tx.productionPlanItem.create({
            data: {
              planId: target.id,
              serviceOrderId: item.serviceOrderId,
              principalUserId: item.principalUserId,
              priority: input.priority ?? item.priority,
              startDate: parseDateOnly(input.startDate!)!,
              plannedById: actor.userId,
              version: item.version + 1,
            },
          });
          targetItemId = moved.id;
          for (const t of open) {
            const u = await tx.productionTask.update({
              where: { id: t.id },
              data: {
                planId: target.id,
                status: 'RASCUNHO',
                blockers: [],
                queuePosition: null,
                ...(input.priority ? { priority: input.priority } : {}),
                version: { increment: 1 },
              },
            });
            await taskEvent(tx, actor, null, t, {
              kind: 'TRANSFERIDA_SEMANA',
              from: t.status,
              to: 'RASCUNHO',
              note: input.reason ?? null,
              changes: { fromWeek, toWeek },
            });
            // Quem já via a tarefa publicada é avisado de que ela saiu da semana.
            if (t.status !== 'RASCUNHO')
              await notify(
                tx,
                actor,
                taskNotice(
                  { ...u, status: t.status },
                  'TAREFA_REMOVIDA',
                  `reprogramada para a semana de ${toWeek.split('-').reverse().join('/')}.`,
                ),
              );
          }
          await tx.productionPlanItem.delete({ where: { id: item.id } });
          if (published)
            await reviseIfPublishedBy(
              tx,
              actor,
              item.planId,
              input.reason,
              `${code} reprogramada para a semana de ${toWeek}`,
            );
          changes.push(`semana ${fromWeek} → ${toWeek}`, `início ${input.startDate}`);
          await appendEvent(tx, actor, {
            type: EVENT_TYPES.PRODUCTION_PLAN_UPDATED,
            aggregateType: 'production_plan',
            aggregateId: target.id,
            payload: { id: target.id },
            audience: MANAGEMENT,
          });
        } else {
          const data: { startDate?: Date; priority?: typeof item.priority } = {};
          if (input.startDate && input.startDate !== dateOnly(item.startDate)) {
            data.startDate = parseDateOnly(input.startDate)!;
            changes.push(`início ${dateOnly(item.startDate) ?? 'sem data'} → ${input.startDate}`);
          }
          if (input.priority && input.priority !== item.priority) {
            data.priority = input.priority;
            changes.push(`prioridade ${item.priority} → ${input.priority}`);
          }
          if (!changes.length) return { itemId: item.id, version: item.version };
          await tx.productionPlanItem.update({
            where: { id: item.id },
            data: { ...data, version: { increment: 1 } },
          });
          if (data.priority)
            for (const t of open)
              await tx.productionTask.update({
                where: { id: t.id },
                data: { priority: data.priority, version: { increment: 1 } },
              });
          if (published)
            await reviseIfPublishedBy(
              tx,
              actor,
              item.planId,
              input.reason,
              `${code}: ${changes.join('; ')}`,
            );
          // Nova data vale já: tarefas publicadas são reavaliadas (antes da data = Programada).
          await reevaluateTasks(
            tx,
            actor,
            open.filter((t) => t.status !== 'RASCUNHO').map((t) => t.id),
          );
        }
        await audit(tx, actor, {
          action: 'production.service_rescheduled',
          entityType: 'service_order',
          entityId: item.serviceOrderId,
          summary: `${code} reprogramada: ${changes.join('; ')}${input.reason ? `. Motivo: ${input.reason}` : ''}.`,
          changes: { from: { week: fromWeek, startDate: dateOnly(item.startDate) }, input },
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.PRODUCTION_PLAN_UPDATED,
          aggregateType: 'production_plan',
          aggregateId: item.planId,
          payload: { id: item.planId },
          audience: MANAGEMENT,
        });
        const after = await tx.productionPlanItem.findUniqueOrThrow({
          where: { id: targetItemId },
        });
        return { itemId: after.id, version: after.version };
      });
    },
  );
}
