'use client';

import type {
  ExpenseDto,
  FinanceDashboardDto,
  LaborPayableDto,
  LaborReviewDto,
  LogisticsCostDto,
  LogisticsDefaultsDto,
  LogisticsWeeklyDto,
  TripCostViewDto,
  OrderResultDto,
  OrderRevenueDto,
  PayableDto,
  ProductivityDto,
  ReceivableDto,
  RecurringExpenseDto,
  ServiceOrderLaborDto,
  TeamCostDto,
  WorkerDto,
} from '@cenario/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from './api';

/** Fase 11 — financeiro operacional. Todas as consultas usam a chave raiz ['fin']. */
export interface Period {
  from: string;
  to: string;
}

const qs = (filters: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const localToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
export const monthStart = (iso = localToday()) => `${iso.slice(0, 7)}-01`;

function useFin<T>(path: string, enabled = true) {
  return useQuery({
    queryKey: ['fin', path],
    queryFn: () => api<T>(`/api/v1/finance${path}`),
    placeholderData: keepPreviousData,
    enabled,
  });
}

export const useFinDashboard = (p: Period) =>
  useFin<FinanceDashboardDto>(`/dashboard${qs({ ...p })}`);
export const useFinOrders = (search: string, open: boolean) =>
  useFin<OrderRevenueDto[]>(
    `/orders${qs({ search: search || undefined, open: open ? '1' : undefined })}`,
  );
export const useFinOrder = (id: string | null) =>
  useFin<OrderRevenueDto>(`/orders/${id}`, Boolean(id));
export const useReceivables = (status?: string) =>
  useFin<ReceivableDto[]>(`/receivables${qs({ status })}`);
export const useReceivable = (id: string | null) =>
  useFin<ReceivableDto>(`/receivables/${id}`, Boolean(id));
export const usePayables = (status?: string) => useFin<PayableDto[]>(`/payables${qs({ status })}`);
export const usePayable = (id: string | null) => useFin<PayableDto>(`/payables/${id}`, Boolean(id));
export const useLabor = (status?: string) => useFin<LaborPayableDto[]>(`/labor${qs({ status })}`);
export const useLaborOne = (id: string | null) =>
  useFin<LaborPayableDto>(`/labor/${id}`, Boolean(id));
/** Evolução Fase 5: mão de obra por peça da OS e revisões financeiras. */
export const useServiceOrderLabor = (id: string) =>
  useFin<ServiceOrderLaborDto>(`/service-orders/${id}/labor`);
export const useLaborReviews = (status?: 'ABERTA' | 'RESOLVIDA') =>
  useFin<LaborReviewDto[]>(`/labor-reviews${qs({ status })}`);
/** Evolução Fase 6: custos de retirada e entrega. */
export const useLogisticsDefaults = (enabled = true) =>
  useFin<LogisticsDefaultsDto>('/logistics-defaults', enabled);
export const useTripCost = (ref: { pickupId?: string; deliveryId?: string }, enabled = true) =>
  useFin<TripCostViewDto>(`/trip-costs${qs(ref)}`, enabled);
export const useLogisticsWeekly = (p: Period) =>
  useFin<LogisticsWeeklyDto>(`/logistics-weekly${qs({ ...p })}`);
export const useTeamCosts = () => useFin<TeamCostDto[]>('/team-costs');
export const useFinPeople = () => useFin<WorkerDto[]>('/people');
export const useLogisticsCosts = () => useFin<LogisticsCostDto[]>('/logistics-costs');
export const useExpenses = (p: Period) => useFin<ExpenseDto[]>(`/expenses${qs({ ...p })}`);
export const useRecurring = () => useFin<RecurringExpenseDto[]>('/recurring-expenses');
export const useOrderResults = (p: Period) =>
  useFin<(Omit<OrderResultDto, 'labor' | 'logistics'> & { labor: number; logistics: number })[]>(
    `/service-orders${qs({ ...p })}`,
  );
export const useOrderResult = (id: string | null) =>
  useFin<OrderResultDto>(`/service-orders/${id}`, Boolean(id));
export const useProductivity = (p: Period) =>
  useFin<ProductivityDto>(`/productivity${qs({ ...p })}`);
export const useFinSettings = () => useFin<{ taxRateBps: number | null }>('/settings');
export const useReport = (kind: string, p: Period) =>
  useFin<{ title: string; header: string[]; rows: (string | number | null)[][]; notes: string[] }>(
    `/reports/${kind}${qs({ ...p })}`,
  );
export const reportCsvUrl = (kind: string, p: Period) =>
  `/api/v1/finance/reports/${kind}${qs({ ...p, format: 'csv' })}`;

/*
 * "Meus valores" (Ricardo/Márcio) não usa consulta em cache: o tablet confirma o PIN a cada
 * abertura (POST /my-production/unlock) — ver components/tablet/my-values.tsx.
 */

/** Mutação do financeiro: executa, atualiza as consultas ['fin'] e mostra o erro. */
export function useFinSend(onDone?: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: ({ run }: { run: () => Promise<unknown>; ok?: string }) => run(),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['fin'] });
      setError(null);
      if (v.ok) toast('ok', v.ok);
      onDone?.();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return { m, error, setError };
}

/** "1.234,56" / "1234.56" / "1234" → centavos (null se inválido). */
export function parseMoney(text: string): number | null {
  const t = text.trim().replace(/^R\$\s*/i, '');
  if (!t) return null;
  const normalized = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

export const money = (cents: number | null | undefined) =>
  cents === null || cents === undefined
    ? '—'
    : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const brDate = (iso: string | null | undefined) =>
  iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—';
