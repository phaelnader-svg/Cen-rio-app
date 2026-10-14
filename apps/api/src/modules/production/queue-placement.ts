import { compareQueue, placeByStartDate } from '@cenario/shared';
import type { Tx } from '@cenario/db';
import { dateOnly } from '../commercial/common';

/**
 * D9 (decisão C) — a data de início define a posição INICIAL das tarefas na fila semanal.
 *
 * Chamado ao planejar uma OS, ao reprogramá-la (data ou prioridade) e ao publicar o rascunho de
 * uma semana já publicada. SEMPRE dentro da transação que já trava o plano (`lockPlan`), a mesma
 * trava da reordenação manual — por isso duas operações sobre a fila de um plano nunca se
 * intercalam nem perdem posições.
 *
 * Para cada pessoa com tarefa principal ainda não iniciada desta OS no plano:
 *  1. lê a fila atual dela no plano (tarefas principais não concluídas/canceladas, na ordem
 *     vigente de `compareQueue`, que inclui as posições definidas pelo gestor);
 *  2. retira as tarefas da OS e as reinsere pela regra de `placeByStartDate`;
 *  3. grava as posições 1..n. A ordem relativa das demais tarefas não muda (por isso a versão
 *     delas não é alterada); só as tarefas posicionadas ganham nova versão.
 *
 * Não altera prioridade, estado, data, titular nem a trava de liberação (que continua sendo a
 * data de início do item do plano, avaliada em `evaluateRelease`). Tarefas já iniciadas ficam
 * onde estão. Devolve quantas tarefas tiveram a posição alterada.
 */
const QUEUED = ['RASCUNHO', 'BLOQUEADA', 'PROGRAMADA', 'LIBERADA', 'EM_EXECUCAO', 'PAUSADA'];
const NOT_STARTED = ['RASCUNHO', 'BLOQUEADA', 'PROGRAMADA', 'LIBERADA'];

export async function placeServiceInQueue(
  tx: Tx,
  planId: string,
  serviceOrderId: string,
): Promise<number> {
  const mine = await tx.productionTask.findMany({
    where: {
      planId,
      serviceOrderId,
      supportForTaskId: null,
      assigneeUserId: { not: null },
      status: { in: NOT_STARTED as never },
      startedAt: null,
    },
    select: { id: true, assigneeUserId: true },
  });
  if (!mine.length) return 0;
  const items = await tx.productionPlanItem.findMany({
    where: { planId },
    select: { serviceOrderId: true, startDate: true },
  });
  const startOf = new Map(items.map((i) => [i.serviceOrderId, dateOnly(i.startDate) ?? null]));
  const placing = new Set(mine.map((t) => t.id));
  let changed = 0;
  for (const userId of [...new Set(mine.map((t) => t.assigneeUserId!))].sort()) {
    const queue = await tx.productionTask.findMany({
      where: {
        planId,
        assigneeUserId: userId,
        supportForTaskId: null,
        status: { in: QUEUED as never },
      },
      select: {
        id: true,
        serviceOrderId: true,
        priority: true,
        queuePosition: true,
        sequence: true,
        number: true,
      },
    });
    const ordered = [...queue].sort((a, b) =>
      compareQueue({ ...a, weekStart: null }, { ...b, weekStart: null }),
    );
    const entry = (t: (typeof queue)[number]) => ({
      id: t.id,
      priority: t.priority,
      startDate: startOf.get(t.serviceOrderId) ?? null,
    });
    const order = placeByStartDate(
      ordered.filter((t) => !placing.has(t.id)).map(entry),
      ordered.filter((t) => placing.has(t.id)).map(entry),
    );
    const byId = new Map(queue.map((t) => [t.id, t]));
    for (const [i, id] of order.entries()) {
      const t = byId.get(id)!;
      if (t.queuePosition === i + 1) continue;
      await tx.productionTask.update({
        where: { id },
        data: {
          queuePosition: i + 1,
          ...(placing.has(id) ? { version: { increment: 1 } } : {}),
        },
      });
      if (placing.has(id)) changed++;
    }
  }
  return changed;
}
