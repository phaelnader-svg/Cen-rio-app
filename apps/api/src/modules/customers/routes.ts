import {
  ERROR_CODES,
  EVENT_TYPES,
  createCustomerSchema,
  customerAddressSchema,
  customerQuerySchema,
  normalizeSearch,
  onlyDigits,
  updateCustomerSchema,
  type CustomerAddressDto,
  type CustomerDto,
  type DuplicateCandidateDto,
  type PageDto,
} from '@cenario/shared';
import {
  isUniqueViolation,
  type Customer,
  type CustomerAddress,
  type Prisma,
  type Tx,
} from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { diffObjects } from '../../lib/diff';
import { AppError, Errors } from '../../lib/errors';
import { idParams } from '../presenters';
import {
  can,
  orderCode,
  serviceOrderCode,
  snapshotAddress,
  toCustomerSummary,
} from '../commercial/common';

const VIEW = { session: 'WEB', permissions: ['clientes.ver'] } as const;
const MANAGE = { session: 'WEB', permissions: ['clientes.gerenciar'] } as const;
const AUDIENCE = 'permission:clientes.ver' as const;

const addressParams = z.object({ id: z.string().uuid(), addressId: z.string().uuid() });

function searchTextFor(c: {
  name: string;
  tradeName?: string | null;
  document?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
}): string {
  return normalizeSearch(
    [c.name, c.tradeName, c.document, c.phone, c.whatsapp, c.email].filter(Boolean).join(' '),
  ).slice(0, 800);
}

function toAddressDto(a: CustomerAddress): CustomerAddressDto {
  return { id: a.id, isPrimary: a.isPrimary, ...snapshotAddress(a) };
}

type CustomerFull = Customer & {
  addresses: CustomerAddress[];
  _count: { orders: number; serviceOrders: number };
};

const fullInclude = {
  addresses: {
    where: { archivedAt: null },
    orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }],
  },
  _count: { select: { orders: true, serviceOrders: true } },
} satisfies Prisma.CustomerInclude;

function toDto(c: CustomerFull): CustomerDto {
  return {
    ...toCustomerSummary(c),
    document: c.document,
    phone: c.phone,
    whatsapp: c.whatsapp,
    email: c.email,
    notes: c.notes,
    active: c.active,
    addresses: c.addresses.map(toAddressDto),
    orderCount: c._count.orders,
    serviceOrderCount: c._count.serviceOrders,
    version: c.version,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/**
 * Detecção de duplicidade:
 * - mesmo CPF/CNPJ → duplicidade evidente (bloqueia, também por índice único no banco);
 * - mesmo telefone/WhatsApp/e-mail ou nome idêntico → possível duplicidade: o
 *   cadastro só prossegue com confirmação explícita (pessoas diferentes podem
 *   compartilhar telefone, ou ter o mesmo nome).
 */
async function findDuplicates(
  tx: Tx,
  input: {
    document?: string | null;
    phone?: string | null;
    whatsapp?: string | null;
    email?: string | null;
    name: string;
  },
  excludeId?: string,
): Promise<{ hard: DuplicateCandidateDto[]; soft: DuplicateCandidateDto[] }> {
  const phones = [input.phone, input.whatsapp].filter((p): p is string => Boolean(p));
  const or: Prisma.CustomerWhereInput[] = [];
  if (input.document) or.push({ document: input.document });
  if (phones.length) or.push({ phone: { in: phones } }, { whatsapp: { in: phones } });
  if (input.email) or.push({ email: input.email });
  or.push({ name: { equals: input.name, mode: 'insensitive' } });
  const rows = await tx.customer.findMany({
    where: { OR: or, ...(excludeId ? { id: { not: excludeId } } : {}) },
    take: 10,
  });
  const hard: DuplicateCandidateDto[] = [];
  const soft: DuplicateCandidateDto[] = [];
  const name = normalizeSearch(input.name);
  for (const r of rows) {
    const reasons: DuplicateCandidateDto['reasons'] = [];
    if (input.document && r.document === input.document) reasons.push('documento');
    if (r.phone && phones.includes(r.phone)) reasons.push('telefone');
    if (r.whatsapp && phones.includes(r.whatsapp)) reasons.push('whatsapp');
    if (input.email && r.email === input.email) reasons.push('email');
    if (normalizeSearch(r.name) === name) reasons.push('nome');
    if (!reasons.length) continue;
    const candidate = { id: r.id, name: r.name, kind: r.kind, reasons };
    (reasons.includes('documento') ? hard : soft).push(candidate);
  }
  return { hard, soft };
}

function duplicateError(hard: DuplicateCandidateDto[], soft: DuplicateCandidateDto[]) {
  if (hard.length) {
    return Errors.conflict('Já existe um cliente com este CPF/CNPJ.', { candidates: hard });
  }
  return new AppError(
    409,
    ERROR_CODES.POSSIBLE_DUPLICATE,
    'Há clientes com dados semelhantes. Confira antes de cadastrar.',
    { candidates: soft },
  );
}

export async function customerRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/customers', { config: { access: VIEW } }, async (request) => {
    const q = customerQuerySchema.parse(request.query);
    const terms = q.q ? normalizeSearch(q.q).split(' ').filter(Boolean) : [];
    const digits = q.q ? onlyDigits(q.q) : '';
    const where: Prisma.CustomerWhereInput = {
      ...(q.includeArchived === 'true' ? {} : { active: true }),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.city
        ? {
            addresses: {
              some: { city: { contains: q.city, mode: 'insensitive' }, archivedAt: null },
            },
          }
        : {}),
      AND: terms.map((t) => ({
        OR: [
          { searchText: { contains: t } },
          ...(digits.length >= 4 && /^\d+$/.test(t) ? [{ searchText: { contains: digits } }] : []),
        ],
      })),
    };
    const [total, rows] = await Promise.all([
      prisma.customer.count({ where }),
      prisma.customer.findMany({
        where,
        include: fullInclude,
        orderBy: { name: 'asc' },
        take: q.limit,
        skip: q.offset,
      }),
    ]);
    return { items: rows.map(toDto), total } satisfies PageDto<CustomerDto>;
  });

  /**
   * Busca resumida (sem dados pessoais) para selecionar o cliente ao criar
   * pedidos — disponível também a quem gerencia pedidos sem ver o cadastro completo.
   */
  app.get(
    '/api/v1/customers/lookup',
    {
      config: { access: { session: 'WEB', anyPermissions: ['clientes.ver', 'pedidos.gerenciar'] } },
    },
    async (request) => {
      const q = z.object({ q: z.string().trim().max(100).default('') }).parse(request.query);
      const terms = normalizeSearch(q.q).split(' ').filter(Boolean);
      const rows = await prisma.customer.findMany({
        where: { active: true, AND: terms.map((t) => ({ searchText: { contains: t } })) },
        orderBy: { name: 'asc' },
        take: 20,
      });
      return rows.map(toCustomerSummary);
    },
  );

  app.get('/api/v1/customers/:id', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const c = await prisma.customer.findUnique({ where: { id }, include: fullInclude });
    if (!c) throw Errors.notFound('Cliente');
    return toDto(c);
  });

  /** Endereços ativos — necessários para pedidos e retiradas. */
  app.get(
    '/api/v1/customers/:id/addresses',
    {
      config: {
        access: {
          session: 'WEB',
          anyPermissions: ['clientes.ver', 'pedidos.gerenciar', 'retiradas.gerenciar'],
        },
      },
    },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const rows = await prisma.customerAddress.findMany({
        where: { customerId: id, archivedAt: null },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      });
      return rows.map(toAddressDto);
    },
  );

  /** Histórico de serviços do cliente (pedidos e OS) e das alterações cadastrais. */
  app.get('/api/v1/customers/:id/history', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const exists = await prisma.customer.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw Errors.notFound('Cliente');
    const [orders, serviceOrders, changes] = await Promise.all([
      can(request, 'pedidos.ver')
        ? prisma.commercialOrder.findMany({
            where: { customerId: id },
            include: { items: { select: { quantity: true, receivedQuantity: true } } },
            orderBy: { createdAt: 'desc' },
          })
        : [],
      can(request, 'os.ver')
        ? prisma.serviceOrder.findMany({
            where: { customerId: id },
            include: { items: { select: { quantity: true } } },
            orderBy: { createdAt: 'desc' },
          })
        : [],
      prisma.auditLog.findMany({
        where: { entityType: 'customer', entityId: id },
        include: { actor: { select: { displayName: true } } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);
    return {
      orders: orders.map((o) => ({
        id: o.id,
        code: orderCode(o.number),
        status: o.status,
        contractedService: o.contractedService,
        totalPieces: o.items.reduce((a, i) => a + i.quantity, 0),
        receivedPieces: o.items.reduce((a, i) => a + i.receivedQuantity, 0),
        createdAt: o.createdAt.toISOString(),
      })),
      serviceOrders: serviceOrders.map((s) => ({
        id: s.id,
        code: serviceOrderCode(s.number),
        status: s.status,
        priority: s.priority,
        pieceCount: s.items.reduce((a, i) => a + i.quantity, 0),
        createdAt: s.createdAt.toISOString(),
      })),
      changes: changes.map((c) => ({
        id: c.id,
        action: c.action,
        summary: c.summary,
        changes: c.changes,
        actor: c.actor?.displayName ?? null,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  });

  app.post(
    '/api/v1/customers',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = createCustomerSchema.parse(request.body);
      try {
        const created = await prisma.$transaction(async (tx) => {
          // Serializa cadastros para que a checagem de duplicidade não sofra corrida.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(7263540010::bigint)`;
          const dup = await findDuplicates(tx, input);
          if (dup.hard.length || (dup.soft.length && !input.allowSimilar)) {
            throw duplicateError(dup.hard, dup.soft);
          }
          const actor = actorFrom(request);
          const addresses = input.addresses.map((a, i) => ({
            ...a,
            isPrimary: input.addresses.some((x) => x.isPrimary) ? a.isPrimary : i === 0,
          }));
          if (addresses.filter((a) => a.isPrimary).length > 1) {
            throw Errors.validation(undefined, 'Apenas um endereço pode ser o principal.');
          }
          const customer = await tx.customer.create({
            data: {
              kind: input.kind,
              name: input.name,
              tradeName: input.tradeName ?? null,
              document: input.document ?? null,
              phone: input.phone ?? null,
              whatsapp: input.whatsapp ?? null,
              email: input.email ?? null,
              notes: input.notes ?? null,
              searchText: searchTextFor(input),
              createdById: actor.userId,
              addresses: {
                create: addresses.map((a) => ({
                  label: a.label,
                  street: a.street,
                  number: a.number,
                  complement: a.complement ?? null,
                  district: a.district ?? null,
                  city: a.city,
                  state: a.state,
                  postalCode: a.postalCode ?? null,
                  reference: a.reference ?? null,
                  isPrimary: a.isPrimary,
                })),
              },
            },
            include: fullInclude,
          });
          await audit(tx, actor, {
            action: 'customer.created',
            entityType: 'customer',
            entityId: customer.id,
            summary: `Cliente ${customer.name} cadastrado.`,
            changes: dup.soft.length
              ? { confirmedDespiteSimilar: dup.soft.map((c) => c.id) }
              : undefined,
          });
          await appendEvent(tx, actor, {
            type: EVENT_TYPES.CUSTOMER_CREATED,
            aggregateType: 'customer',
            aggregateId: customer.id,
            payload: { id: customer.id, version: customer.version },
            audience: AUDIENCE,
          });
          return customer;
        });
        return reply.status(201).send(toDto(created));
      } catch (error) {
        if (isUniqueViolation(error))
          throw Errors.conflict('Já existe um cliente com este CPF/CNPJ.');
        throw error;
      }
    },
  );

  app.put('/api/v1/customers/:id', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = updateCustomerSchema.parse(request.body);
    try {
      const updated = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(7263540010::bigint)`;
        const rows = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM customers WHERE id = ${id}::uuid FOR UPDATE`;
        if (!rows.length) throw Errors.notFound('Cliente');
        const before = await tx.customer.findUniqueOrThrow({ where: { id } });
        if (before.version !== input.version) throw Errors.versionConflict(before.version);
        const dup = await findDuplicates(tx, input, id);
        // Só alerta sobre semelhança se o dado relevante mudou.
        const changedContact =
          before.phone !== (input.phone ?? null) ||
          before.whatsapp !== (input.whatsapp ?? null) ||
          before.email !== (input.email ?? null) ||
          normalizeSearch(before.name) !== normalizeSearch(input.name);
        if (dup.hard.length || (changedContact && dup.soft.length && !input.allowSimilar)) {
          throw duplicateError(dup.hard, dup.soft);
        }
        const after = await tx.customer.update({
          where: { id, version: input.version },
          data: {
            kind: input.kind,
            name: input.name,
            tradeName: input.tradeName ?? null,
            document: input.document ?? null,
            phone: input.phone ?? null,
            whatsapp: input.whatsapp ?? null,
            email: input.email ?? null,
            notes: input.notes ?? null,
            searchText: searchTextFor(input),
            version: { increment: 1 },
          },
          include: fullInclude,
        });
        const changes = diffObjects(before, after, [
          'kind',
          'name',
          'tradeName',
          'document',
          'phone',
          'whatsapp',
          'email',
          'notes',
        ]);
        // Documento não é copiado para a auditoria (registra apenas que mudou).
        if (changes.document) changes.document = { from: '•••', to: '•••' };
        const actor = actorFrom(request);
        await audit(tx, actor, {
          action: 'customer.updated',
          entityType: 'customer',
          entityId: id,
          summary: `Cadastro do cliente ${after.name} alterado.`,
          changes,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.CUSTOMER_UPDATED,
          aggregateType: 'customer',
          aggregateId: id,
          payload: { id, version: after.version },
          audience: AUDIENCE,
        });
        return after;
      });
      return toDto(updated);
    } catch (error) {
      if (isUniqueViolation(error))
        throw Errors.conflict('Já existe um cliente com este CPF/CNPJ.');
      throw error;
    }
  });

  app.post('/api/v1/customers/:id/status', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = z
      .object({ active: z.boolean(), version: z.number().int().min(1) })
      .parse(request.body);
    const updated = await prisma.$transaction(async (tx) => {
      const before = await tx.customer.findUnique({ where: { id } });
      if (!before) throw Errors.notFound('Cliente');
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      const after = await tx.customer.update({
        where: { id, version: input.version },
        data: { active: input.active, version: { increment: 1 } },
        include: fullInclude,
      });
      const actor = actorFrom(request);
      await audit(tx, actor, {
        action: input.active ? 'customer.reactivated' : 'customer.archived',
        entityType: 'customer',
        entityId: id,
        summary: `Cliente ${after.name} ${input.active ? 'reativado' : 'arquivado'}.`,
      });
      await appendEvent(tx, actor, {
        type: EVENT_TYPES.CUSTOMER_UPDATED,
        aggregateType: 'customer',
        aggregateId: id,
        payload: { id, version: after.version },
        audience: AUDIENCE,
      });
      return after;
    });
    return toDto(updated);
  });

  async function addressChange(
    tx: Tx,
    actorRequest: Parameters<typeof actorFrom>[0],
    customerId: string,
    summary: string,
    changes?: object,
  ) {
    const customer = await tx.customer.update({
      where: { id: customerId },
      data: { version: { increment: 1 } },
      include: fullInclude,
    });
    const actor = actorFrom(actorRequest);
    await audit(tx, actor, {
      action: 'customer.address_changed',
      entityType: 'customer',
      entityId: customerId,
      summary,
      changes,
    });
    await appendEvent(tx, actor, {
      type: EVENT_TYPES.CUSTOMER_UPDATED,
      aggregateType: 'customer',
      aggregateId: customerId,
      payload: { id: customerId, version: customer.version },
      audience: AUDIENCE,
    });
    return customer;
  }

  app.post(
    '/api/v1/customers/:id/addresses',
    { config: { access: MANAGE } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = customerAddressSchema.parse(request.body);
      const customer = await prisma.$transaction(async (tx) => {
        const c = await tx.customer.findUnique({ where: { id }, include: fullInclude });
        if (!c) throw Errors.notFound('Cliente');
        const makePrimary = input.isPrimary || c.addresses.length === 0;
        if (makePrimary) {
          await tx.customerAddress.updateMany({
            where: { customerId: id },
            data: { isPrimary: false },
          });
        }
        const a = await tx.customerAddress.create({
          data: {
            customerId: id,
            label: input.label,
            street: input.street,
            number: input.number,
            complement: input.complement ?? null,
            district: input.district ?? null,
            city: input.city,
            state: input.state,
            postalCode: input.postalCode ?? null,
            reference: input.reference ?? null,
            isPrimary: makePrimary,
          },
        });
        return addressChange(
          tx,
          request,
          id,
          `Endereço "${a.label}" adicionado ao cliente ${c.name}.`,
        );
      });
      return reply.status(201).send(toDto(customer));
    },
  );

  app.put(
    '/api/v1/customers/:id/addresses/:addressId',
    { config: { access: MANAGE } },
    async (request) => {
      const { id, addressId } = addressParams.parse(request.params);
      const input = customerAddressSchema.parse(request.body);
      const customer = await prisma.$transaction(async (tx) => {
        const before = await tx.customerAddress.findFirst({
          where: { id: addressId, customerId: id, archivedAt: null },
        });
        if (!before) throw Errors.notFound('Endereço');
        if (input.isPrimary) {
          await tx.customerAddress.updateMany({
            where: { customerId: id },
            data: { isPrimary: false },
          });
        }
        const after = await tx.customerAddress.update({
          where: { id: addressId },
          data: {
            label: input.label,
            street: input.street,
            number: input.number,
            complement: input.complement ?? null,
            district: input.district ?? null,
            city: input.city,
            state: input.state,
            postalCode: input.postalCode ?? null,
            reference: input.reference ?? null,
            isPrimary: input.isPrimary || before.isPrimary,
          },
        });
        // Pedidos e retiradas já criados guardam cópia do endereço e não mudam.
        return addressChange(
          tx,
          request,
          id,
          `Endereço "${after.label}" alterado.`,
          diffObjects(before, after, [
            'label',
            'street',
            'number',
            'complement',
            'district',
            'city',
            'state',
            'postalCode',
            'reference',
            'isPrimary',
          ]),
        );
      });
      return toDto(customer);
    },
  );

  app.delete(
    '/api/v1/customers/:id/addresses/:addressId',
    { config: { access: MANAGE } },
    async (request) => {
      const { id, addressId } = addressParams.parse(request.params);
      const customer = await prisma.$transaction(async (tx) => {
        const before = await tx.customerAddress.findFirst({
          where: { id: addressId, customerId: id, archivedAt: null },
        });
        if (!before) throw Errors.notFound('Endereço');
        await tx.customerAddress.update({
          where: { id: addressId },
          data: { archivedAt: new Date(), isPrimary: false },
        });
        if (before.isPrimary) {
          const next = await tx.customerAddress.findFirst({
            where: { customerId: id, archivedAt: null },
            orderBy: { createdAt: 'asc' },
          });
          if (next)
            await tx.customerAddress.update({ where: { id: next.id }, data: { isPrimary: true } });
        }
        return addressChange(tx, request, id, `Endereço "${before.label}" removido (arquivado).`);
      });
      return toDto(customer);
    },
  );
}
