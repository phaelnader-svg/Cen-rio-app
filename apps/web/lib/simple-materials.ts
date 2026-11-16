'use client';

import type {
  DirectDeliveryEligibilityDto,
  DirectDeliveryResultDto,
  InventoryAdjustmentDto,
  InventoryCategoryDto,
  InventoryItemDto,
  OsMaterialsDto,
} from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, newIdempotencyKey } from './api';

/** Reformulação, Fase 1 — materiais da OS (lista simples), estoque simples e entrega direta. */

export const osMaterialListKey = (soId: string) => ['os-material-list', soId] as const;

export const useOsMaterialList = (soId: string) =>
  useQuery({
    queryKey: osMaterialListKey(soId),
    queryFn: () => api<OsMaterialsDto>(`/api/v1/service-orders/${soId}/material-list`),
  });

export const useDirectDelivery = (soId: string, enabled = true) =>
  useQuery({
    queryKey: ['direct-delivery', soId],
    queryFn: () =>
      api<DirectDeliveryEligibilityDto>(`/api/v1/service-orders/${soId}/direct-delivery`),
    enabled,
  });

export const useInventoryCategories = (enabled = true) =>
  useQuery({
    queryKey: ['inventory', 'categories'],
    queryFn: () => api<InventoryCategoryDto[]>('/api/v1/inventory/categories'),
    enabled,
  });

export const useInventoryItems = (archived: 'true' | 'false' | 'all' = 'false', enabled = true) =>
  useQuery({
    queryKey: ['inventory', 'items', archived],
    queryFn: () => api<InventoryItemDto[]>(`/api/v1/inventory/items?archived=${archived}`),
    enabled,
  });

export const useInventoryAdjustments = (ref: { itemId?: string; rollId?: string } | null) =>
  useQuery({
    queryKey: ['inventory', 'adjustments', ref?.itemId ?? ref?.rollId ?? null],
    queryFn: () =>
      api<InventoryAdjustmentDto[]>(
        `/api/v1/inventory/adjustments?${ref?.itemId ? `itemId=${ref.itemId}` : `rollId=${ref?.rollId}`}`,
      ),
    enabled: Boolean(ref),
  });

/**
 * Mutação com chave de idempotência por intenção (repetir o mesmo clique não grava duas vezes),
 * aviso de sucesso e erro legível. `invalidate` = prefixos de consulta a recarregar.
 */
export function useAction<T>(invalidate: readonly (readonly unknown[])[], success?: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (req: { path: string; method?: 'POST' | 'PATCH' | 'PUT'; body?: unknown }) =>
      api<T>(req.path, {
        method: req.method ?? 'POST',
        body: req.body ?? {},
        idempotencyKey: newIdempotencyKey(),
      }),
    // Aguarda as listas recarregarem antes de encerrar a ação (sem "piscar" o valor antigo).
    onSuccess: async () => {
      setError(null);
      if (success) toast('ok', success);
      await Promise.all(invalidate.map((queryKey) => qc.invalidateQueries({ queryKey })));
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return { ...m, error, clearError: () => setError(null) };
}

export type { DirectDeliveryResultDto };
