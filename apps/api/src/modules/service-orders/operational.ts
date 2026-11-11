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
  const so = await db.serviceOrder.findUnique({
    where: { id: serviceOrderId },
    select: {
      id: true,
      status: true,
      items: {
        select: { id: true, serviceOrderId: true, fulfillmentStage: true },
        orderBy: { position: 'asc' },
      },
    },
  });
  if (!so) return null;
  const items = await Promise.all(
    so.items.map(async (item) => {
      const tasks = await db.productionTask.findMany({
        where: { ...requiredTaskWhere(item), status: { not: 'CANCELADA' } },
        select: { status: true, blockers: true },
      });
      const stage = item.fulfillmentStage as FulfillmentStage;
      return {
        serviceOrderItemId: item.id,
        stage,
        ...operationalItemState({
          stage,
          tasks: tasks.map((t) => ({ status: t.status as TaskStatus, blockers: t.blockers })),
        }),
      };
    }),
  );
  return {
    serviceOrderId: so.id,
    ...operationalOrderState(items, so.status === 'CANCELADA'),
    items,
  };
}
