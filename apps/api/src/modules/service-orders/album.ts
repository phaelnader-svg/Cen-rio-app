import type { PrismaClient, Tx } from '@cenario/db';
import type { AttachmentEntity, OsAlbumDto, OsAlbumPhoto } from '@cenario/shared';
import { serviceOrderCode } from '../commercial/common';

/**
 * Melhoria 82: álbum de antes e depois de uma OS. Junta as fotos que o sistema já guarda em cada
 * etapa, sem pedir nada a mais:
 * - antes: pedido, retirada, recebimento antigo, OS e peças (como a peça chegou);
 * - durante: tarefas da produção (inclui as etapas com foto obrigatória, melhoria 118);
 * - depois: inspeção de qualidade, embalagem antiga e entrega.
 * Fotos de ocorrências ficam fora (são internas).
 */
const PHASE: Partial<Record<AttachmentEntity, keyof Pick<OsAlbumDto, 'before' | 'during' | 'after'>>> = {
  COMMERCIAL_ORDER: 'before',
  PICKUP: 'before',
  RECEIPT: 'before',
  SERVICE_ORDER: 'before',
  SERVICE_ORDER_ITEM: 'before',
  PRODUCTION_TASK: 'during',
  QUALITY_INSPECTION: 'after',
  PACKAGING: 'after',
  DELIVERY: 'after',
};

export async function loadOsAlbum(
  db: Tx | PrismaClient,
  serviceOrderId: string,
  fileUrl: (fileId: string, thumb: boolean) => string,
): Promise<OsAlbumDto | null> {
  const os = await db.serviceOrder.findUnique({
    where: { id: serviceOrderId },
    select: {
      id: true,
      number: true,
      orderId: true,
      customer: { select: { name: true } },
      company: { select: { tradeName: true } },
      items: { select: { id: true, description: true } },
      productionTasks: { select: { id: true } },
      inspections: { select: { id: true } },
    },
  });
  if (!os) return null;
  const itemIds = os.items.map((i) => i.id);
  const [pickups, receipts, deliveries] = await Promise.all([
    db.pickupRequest.findMany({ where: { orderId: os.orderId }, select: { id: true } }),
    db.receipt.findMany({ where: { orderId: os.orderId }, select: { id: true } }),
    db.deliveryItem.findMany({
      where: { serviceOrderItemId: { in: itemIds } },
      select: { deliveryId: true },
    }),
  ]);
  const byType: [AttachmentEntity, string[]][] = [
    ['COMMERCIAL_ORDER', [os.orderId]],
    ['PICKUP', pickups.map((p) => p.id)],
    ['RECEIPT', receipts.map((r) => r.id)],
    ['SERVICE_ORDER', [os.id]],
    ['SERVICE_ORDER_ITEM', itemIds],
    ['PRODUCTION_TASK', os.productionTasks.map((t) => t.id)],
    ['QUALITY_INSPECTION', os.inspections.map((i) => i.id)],
    ['DELIVERY', [...new Set(deliveries.map((d) => d.deliveryId))]],
  ];
  const rows = await db.attachment.findMany({
    where: {
      deletedAt: null,
      file: { mimeType: { startsWith: 'image/' } },
      OR: byType
        .filter(([, ids]) => ids.length)
        .map(([entityType, ids]) => ({ entityType, entityId: { in: ids } })),
    },
    include: { file: { select: { width: true, height: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const album: OsAlbumDto = {
    serviceOrderId: os.id,
    code: serviceOrderCode(os.number),
    customerName: os.customer.name,
    companyName: os.company.tradeName,
    pieces: os.items.map((i) => i.description),
    before: [],
    during: [],
    after: [],
  };
  for (const a of rows) {
    const phase = PHASE[a.entityType as AttachmentEntity];
    if (!phase) continue;
    const photo: OsAlbumPhoto = {
      fileId: a.fileId,
      url: fileUrl(a.fileId, false),
      thumbUrl: fileUrl(a.fileId, true),
      caption: a.caption,
      width: a.file.width,
      height: a.file.height,
      createdAt: a.createdAt.toISOString(),
    };
    album[phase].push(photo);
  }
  return album;
}

/** O arquivo pertence ao álbum desta OS? (leitura pública das fotos pelo link do cliente). */
export async function albumHasFile(
  db: Tx | PrismaClient,
  serviceOrderId: string,
  fileId: string,
): Promise<boolean> {
  const album = await loadOsAlbum(db, serviceOrderId, (id) => id);
  if (!album) return false;
  return [...album.before, ...album.during, ...album.after].some((p) => p.fileId === fileId);
}
