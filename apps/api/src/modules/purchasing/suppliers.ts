import {
  EVENT_TYPES,
  supplierSchema,
  updateSupplierSchema,
  type SupplierDto,
} from '@cenario/shared';
import type { Prisma, PurchaseOrderStatus, Supplier } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { Errors } from '../../lib/errors';
import { idParams } from '../presenters';
import { MANAGEMENT_AUDIENCE, PURCHASE_MANAGE, PURCHASE_VIEW, lockRows } from './common';

function toDto(s: Supplier & { _count?: { purchaseOrders: number } }): SupplierDto {
  return {
    id: s.id,
    name: s.name,
    contactName: s.contactName,
    phone: s.phone,
    email: s.email,
    address: s.address,
    categories: s.categories,
    notes: s.notes,
    active: s.active,
    openOrders: s._count?.purchaseOrders ?? 0,
    version: s.version,
  };
}

const openOrdersCount = {
  _count: {
    select: {
      purchaseOrders: {
        where: {
          status: {
            in: ['RASCUNHO', 'CONFIRMADO', 'PARCIALMENTE_RECEBIDO'] as PurchaseOrderStatus[],
          },
        },
      },
    },
  },
} satisfies Prisma.SupplierInclude;

export async function supplierRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/suppliers', { config: { access: PURCHASE_VIEW } }, async () => {
    const rows = await prisma.supplier.findMany({
      include: openOrdersCount,
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
    return rows.map(toDto);
  });

  app.post('/api/v1/suppliers', { config: { access: PURCHASE_MANAGE } }, async (request, reply) => {
    const input = supplierSchema.parse(request.body);
    const actor = actorFrom(request);
    const s = await prisma.$transaction(async (tx) => {
      const dup = await tx.supplier.findFirst({
        where: { name: { equals: input.name, mode: 'insensitive' } },
      });
      if (dup) throw Errors.conflict('Já existe um fornecedor com este nome.');
      const created = await tx.supplier.create({ data: input });
      await audit(tx, actor, {
        action: 'supplier.created',
        entityType: 'supplier',
        entityId: created.id,
        summary: `Fornecedor ${created.name} cadastrado.`,
      });
      await appendEvent(tx, actor, {
        type: EVENT_TYPES.SUPPLIER_CHANGED,
        aggregateType: 'supplier',
        aggregateId: created.id,
        payload: { id: created.id },
        audience: MANAGEMENT_AUDIENCE,
      });
      return created;
    });
    return reply.status(201).send(toDto(s));
  });

  app.put('/api/v1/suppliers/:id', { config: { access: PURCHASE_MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { version, ...input } = updateSupplierSchema.parse(request.body);
    const actor = actorFrom(request);
    const s = await prisma.$transaction(async (tx) => {
      await lockRows(tx, 'suppliers', [id]);
      const cur = await tx.supplier.findUnique({ where: { id } });
      if (!cur) throw Errors.notFound('Fornecedor');
      if (cur.version !== version) throw Errors.versionConflict(cur.version);
      const dup = await tx.supplier.findFirst({
        where: { id: { not: id }, name: { equals: input.name, mode: 'insensitive' } },
      });
      if (dup) throw Errors.conflict('Já existe um fornecedor com este nome.');
      const updated = await tx.supplier.update({
        where: { id },
        data: { ...input, version: { increment: 1 } },
        include: openOrdersCount,
      });
      await audit(tx, actor, {
        action: 'supplier.updated',
        entityType: 'supplier',
        entityId: id,
        summary: `Fornecedor ${updated.name} atualizado.`,
      });
      await appendEvent(tx, actor, {
        type: EVENT_TYPES.SUPPLIER_CHANGED,
        aggregateType: 'supplier',
        aggregateId: id,
        payload: { id },
        audience: MANAGEMENT_AUDIENCE,
      });
      return updated;
    });
    return toDto(s);
  });
}
