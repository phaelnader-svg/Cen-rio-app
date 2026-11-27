import {
  operationalItemState,
  operationalOrderState,
  type FulfillmentStage,
  type OperationalStateDto,
  type TaskStatus,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import { requiredTaskWhere } from '../quality/common';

/**
 * Reformulação, Fase 0 — estado operacional da OS (somente leitura, nada é gravado). Entradas: a
 * etapa canônica de cada peça e as tarefas obrigatórias pelo MESMO recorte usado na etapa
 * (`requiredTaskWhere`), acrescido dos rascunhos (para distinguir "não planejada").
 */
export async function loadOperationalState(
  db: Tx | PrismaClient,
  serviceOrderId: string,
): Promise<OperationalStateDto | null> {
  return (await loadOperationalStates(db, [serviceOrderId])).get(serviceOrderId) ?? null;
}

/**
 * Reformulação, Fase 3 — o mesmo cálculo para várias OS de uma vez (listas): duas consultas no
 * total, com o MESMO recorte de tarefas por peça de `loadOperationalState` (tarefas da peça e da
 * OS inteira, sem apoio/ocorrência/correção/embalagem, sem canceladas, com rascunhos). Uma regra
 * só para todas as telas: a lista, o cabeçalho da OS e a API mostram o mesmo estado.
 */
export async function loadOperationalStates(
  db: Tx | PrismaClient,
  serviceOrderIds: readonly string[],
): Promise<Map<string, OperationalStateDto>> {
  const out = new Map<string, OperationalStateDto>();
  if (!serviceOrderIds.length) return out;
  const orders = await db.serviceOrder.findMany({
    where: { id: { in: [...serviceOrderIds] } },
    select: {
      id: true,
      status: true,
      items: {
        select: { id: true, serviceOrderId: true, fulfillmentStage: true },
        orderBy: { position: 'asc' },
      },
    },
  });
  const sample = requiredTaskWhere({ id: '', serviceOrderId: '' });
  const tasks = await db.productionTask.findMany({
    where: {
      serviceOrderId: { in: orders.map((o) => o.id) },
      supportForTaskId: sample.supportForTaskId,
      issueId: sample.issueId,
      inspectionId: sample.inspectionId,
      activity: sample.activity,
      status: { not: 'CANCELADA' },
    },
    select: { serviceOrderId: true, serviceOrderItemId: true, status: true, blockers: true },
  });
  for (const so of orders) {
    const items = so.items.map((item) => {
      const mine = tasks.filter(
        (t) =>
          t.serviceOrderId === so.id &&
          (t.serviceOrderItemId === item.id || t.serviceOrderItemId === null),
      );
      const stage = item.fulfillmentStage as FulfillmentStage;
      return {
        serviceOrderItemId: item.id,
        stage,
        ...operationalItemState({
          stage,
          tasks: mine.map((t) => ({ status: t.status as TaskStatus, blockers: t.blockers })),
        }),
      };
    });
    out.set(so.id, {
      serviceOrderId: so.id,
      ...operationalOrderState(items, so.status === 'CANCELADA'),
      items,
    });
  }
  return out;
}
