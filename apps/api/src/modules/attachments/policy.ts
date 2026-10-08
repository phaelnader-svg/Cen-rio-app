import type { AttachmentEntity, Permission } from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';

/** Quem pode VER fotos de cada tipo de registro (basta uma das permissões). */
export const VIEW_PERMISSIONS: Record<AttachmentEntity, Permission[]> = {
  COMMERCIAL_ORDER: ['pedidos.ver', 'os.ver'],
  PICKUP: ['retiradas.ver', 'pedidos.ver'],
  RECEIPT: ['pedidos.ver', 'recebimentos.registrar', 'os.ver'],
  SERVICE_ORDER: ['os.ver'],
  SERVICE_ORDER_ITEM: ['os.ver'],
};

/** Quem pode ENVIAR/REMOVER fotos de cada tipo de registro. */
export const MANAGE_PERMISSIONS: Record<AttachmentEntity, Permission[]> = {
  COMMERCIAL_ORDER: ['pedidos.gerenciar'],
  PICKUP: ['retiradas.gerenciar'],
  RECEIPT: ['recebimentos.registrar'],
  SERVICE_ORDER: ['os.gerenciar'],
  SERVICE_ORDER_ITEM: ['os.gerenciar'],
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
  return count > 0;
}
