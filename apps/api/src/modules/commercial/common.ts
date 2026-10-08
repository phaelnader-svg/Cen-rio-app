import {
  NUMBER_PREFIX,
  formatNumber,
  type AddressSnapshot,
  type CustomerSummaryDto,
  type Permission,
} from '@cenario/shared';
import type { Customer, CustomerAddress, Prisma, Tx } from '@cenario/db';
import type { FastifyRequest } from 'fastify';
import { Errors } from '../../lib/errors';

export const orderCode = (n: number) => formatNumber(NUMBER_PREFIX.order, n);
export const pickupCode = (n: number) => formatNumber(NUMBER_PREFIX.pickup, n);
export const receiptCode = (n: number) => formatNumber(NUMBER_PREFIX.receipt, n);
export const serviceOrderCode = (n: number) => formatNumber(NUMBER_PREFIX.serviceOrder, n);

export function can(request: FastifyRequest, permission: Permission): boolean {
  return request.auth?.permissions.has(permission) ?? false;
}

export function toCustomerSummary(
  c: Pick<Customer, 'id' | 'kind' | 'name' | 'tradeName'>,
): CustomerSummaryDto {
  return { id: c.id, kind: c.kind, name: c.name, tradeName: c.tradeName };
}

export function snapshotAddress(a: CustomerAddress): AddressSnapshot {
  return {
    label: a.label,
    street: a.street,
    number: a.number,
    complement: a.complement,
    district: a.district,
    city: a.city,
    state: a.state,
    postalCode: a.postalCode,
    reference: a.reference,
  };
}

export function asSnapshot(json: Prisma.JsonValue | null): AddressSnapshot | null {
  return json && typeof json === 'object' && !Array.isArray(json)
    ? (json as unknown as AddressSnapshot)
    : null;
}

/** Data (coluna DATE) → "AAAA-MM-DD". */
export function dateOnly(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export function parseDateOnly(v: string | null | undefined): Date | null {
  return v ? new Date(`${v}T00:00:00Z`) : null;
}

/** Busca o endereço ativo do cliente ou falha. */
export async function activeAddress(tx: Tx, customerId: string, addressId: string) {
  const address = await tx.customerAddress.findFirst({
    where: { id: addressId, customerId, archivedAt: null },
  });
  if (!address) throw Errors.validation(undefined, 'Endereço inválido para este cliente.');
  return address;
}

/** Bloqueia as linhas dos itens do pedido (ordem estável evita deadlocks). */
export async function lockOrderItems(tx: Tx, orderId: string) {
  await tx.$queryRaw`SELECT id FROM commercial_order_items WHERE order_id = ${orderId}::uuid ORDER BY id FOR UPDATE`;
}

export async function lockOrder(tx: Tx, orderId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM commercial_orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  return rows.length > 0;
}
