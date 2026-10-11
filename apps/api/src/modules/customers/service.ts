import {
  ERROR_CODES,
  EVENT_TYPES,
  normalizeSearch,
  type CreateCustomerInput,
  type DuplicateCandidateDto,
  type createCustomerSchema,
} from '@cenario/shared';
import type { Customer, CustomerAddress, Prisma, Tx } from '@cenario/db';
import type { z } from 'zod';
import { audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { AppError, Errors } from '../../lib/errors';

/**
 * Serviço de domínio de clientes (Simplificação Fase 2): o cadastro deixou de existir só dentro
 * da rota para ser reutilizado, NA MESMA transação, pelo fluxo "Novo serviço". As regras são as
 * mesmas da rota `POST /api/v1/customers`.
 */
export const CUSTOMER_AUDIENCE = 'permission:clientes.ver' as const;

export function searchTextFor(c: {
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

/**
 * Detecção de duplicidade:
 * - mesmo CPF/CNPJ → duplicidade evidente (bloqueia, também por índice único no banco);
 * - mesmo telefone/WhatsApp/e-mail ou nome idêntico → possível duplicidade: o
 *   cadastro só prossegue com confirmação explícita (pessoas diferentes podem
 *   compartilhar telefone, ou ter o mesmo nome).
 */
export async function findDuplicates(
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

export function duplicateError(hard: DuplicateCandidateDto[], soft: DuplicateCandidateDto[]) {
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

export type NewCustomer = z.output<typeof createCustomerSchema>;
export type { CreateCustomerInput };

/**
 * Cadastra o cliente dentro de `tx`. Serializa cadastros (trava consultiva) para que a
 * checagem de duplicidade não sofra corrida; mesmo documento bloqueia, dados semelhantes
 * exigem `allowSimilar`.
 */
export async function createCustomer(
  tx: Tx,
  actor: ActorContext,
  input: NewCustomer,
): Promise<Customer & { addresses: CustomerAddress[] }> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7263540010::bigint)`;
  const dup = await findDuplicates(tx, input);
  if (dup.hard.length || (dup.soft.length && !input.allowSimilar)) {
    throw duplicateError(dup.hard, dup.soft);
  }
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
    include: { addresses: { orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] } },
  });
  await audit(tx, actor, {
    action: 'customer.created',
    entityType: 'customer',
    entityId: customer.id,
    summary: `Cliente ${customer.name} cadastrado.`,
    changes: dup.soft.length ? { confirmedDespiteSimilar: dup.soft.map((c) => c.id) } : undefined,
  });
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.CUSTOMER_CREATED,
    aggregateType: 'customer',
    aggregateId: customer.id,
    payload: { id: customer.id, version: customer.version },
    audience: CUSTOMER_AUDIENCE,
  });
  return customer;
}
