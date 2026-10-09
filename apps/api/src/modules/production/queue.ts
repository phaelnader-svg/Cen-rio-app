/**
 * Evolução, Fase 2 — fila semanal contínua por funcionário.
 *
 * Só vale para planejamentos FILA_SEMANAL (os LEGADO seguem por horário, sem mudança):
 * - a fila é a ordem das tarefas principais abertas do funcionário (semana, prioridade, posição
 *   do gestor, sequência e número) e não depende do dia: nada zera, duplica ou conclui à
 *   meia-noite;
 * - a "próxima executável" é a primeira da fila que pode ser iniciada/retomada agora. Uma
 *   tarefa bloqueada mantém o lugar; quando é desbloqueada volta a ser elegível na mesma
 *   posição, sem interromper o que está em execução. Nada inicia sozinho;
 * - o gestor reordena (com versão/CAS e, se publicada, motivo e revisão) e, terminada a
 *   semana, transfere pendências para outra semana publicada (ação explícita e idempotente).
 */
import {
  EVENT_TYPES,
  carryOverSchema,
  compareQueue,
  queueOrderProblem,
  reorderQueueSchema,
  taskCode,
  type MyQueueDto,
  type QueueEntryDto,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { now as clockNow } from '../../core/clock';
import { Errors } from '../../lib/errors';
import { dateOnly } from '../commercial/common';
import { idParams } from '../presenters';
import {
  EXECUTE,
  MANAGEMENT,
  PLAN,
  VIEW,
  audienceFor,
  company,
  lockPlan,
  lockTasks,
  reevaluateTasks,
  taskEvent,
  taskInclude,
  toTaskDto,
} from './common';
import { announceAssignments, reviseIfPublished } from './plans';

const OPEN = ['BLOQUEADA', 'PROGRAMADA', 'LIBERADA', 'EM_EXECUCAO', 'PAUSADA'] as const;
const CARRYABLE = ['BLOQUEADA', 'PROGRAMADA', 'LIBERADA', 'PAUSADA'];

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Fila de um funcionário (todas as semanas FILA_SEMANAL publicadas com pendências dele). */
export async function loadQueue(db: Tx | PrismaClient, userId: string): Promise<MyQueueDto> {
  const { timezone } = await company(db);
  const rows = await db.productionTask.findMany({
    where: {
      assigneeUserId: userId,
      queueExclusive: true,
      status: { in: [...OPEN] },
      plan: { mode: 'FILA_SEMANAL', status: 'PUBLICADO' },
    },
    include: taskInclude,
  });
  const blockedByIssue = new Set(
    (
      await db.productionIssue.findMany({
        where: {
          taskId: { in: rows.map((r) => r.id) },
          blocksTask: true,
          status: { in: ['ABERTA', 'ATRIBUIDA', 'EM_RESOLUCAO', 'AGUARDANDO_VERIFICACAO'] },
        },
        select: { taskId: true },
      })
    ).map((i) => i.taskId),
  );
  const ordered = rows
    .map((t) => ({ t, key: { ...t, weekStart: dateOnly(t.plan!.weekStart) } }))
    .sort((a, b) => compareQueue(a.key, b.key));
  const items: QueueEntryDto[] = ordered.map(({ t }, i) => ({
    position: i + 1,
    // Iniciar (liberada) ou retomar (pausada sem ocorrência que a impeça).
    executable: t.status === 'LIBERADA' || (t.status === 'PAUSADA' && !blockedByIssue.has(t.id)),
    task: toTaskDto(t, timezone),
  }));
  const current = items.find((e) => e.task.status === 'EM_EXECUCAO') ?? null;
  const nextIdx = items.findIndex((e) => e.executable);
  return {
    current: current?.task ?? null,
    next: nextIdx >= 0 ? items[nextIdx]!.task : null,
    blockedAhead:
      nextIdx >= 0
        ? items.slice(0, nextIdx).filter((e) => e.task.status !== 'EM_EXECUCAO').length
        : items.filter((e) => e.task.status !== 'EM_EXECUCAO').length,
    items,
    total: items.length,
  };
}

/** A semana de trabalho (segunda a sexta) já terminou no fuso da empresa. */
export async function weekEnded(db: Tx | PrismaClient, weekStart: Date) {
  const { timezone } = await company(db);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(clockNow());
  return today > addDays(dateOnly(weekStart)!, 4);
}

export async function productionQueueRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  /** Minha fila (tablet): ordem, tarefa atual, próxima executável e bloqueadas à frente. */
  app.get('/api/v1/production-tasks/mine/queue', { config: { access: EXECUTE } }, (request) =>
    loadQueue(prisma, request.auth!.userId),
  );

  /** Fila de um funcionário, para a gestão. */
  app.get('/api/v1/production-queue/:userId', { config: { access: VIEW } }, (request) =>
    loadQueue(prisma, z.object({ userId: z.string().uuid() }).parse(request.params).userId),
  );

  /**
   * Reordena a fila de UM funcionário num planejamento em fila. A lista deve conter exatamente
   * as tarefas principais abertas dele no plano; respeita faixas de prioridade e dependências.
   * Concorrência: versão do plano (CAS) + trava do plano. Publicado: motivo e nova revisão.
   */
  app.put(
    '/api/v1/production-plans/:id/queue',
    { config: { access: PLAN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = reorderQueueSchema.parse(request.body);
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const plan = await lockPlan(tx, id);
        if (plan.mode !== 'FILA_SEMANAL')
          throw Errors.business('Só planejamentos em fila semanal têm ordem de fila.');
        if (plan.version !== input.version) throw Errors.versionConflict(plan.version);
        const tasks = await tx.productionTask.findMany({
          where: {
            planId: id,
            assigneeUserId: input.userId,
            supportForTaskId: null,
            status: { in: plan.status === 'PUBLICADO' ? [...OPEN] : ['RASCUNHO'] },
          },
          include: { dependsOn: { select: { dependsOnId: true } } },
        });
        const byId = new Map(tasks.map((t) => [t.id, t]));
        if (
          new Set(input.taskIds).size !== input.taskIds.length ||
          input.taskIds.length !== tasks.length ||
          input.taskIds.some((t) => !byId.has(t))
        ) {
          throw Errors.business(
            'A lista não corresponde à fila atual deste funcionário: atualize a tela e tente de novo.',
          );
        }
        await lockTasks(tx, input.taskIds);
        const problem = queueOrderProblem(
          input.taskIds.map((tid) => {
            const t = byId.get(tid)!;
            return {
              id: t.id,
              priority: t.priority,
              dependsOn: t.dependsOn.map((d) => d.dependsOnId),
            };
          }),
        );
        if (problem) throw Errors.business(problem);
        const changed: { id: string; code: string; from: number | null; to: number }[] = [];
        for (const [i, tid] of input.taskIds.entries()) {
          const t = byId.get(tid)!;
          if (t.queuePosition === i + 1) continue;
          await tx.productionTask.update({
            where: { id: tid },
            data: { queuePosition: i + 1, version: { increment: 1 } },
          });
          changed.push({ id: tid, code: taskCode(t.number), from: t.queuePosition, to: i + 1 });
        }
        if (!changed.length) return; // mesma ordem: nada a registrar
        if (plan.status === 'PUBLICADO') {
          for (const c of changed)
            await taskEvent(
              tx,
              actor,
              null,
              { id: c.id },
              {
                kind: 'FILA_REORDENADA',
                note: input.reason ?? null,
                changes: { queuePosition: { from: c.from, to: c.to } },
              },
            );
          await reviseIfPublished(tx, request, id, input.reason, 'reordenação da fila');
        } else {
          await tx.productionPlan.update({ where: { id }, data: { version: { increment: 1 } } });
        }
        await audit(tx, actor, {
          action: 'production.queue_reordered',
          entityType: 'production_plan',
          entityId: id,
          summary: `Fila reordenada na semana ${dateOnly(plan.weekStart)}: ${changed.map((c) => `${c.code} → ${c.to}º`).join(', ')}.`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.PRODUCTION_QUEUE_REORDERED,
          aggregateType: 'production_plan',
          aggregateId: id,
          payload: { id, userId: input.userId },
          audience: plan.status === 'PUBLICADO' ? audienceFor(input.userId) : MANAGEMENT,
        });
      });
      return loadQueue(prisma, input.userId);
    },
  );

  /**
   * Fim de semana com pendências: o gestor transfere tarefas não iniciadas/pausadas para outra
   * semana em fila já publicada. Nunca automático; responsável, andamento e histórico ficam;
   * repetir não duplica nada (tarefas já transferidas são ignoradas).
   */
  app.post(
    '/api/v1/production-plans/:id/carry-over',
    { config: { access: PLAN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = carryOverSchema.parse(request.body);
      const actor = actorFrom(request);
      if (input.toPlanId === id) throw Errors.business('Escolha outra semana de destino.');
      const moved = await prisma.$transaction(async (tx) => {
        // Ordem fixa das travas: evita impasse com uma transferência no sentido contrário.
        const [a, b] = [id, input.toPlanId].sort();
        const pa = await lockPlan(tx, a!);
        const pb = await lockPlan(tx, b!);
        const from = pa.id === id ? pa : pb;
        const to = pa.id === id ? pb : pa;
        if (from.mode !== 'FILA_SEMANAL' || to.mode !== 'FILA_SEMANAL')
          throw Errors.business('A transferência de pendências vale só entre semanas em fila.');
        if (from.status !== 'PUBLICADO' || to.status !== 'PUBLICADO')
          throw Errors.business('As duas semanas precisam estar publicadas.');
        if (to.weekStart <= from.weekStart)
          throw Errors.business('A semana de destino deve ser posterior.');
        if (!(await weekEnded(tx, from.weekStart)))
          throw Errors.business(
            'A semana ainda não terminou: reordene a fila em vez de transferir.',
          );
        await lockTasks(tx, input.taskIds);
        const tasks = await tx.productionTask.findMany({ where: { id: { in: input.taskIds } } });
        if (tasks.length !== new Set(input.taskIds).size) throw Errors.notFound('Tarefa');
        const todo = tasks.filter((t) => !(t.planId === to.id && t.carriedFromPlanId));
        for (const t of todo) {
          if (t.planId !== from.id)
            throw Errors.business(`${taskCode(t.number)} não é desta semana.`);
          if (t.supportForTaskId)
            throw Errors.business(`${taskCode(t.number)} é um apoio: não é transferível.`);
          if (!CARRYABLE.includes(t.status))
            throw Errors.business(
              `${taskCode(t.number)} não pode ser transferida (${t.status === 'EM_EXECUCAO' ? 'em execução: pause antes' : 'já encerrada'}).`,
            );
        }
        if (!todo.length) return [];
        // A OS precisa constar da semana de destino (mesmo principal e prioridade da origem).
        for (const soId of [...new Set(todo.map((t) => t.serviceOrderId))]) {
          const exists = await tx.productionPlanItem.findUnique({
            where: { planId_serviceOrderId: { planId: to.id, serviceOrderId: soId } },
          });
          if (exists) continue;
          const src = await tx.productionPlanItem.findUnique({
            where: { planId_serviceOrderId: { planId: from.id, serviceOrderId: soId } },
          });
          await tx.productionPlanItem.create({
            data: {
              planId: to.id,
              serviceOrderId: soId,
              principalUserId: src?.principalUserId ?? null,
              priority: src?.priority ?? 'NORMAL',
            },
          });
        }
        for (const t of todo) {
          await tx.productionTask.update({
            where: { id: t.id },
            data: {
              planId: to.id,
              carriedFromPlanId: t.carriedFromPlanId ?? from.id,
              queuePosition: null,
              version: { increment: 1 },
            },
          });
          await taskEvent(tx, actor, null, t, {
            kind: 'TRANSFERIDA_SEMANA',
            note: input.reason,
            changes: {
              fromWeek: dateOnly(from.weekStart),
              toWeek: dateOnly(to.weekStart),
            },
          });
        }
        const codes = todo.map((t) => taskCode(t.number)).join(', ');
        await reviseIfPublished(
          tx,
          request,
          from.id,
          input.reason,
          `pendências transferidas: ${codes}`,
        );
        await reviseIfPublished(tx, request, to.id, input.reason, `pendências recebidas: ${codes}`);
        await audit(tx, actor, {
          action: 'production.tasks_carried',
          entityType: 'production_plan',
          entityId: from.id,
          summary: `${todo.length} pendência(s) da semana ${dateOnly(from.weekStart)} transferida(s) para ${dateOnly(to.weekStart)}: ${codes}. Motivo: ${input.reason}`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.PRODUCTION_TASKS_CARRIED,
          aggregateType: 'production_plan',
          aggregateId: from.id,
          payload: { id: from.id, toPlanId: to.id, count: todo.length },
          audience: audienceFor(...todo.map((t) => t.assigneeUserId)),
        });
        await reevaluateTasks(
          tx,
          actor,
          todo.map((t) => t.id),
        );
        await announceAssignments(
          tx,
          actor,
          todo.map((t) => t.id),
          {
            key: `TRANSFERENCIA:${to.id}:${todo[0]!.id}`,
            lead: `Pendências da semana de ${dateOnly(from.weekStart)!.split('-').reverse().join('/')} transferidas`,
          },
        );
        return todo.map((t) => t.id);
      });
      return { moved: moved.length, taskIds: moved };
    },
  );
}
