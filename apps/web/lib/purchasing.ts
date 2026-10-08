'use client';

import type {
  LeftoverDto,
  MaterialReadinessDto,
  PendingMaterialReceiptDto,
  PurchaseNeedDto,
  PurchaseOrderDto,
  PurchaseOrderSummaryDto,
  ReadinessSummaryDto,
  StockItemDto,
  StockMovementDto,
  StockReservationDto,
  SupplierDto,
} from '@cenario/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from './api';

const qs = (params: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const useNeeds = (pendingOnly = true, enabled = true) =>
  useQuery({
    queryKey: ['needs', pendingOnly],
    queryFn: () =>
      api<PurchaseNeedDto[]>(`/api/v1/purchasing/needs${qs({ pendingOnly: String(pendingOnly) })}`),
    enabled,
  });

export const usePurchaseOrders = (f: { status?: string; q?: string; serviceOrderId?: string }) =>
  useQuery({
    queryKey: ['purchase-orders', f],
    queryFn: () => api<PurchaseOrderSummaryDto[]>(`/api/v1/purchase-orders${qs(f)}`),
    placeholderData: keepPreviousData,
  });

export const usePurchaseOrder = (id: string) =>
  useQuery({
    queryKey: ['purchase-order', id],
    queryFn: () => api<PurchaseOrderDto>(`/api/v1/purchase-orders/${id}`),
  });

export const useSuppliers = (enabled = true) =>
  useQuery({
    queryKey: ['suppliers'],
    queryFn: () => api<SupplierDto[]>('/api/v1/suppliers'),
    enabled,
  });

export const usePendingReceipts = () =>
  useQuery({
    queryKey: ['pending-receipts'],
    queryFn: () => api<PendingMaterialReceiptDto[]>('/api/v1/material-receipts/pending'),
  });

export const useStockItems = (enabled = true) =>
  useQuery({
    queryKey: ['stock-items'],
    queryFn: () => api<StockItemDto[]>('/api/v1/stock-items'),
    enabled,
  });

export const useMovements = (stockItemId?: string) =>
  useQuery({
    queryKey: ['stock-movements', stockItemId ?? ''],
    queryFn: () => api<StockMovementDto[]>(`/api/v1/stock-movements${qs({ stockItemId })}`),
  });

export const useReservations = (status?: string) =>
  useQuery({
    queryKey: ['stock-reservations', status ?? ''],
    queryFn: () => api<StockReservationDto[]>(`/api/v1/stock-reservations${qs({ status })}`),
  });

export const useLeftovers = (all = false) =>
  useQuery({
    queryKey: ['leftovers', all],
    queryFn: () => api<LeftoverDto[]>(`/api/v1/material-leftovers${qs({ all: String(all) })}`),
  });

export const useReadinessList = () =>
  useQuery({
    queryKey: ['readiness'],
    queryFn: () => api<ReadinessSummaryDto[]>('/api/v1/material-readiness'),
  });

export const useOsReadiness = (serviceOrderId: string, enabled = true) =>
  useQuery({
    queryKey: ['os-readiness', serviceOrderId],
    queryFn: () =>
      api<MaterialReadinessDto>(`/api/v1/service-orders/${serviceOrderId}/material-readiness`),
    enabled,
  });
