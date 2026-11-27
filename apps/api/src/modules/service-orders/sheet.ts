import {
  formatServiceOrderItemCode,
  reworkCode,
  type MeasurementDto,
  type ServiceOrderSheetDto,
} from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { Errors } from '../../lib/errors';
import { orderCode, serviceOrderCode } from '../commercial/common';
import { idParams } from '../presenters';
import { requireCompanyId } from '../../core/tenant';
import { ownInstructions, ownItemNotes, quoteWork } from './quote-work';

/**
 * 2026-11-18 (Raphael): a OS como uma página organizada para a oficina — "Abrir OS" no tablet e
 * no painel. Só detalhes do serviço (peças, tecido, espuma, medidas, instruções, materiais, fotos
 * e tarefas); nenhum valor. Quem não tem os.ver/produção vê só a OS em que tem tarefa publicada.
 */
const SHEET = {
  session: 'any',
  anyPermissions: ['os.ver', 'producao.ver', 'producao.planejar', 'producao.executar'],
} as const;

export async function serviceOrderSheetRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get(
    '/api/v1/service-orders/:id/sheet',
    { config: { access: SHEET } },
    async (request): Promise<ServiceOrderSheetDto> => {
      const { id } = idParams.parse(request.params);
      const perms = request.auth!.permissions;
      const me = request.auth!.userId;
      const general = (['os.ver', 'producao.ver', 'producao.planejar'] as const).some((p) =>
        perms.has(p),
      );
      if (!general) {
        const mine = await prisma.productionTask.count({
          where: {
            serviceOrderId: id,
            assigneeUserId: me,
            status: { notIn: ['RASCUNHO', 'CANCELADA'] },
          },
        });
        if (!mine) throw Errors.forbidden('Esta OS não tem tarefa sua.');
      }
      const so = await prisma.serviceOrder.findUnique({
        where: { id },
        include: {
          customer: { select: { name: true } },
          order: {
            select: {
              number: true,
              rework: { select: { number: true, reason: true } },
            },
          },
          technicalLead: { select: { displayName: true } },
          items: { orderBy: { position: 'asc' } },
          simpleMaterials: {
            where: { removedAt: null },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          },
          productionTasks: {
            where: { status: { notIn: ['RASCUNHO', 'CANCELADA'] } },
            select: { title: true, status: true, assignee: { select: { displayName: true } } },
            orderBy: [{ sequence: 'asc' }, { number: 'asc' }],
          },
        },
      });
      if (!so) throw Errors.notFound('OS');
      const [company, people, attachments] = await Promise.all([
        prisma.companySettings.findUniqueOrThrow({
          where: { id: requireCompanyId() },
          select: { tradeName: true },
        }),
        prisma.user.findMany({
          where: {
            id: {
              in: so.items.map((i) => i.upholstererUserId).filter((x): x is string => Boolean(x)),
            },
          },
          select: { id: true, displayName: true },
        }),
        prisma.attachment.findMany({
          where: {
            deletedAt: null,
            OR: [
              { entityType: 'SERVICE_ORDER', entityId: so.id },
              { entityType: 'SERVICE_ORDER_ITEM', entityId: { in: so.items.map((i) => i.id) } },
            ],
          },
          include: { file: { select: { mimeType: true } } },
          orderBy: { createdAt: 'asc' },
        }),
      ]);
      // 2026-11-19 (Raphael): o que o orçamento aprovado diz sobre a execução, em partes.
      const quote = await prisma.quote.findFirst({
        where: { orderId: so.orderId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { number: true, snapshot: true, workOrder: true },
      });
      const work = quote ? quoteWork(quote) : null;
      const name = new Map(people.map((p) => [p.id, p.displayName]));
      const code = (itemId: string) => {
        const it = so.items.find((i) => i.id === itemId);
        return it ? formatServiceOrderItemCode(so.number, it.position) : null;
      };
      return {
        id: so.id,
        code: serviceOrderCode(so.number),
        status: so.status,
        companyName: company.tradeName,
        customerName: so.customer.name,
        orderCode: orderCode(so.order.number),
        rework: so.order.rework
          ? { code: reworkCode(so.order.rework.number), reason: so.order.rework.reason }
          : null,
        promisedDate: so.promisedDate ? so.promisedDate.toISOString().slice(0, 10) : null,
        priority: so.priority,
        technicalLead: so.technicalLead?.displayName ?? null,
        createdAt: so.createdAt.toISOString(),
        technicalInstructions: ownInstructions(so.technicalInstructions, work),
        notes: so.notes,
        work,
        items: so.items.map((i) => ({
          id: i.id,
          code: formatServiceOrderItemCode(so.number, i.position),
          pieceType: i.pieceType,
          serviceType: i.serviceType,
          description: i.description,
          quantity: i.quantity,
          fabricName: i.fabricName,
          fabricColor: i.fabricColor,
          fabricReference: i.fabricReference,
          foamSpecs: i.foamSpecs,
          technicalNotes: ownItemNotes(i.technicalNotes, work),
          measurements: Array.isArray(i.measurements)
            ? (i.measurements as unknown as MeasurementDto[])
            : [],
          measurementNotes: i.measurementNotes,
          upholsterer: i.upholstererUserId ? (name.get(i.upholstererUserId) ?? null) : null,
        })),
        materials: so.simpleMaterials.map((m) => ({
          description: m.description,
          quantity: m.quantity === null ? null : String(m.quantity).replace('.', ','),
          unit: m.unit,
          available: m.available,
        })),
        tasks: so.productionTasks.map((t) => ({
          title: t.title,
          status: t.status,
          assignee: t.assignee?.displayName ?? null,
        })),
        photos: attachments
          .filter((a) => a.file.mimeType.startsWith('image/'))
          .map((a) => ({
            url: `/api/files/${a.fileId}`,
            thumbUrl: `/api/files/${a.fileId}/miniatura`,
            caption: a.caption,
            itemCode: a.entityType === 'SERVICE_ORDER_ITEM' ? code(a.entityId) : null,
          })),
      };
    },
  );
}
