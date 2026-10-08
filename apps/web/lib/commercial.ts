'use client';

import type {
  AttachmentDto,
  AttachmentEntity,
  CustomerAddressDto,
  CustomerDto,
  CustomerSummaryDto,
  OrderDto,
  OrderSummaryDto,
  PageDto,
  PickupDto,
  ReceiptDto,
  ServiceOrderDto,
  ServiceOrderRevisionDto,
  ServiceOrderSummaryDto,
} from '@cenario/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from './api';

const qs = (params: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const useCustomers = (params: {
  q?: string;
  kind?: string;
  city?: string;
  includeArchived?: string;
}) =>
  useQuery({
    queryKey: ['customers', params],
    queryFn: () => api<PageDto<CustomerDto>>(`/api/v1/customers${qs({ ...params, limit: 100 })}`),
    placeholderData: keepPreviousData,
  });

export const useCustomer = (id: string) =>
  useQuery({
    queryKey: ['customer', id],
    queryFn: () => api<CustomerDto>(`/api/v1/customers/${id}`),
    enabled: Boolean(id),
  });

export interface CustomerHistory {
  orders: {
    id: string;
    code: string;
    status: string;
    contractedService: string;
    totalPieces: number;
    receivedPieces: number;
    createdAt: string;
  }[];
  serviceOrders: {
    id: string;
    code: string;
    status: string;
    priority: string;
    pieceCount: number;
    createdAt: string;
  }[];
  changes: {
    id: string;
    action: string;
    summary: string;
    changes: unknown;
    actor: string | null;
    createdAt: string;
  }[];
}

export const useCustomerHistory = (id: string) =>
  useQuery({
    queryKey: ['customer', id, 'history'],
    queryFn: () => api<CustomerHistory>(`/api/v1/customers/${id}/history`),
  });

export const useCustomerLookup = (q: string, enabled = true) =>
  useQuery({
    queryKey: ['customer-lookup', q],
    queryFn: () => api<CustomerSummaryDto[]>(`/api/v1/customers/lookup${qs({ q })}`),
    enabled,
    placeholderData: keepPreviousData,
  });

export const useCustomerAddresses = (id: string | null) =>
  useQuery({
    queryKey: ['customer', id, 'addresses'],
    queryFn: () => api<CustomerAddressDto[]>(`/api/v1/customers/${id}/addresses`),
    enabled: Boolean(id),
  });

export const useOrders = (
  params: { q?: string; status?: string; customerId?: string },
  enabled = true,
) =>
  useQuery({
    queryKey: ['orders', params],
    queryFn: () => api<PageDto<OrderSummaryDto>>(`/api/v1/orders${qs({ ...params, limit: 100 })}`),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useOrder = (id: string | null) =>
  useQuery({
    queryKey: ['order', id],
    queryFn: () => api<OrderDto>(`/api/v1/orders/${id}`),
    enabled: Boolean(id),
  });

export const usePickups = (
  params: { status?: string; from?: string; to?: string; orderId?: string },
  enabled = true,
) =>
  useQuery({
    queryKey: ['pickups', params],
    queryFn: () => api<PickupDto[]>(`/api/v1/pickups${qs({ ...params, limit: 200 })}`),
    placeholderData: keepPreviousData,
    enabled,
  });

export const usePickup = (id: string | null) =>
  useQuery({
    queryKey: ['pickup', id],
    queryFn: () => api<PickupDto>(`/api/v1/pickups/${id}`),
    enabled: Boolean(id),
  });

export const useReceipts = (orderId?: string, enabled = true) =>
  useQuery({
    queryKey: ['receipts', orderId ?? 'all'],
    queryFn: () => api<ReceiptDto[]>(`/api/v1/receipts${qs({ orderId })}`),
    enabled,
  });

export interface PendingReceiptOrder {
  id: string;
  code: string;
  status: string;
  customer: CustomerSummaryDto;
  items: {
    id: string;
    pieceType: string;
    description: string;
    quantity: number;
    receivedQuantity: number;
    pending: number;
  }[];
  pickups: {
    id: string;
    code: string;
    status: string;
    scheduledDate: string | null;
    items: { orderItemId: string; quantity: number }[];
  }[];
}

export const usePendingReceipts = (enabled = true) =>
  useQuery({
    queryKey: ['receipts-pending'],
    queryFn: () => api<PendingReceiptOrder[]>('/api/v1/receipts/pending'),
    enabled,
  });

export const useServiceOrders = (
  params: { q?: string; status?: string; orderId?: string },
  enabled = true,
) =>
  useQuery({
    queryKey: ['service-orders', params],
    queryFn: () =>
      api<PageDto<ServiceOrderSummaryDto>>(
        `/api/v1/service-orders${qs({ ...params, limit: 100 })}`,
      ),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useServiceOrder = (id: string) =>
  useQuery({
    queryKey: ['service-order', id],
    queryFn: () => api<ServiceOrderDto>(`/api/v1/service-orders/${id}`),
  });

export const useServiceOrderRevisions = (id: string) =>
  useQuery({
    queryKey: ['service-order', id, 'revisions'],
    queryFn: () => api<ServiceOrderRevisionDto[]>(`/api/v1/service-orders/${id}/revisions`),
  });

export interface AvailableForOs {
  order: { id: string; code: string; status: string; contractedService: string };
  customer: CustomerSummaryDto;
  items: {
    orderItemId: string;
    pieceType: string;
    description: string;
    quantity: number;
    receivedQuantity: number;
    inServiceOrders: number;
    available: number;
  }[];
}

export const useAvailableForOs = (orderId: string | null) =>
  useQuery({
    queryKey: ['so-available', orderId],
    queryFn: () => api<AvailableForOs>(`/api/v1/service-orders/available${qs({ orderId })}`),
    enabled: Boolean(orderId),
  });

export const useAttachments = (entityType: AttachmentEntity, entityId: string, enabled = true) =>
  useQuery({
    queryKey: ['attachments', entityType, entityId],
    queryFn: () => api<AttachmentDto[]>(`/api/v1/attachments${qs({ entityType, entityId })}`),
    enabled,
  });

/** Data "AAAA-MM-DD" → "qui., 15/10". */
export function formatDay(date: string | null, withYear = false): string {
  if (!date) return 'Sem data';
  return new Intl.DateTimeFormat('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

/** Hoje no fuso da empresa, "AAAA-MM-DD". */
export function todayIso(timeZone = 'America/Sao_Paulo'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Segunda-feira da semana da data. */
export function weekStart(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(iso, -dow);
}
