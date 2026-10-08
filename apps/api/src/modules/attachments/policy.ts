import type { AttachmentEntity, Permission } from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';

/** Quem pode VER fotos de cada tipo de registro (basta uma das permissões). */
export const VIEW_PERMISSIONS: Record<AttachmentEntity, Permission[]> = {
  COMMERCIAL_ORDER: ['pedidos.ver', 'os.ver'],
  PICKUP: ['retiradas.ver', 'pedidos.ver'],
  RECEIPT: ['pedidos.ver', 'recebimentos.registrar', 'os.ver'],
  SERVICE_ORDER: ['os.ver'],
  SERVICE_ORDER_ITEM: ['os.ver'],
  PRODUCTION_TASK: ['producao.ver', 'producao.planejar'],
  PRODUCTION_ISSUE: ['ocorrencias.ver', 'ocorrencias.gerenciar'],
  QUALITY_INSPECTION: ['qualidade.gerenciar', 'entregas.ver', 'entregas.gerenciar'],
  PACKAGING: ['qualidade.gerenciar', 'entregas.ver', 'entregas.gerenciar'],
  DELIVERY: ['entregas.ver', 'entregas.gerenciar'],
  LOGISTICS_OCCURRENCE: ['entregas.ver', 'entregas.gerenciar'],
};

/** Quem pode ENVIAR/REMOVER fotos de cada tipo de registro. */
export const MANAGE_PERMISSIONS: Record<AttachmentEntity, Permission[]> = {
  COMMERCIAL_ORDER: ['pedidos.gerenciar'],
  PICKUP: ['retiradas.gerenciar'],
  RECEIPT: ['recebimentos.registrar'],
  SERVICE_ORDER: ['os.gerenciar'],
  SERVICE_ORDER_ITEM: ['os.gerenciar'],
  PRODUCTION_TASK: ['producao.planejar'],
  PRODUCTION_ISSUE: ['ocorrencias.gerenciar'],
  QUALITY_INSPECTION: ['qualidade.gerenciar'],
  PACKAGING: ['qualidade.gerenciar'],
  DELIVERY: ['entregas.gerenciar'],
  LOGISTICS_OCCURRENCE: ['entregas.gerenciar'],
};

export function allowed(perms: ReadonlySet<Permission>, list: Permission[]): boolean {
  return list.some((p) => perms.has(p));
}

export async function entityExists(
  db: PrismaClient | Tx,
  type: AttachmentEntity,
  id: string,
): Promise<boolean> {
  switch (type) {
    case 'COMMERCIAL_ORDER':
      return (await db.commercialOrder.count({ where: { id } })) > 0;
    case 'PICKUP':
      return (await db.pickupRequest.count({ where: { id } })) > 0;
    case 'RECEIPT':
      return (await db.receipt.count({ where: { id } })) > 0;
    case 'SERVICE_ORDER':
      return (await db.serviceOrder.count({ where: { id } })) > 0;
    case 'SERVICE_ORDER_ITEM':
      return (await db.serviceOrderItem.count({ where: { id } })) > 0;
    case 'PRODUCTION_TASK':
      return (await db.productionTask.count({ where: { id } })) > 0;
    case 'PRODUCTION_ISSUE':
      return (await db.productionIssue.count({ where: { id } })) > 0;
    case 'QUALITY_INSPECTION':
      return (await db.qualityInspection.count({ where: { id } })) > 0;
    case 'PACKAGING':
      return (await db.packagingRecord.count({ where: { id } })) > 0;
    case 'DELIVERY':
      return (await db.delivery.count({ where: { id } })) > 0;
    case 'LOGISTICS_OCCURRENCE':
      return (await db.logisticsOccurrence.count({ where: { id } })) > 0;
  }
}

/**
 * Quem executa uma medição atribuída pode ver as fotos da OS correspondente
 * (mesmo sem permissão geral de ver OS).
 */
export async function viewableAsMeasurementAssignee(
  db: PrismaClient | Tx,
  userId: string,
  type: AttachmentEntity,
  id: string,
): Promise<boolean> {
  // Fase 10: fotos da qualidade e da logística — inspetor, quem embala, quem entrega.
  const own = await viewableAsQualityParticipant(db, userId, type, id);
  if (own !== null) return own;
  // Fase 9: fotos da ocorrência — quem registrou e quem resolve.
  if (type === 'PRODUCTION_ISSUE') {
    return (
      (await db.productionIssue.count({
        where: { id, OR: [{ reporterUserId: userId }, { assigneeUserId: userId }] },
      })) > 0
    );
  }
  // Fase 6: fotos da própria tarefa (andamento/conclusão).
  if (type === 'PRODUCTION_TASK') {
    return (
      (await db.productionTask.count({
        where: { id, assigneeUserId: userId, status: { not: 'RASCUNHO' } },
      })) > 0
    );
  }
  if (type !== 'SERVICE_ORDER' && type !== 'SERVICE_ORDER_ITEM') return false;
  const serviceOrderId =
    type === 'SERVICE_ORDER'
      ? id
      : (await db.serviceOrderItem.findUnique({ where: { id }, select: { serviceOrderId: true } }))
          ?.serviceOrderId;
  if (!serviceOrderId) return false;
  const count = await db.measurement.count({
    where: { serviceOrderId, assigneeUserId: userId, status: { not: 'CANCELADA' } },
  });
  if (count > 0) return true;
  // Fase 5: quem tem tarefa de produção publicada da OS também vê as fotos.
  const tasks = await db.productionTask.count({
    where: { serviceOrderId, assigneeUserId: userId, status: { notIn: ['RASCUNHO', 'CANCELADA'] } },
  });
  return tasks > 0;
}

/**
 * Fase 6: o responsável envia fotos da própria tarefa enquanto a executa
 * (em execução ou pausada) — sem permissão geral de anexos.
 */
export async function uploadableAsTaskAssignee(
  db: PrismaClient | Tx,
  userId: string,
  type: AttachmentEntity,
  id: string,
): Promise<boolean> {
  // Fase 10: inspetor (inspeção aberta), quem embala, quem executa a entrega.
  const own = await viewableAsQualityParticipant(db, userId, type, id, true);
  if (own !== null) return own;
  // Fase 9: evidência da ocorrência aberta — quem registrou ou quem está resolvendo.
  if (type === 'PRODUCTION_ISSUE') {
    return (
      (await db.productionIssue.count({
        where: {
          id,
          status: { in: ['ABERTA', 'ATRIBUIDA', 'EM_RESOLUCAO', 'AGUARDANDO_VERIFICACAO'] },
          OR: [{ reporterUserId: userId }, { assigneeUserId: userId }],
        },
      })) > 0
    );
  }
  if (type !== 'PRODUCTION_TASK') return false;
  return (
    (await db.productionTask.count({
      where: { id, assigneeUserId: userId, status: { in: ['EM_EXECUCAO', 'PAUSADA'] } },
    })) > 0
  );
}

/**
 * Fase 10: participação direta (null = não é um tipo da Fase 10).
 * - inspeção: o inspetor designado (envio só com a inspeção aberta);
 * - embalagem: quem embala (envio enquanto não concluída);
 * - entrega e ocorrência logística: o responsável pela entrega (e quem registrou a ocorrência).
 */
async function viewableAsQualityParticipant(
  db: PrismaClient | Tx,
  userId: string,
  type: AttachmentEntity,
  id: string,
  upload = false,
): Promise<boolean | null> {
  switch (type) {
    case 'QUALITY_INSPECTION':
      return (
        (await db.qualityInspection.count({
          where: {
            id,
            inspectorUserId: userId,
            ...(upload ? { status: { in: ['PENDENTE', 'EM_ANDAMENTO'] } } : {}),
          },
        })) > 0
      );
    case 'PACKAGING':
      return (
        (await db.packagingRecord.count({
          where: {
            id,
            assigneeUserId: userId,
            ...(upload ? { status: { in: ['PENDENTE', 'EM_ANDAMENTO'] } } : {}),
          },
        })) > 0
      );
    case 'DELIVERY':
      return (
        (await db.delivery.count({
          where: {
            id,
            responsibleUserId: userId,
            status: upload
              ? { in: ['AGENDADA', 'EM_TRANSPORTE', 'NO_DESTINO'] }
              : { not: 'PROVISORIA' },
          },
        })) > 0
      );
    case 'LOGISTICS_OCCURRENCE':
      return (
        (await db.logisticsOccurrence.count({
          where: {
            id,
            OR: [
              { reportedById: userId },
              { responsibleUserId: userId },
              { delivery: { responsibleUserId: userId } },
            ],
          },
        })) > 0
      );
    default:
      return null;
  }
}
