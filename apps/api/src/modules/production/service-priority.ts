import type { Priority } from '@cenario/shared';
import type { Tx } from '@cenario/db';
import type { ActorContext } from '../../core/types';
import { serviceOrderCode } from '../commercial/common';
import { lockPlan, lockTasks } from './common';
import { reviseIfPublishedBy } from './plans';
import { placeServiceInQueue } from './queue-placement';

const STARTED = ['EM_EXECUCAO', 'PAUSADA', 'CONCLUIDA'];

/** Trava por OS (a mesma da reprogramação): quem muda prioridade de uma OS passa por ela antes. */
export async function lockServicePlanning(tx: Tx, serviceOrderId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`so-plan:${serviceOrderId}`}))`;
}

/**
 * Saneamento — a prioridade é DO SERVIÇO: uma mudança, venha da OS ou do planejamento, vale na OS,
 * nos itens de planejamento da OS que ainda têm tarefas não iniciadas e nessas tarefas. Mesma
 * regra já homologada na reprogramação: tarefas iniciadas/concluídas não mudam; no modo fila a OS
 * recalcula só a PRÓPRIA posição inicial (D9) na nova faixa de prioridade — a ordem manual das
 * demais OS não muda. O prazo prometido não entra aqui (fica só na OS e não reordena nada).
 * O chamador já detém `lockServicePlanning` desta OS.
 */
export async function applyServicePriority(
  tx: Tx,
  actor: ActorContext,
  serviceOrderId: string,
  priority: Priority,
  reason: string | null | undefined,
  /** `revisedPlanId`: plano cuja revisão o chamador já registra (evita revisão dupla). */
  opts: { updateServiceOrder: boolean; revisedPlanId?: string },
) {
  const so = await tx.serviceOrder.findUniqueOrThrow({
    where: { id: serviceOrderId },
    select: { number: true, priority: true },
  });
  if (opts.updateServiceOrder && so.priority !== priority)
    await tx.serviceOrder.update({
      where: { id: serviceOrderId },
      data: { priority, version: { increment: 1 } },
    });
  const items = await tx.productionPlanItem.findMany({
    where: { serviceOrderId },
    include: { plan: { select: { id: true, mode: true } } },
    orderBy: { planId: 'asc' },
  });
  const code = serviceOrderCode(so.number);
  for (const item of items) {
    const tasks = await tx.productionTask.findMany({
      where: { planId: item.planId, serviceOrderId, status: { not: 'CANCELADA' } },
      select: { id: true, status: true, startedAt: true, priority: true },
    });
    const open = tasks.filter((t) => !STARTED.includes(t.status) && !t.startedAt);
    if (!open.length) continue;
    await lockPlan(tx, item.planId);
    await lockTasks(
      tx,
      open.map((t) => t.id),
    );
    const changedTasks = open.filter((t) => t.priority !== priority);
    if (item.priority === priority && !changedTasks.length) continue;
    if (item.priority !== priority)
      await tx.productionPlanItem.update({
        where: { id: item.id },
        data: { priority, version: { increment: 1 } },
      });
    for (const t of changedTasks)
      await tx.productionTask.update({
        where: { id: t.id },
        data: { priority, version: { increment: 1 } },
      });
    if (item.plan.mode === 'FILA_SEMANAL')
      await placeServiceInQueue(tx, item.planId, serviceOrderId);
    if (item.planId !== opts.revisedPlanId && open.some((t) => t.status !== 'RASCUNHO'))
      await reviseIfPublishedBy(tx, actor, item.planId, reason, `${code}: prioridade ${priority}`);
  }
}
