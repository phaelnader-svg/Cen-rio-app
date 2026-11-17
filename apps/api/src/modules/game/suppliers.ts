/**
 * Fornecedores do escritório do jogo: cadastro simples (nome, contato, WhatsApp e o que vendem)
 * usado pelo agente de Compras para montar o pedido de cada fornecedor. Não há processo formal de
 * compras: o pedido vai pelo WhatsApp, com aprovação do dono.
 */
import {
  EVENT_TYPES,
  type SupplierDto,
  supplierSchema,
  updateSupplierSchema,
} from '@cenario/shared';
import type { PrismaClient, Supplier, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { Errors } from '../../lib/errors';
import { idParams } from '../presenters';
import { AGENT_MANAGE, AGENT_USE } from './common';

const AUDIENCE = 'permission:agentes.usar|permission:agentes.gerenciar' as const;

export const supplierDto = (s: Supplier): SupplierDto => ({
  id: s.id,
  name: s.name,
  contactName: s.contactName,
  phone: s.phone,
  email: s.email,
  categories: s.categories,
  notes: s.notes,
  active: s.active,
  version: s.version,
});

export type MaterialCategory = 'TECIDO' | 'ESPUMA' | 'OUTRO';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Tipo do material pela categoria (ou descrição) da lista da OS. */
export function materialCategory(categoryName: string | null, description: string) {
  const t = norm(`${categoryName ?? ''} ${description}`);
  if (/tecid|courino|couro|veludo|linho|suede|chenille|sarja|lona|corino/.test(t)) return 'TECIDO';
  if (/espum|d2\d|d3\d|d4\d|manta|fibra|plumante|acrilon/.test(t)) return 'ESPUMA';
  return 'OUTRO';
}

/**
 * Fornecedor sugerido para um tipo de material: o que vende aquele tipo; senão o que vende
 * "outros"; senão o único fornecedor cadastrado. Ordem estável (mais antigo primeiro).
 */
export function pickSupplier(suppliers: Supplier[], kind: MaterialCategory): Supplier | null {
  const active = suppliers.filter((s) => s.active);
  return (
    active.find((s) => s.categories.includes(kind)) ??
    active.find((s) => s.categories.length === 0 || s.categories.includes('OUTRO')) ??
    (active.length === 1 ? active[0]! : null)
  );
}

export const listSuppliers = (db: PrismaClient | Tx) =>
  db.supplier.findMany({ where: { active: true }, orderBy: { createdAt: 'asc' } });

export async function gameSupplierRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/game/suppliers', { config: { access: AGENT_USE } }, async () =>
    (await prisma.supplier.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }] })).map(
      supplierDto,
    ),
  );

  app.post(
    '/api/v1/game/suppliers',
    { config: { access: AGENT_MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = supplierSchema.parse(request.body);
      const actor = actorFrom(request);
      const s = await prisma.$transaction(async (tx) => {
        const created = await tx.supplier.create({
          data: {
            name: input.name,
            contactName: input.contactName || null,
            phone: input.phone || null,
            email: input.email || null,
            categories: input.categories,
            notes: input.notes || null,
          },
        });
        await audit(tx, actor, {
          action: 'game.supplier_created',
          entityType: 'supplier',
          entityId: created.id,
          summary: `Fornecedor "${created.name}" cadastrado no escritório.`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.GAME_AGENT_CHANGED,
          aggregateType: 'supplier',
          aggregateId: created.id,
          payload: { id: created.id },
          audience: AUDIENCE,
        });
        return created;
      });
      return reply.status(201).send(supplierDto(s));
    },
  );

  app.put(
    '/api/v1/game/suppliers/:id',
    { config: { access: AGENT_MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const input = updateSupplierSchema.parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM suppliers WHERE id = ${id}::uuid FOR UPDATE`;
        const cur = await tx.supplier.findUnique({ where: { id } });
        if (!cur) throw Errors.notFound('Fornecedor');
        if (cur.version !== input.version) throw Errors.versionConflict(cur.version);
        const { version: _v, ...rest } = input;
        void _v;
        const u = await tx.supplier.update({
          where: { id },
          data: {
            ...rest,
            ...(rest.contactName !== undefined ? { contactName: rest.contactName || null } : {}),
            ...(rest.phone !== undefined ? { phone: rest.phone || null } : {}),
            ...(rest.email !== undefined ? { email: rest.email || null } : {}),
            ...(rest.notes !== undefined ? { notes: rest.notes || null } : {}),
            version: { increment: 1 },
          },
        });
        await audit(tx, actor, {
          action: 'game.supplier_updated',
          entityType: 'supplier',
          entityId: id,
          summary: `Fornecedor "${u.name}" alterado${rest.active === false ? ' (desativado)' : ''}.`,
          changes: { fields: Object.keys(rest) },
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.GAME_AGENT_CHANGED,
          aggregateType: 'supplier',
          aggregateId: id,
          payload: { id },
          audience: AUDIENCE,
        });
        return supplierDto(u);
      });
    },
  );
}
