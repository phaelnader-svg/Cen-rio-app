'use client';

import type {
  AwaitingMeasurementDto,
  ConsolidatedListDto,
  MeasurementAssigneeDto,
  MeasurementDetailDto,
  MeasurementSummaryDto,
  PlanningDto,
} from '@cenario/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from './api';

const qs = (params: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export interface MeasurementFilters {
  status?: string;
  requestStatus?: string;
  kind?: string;
  assigneeUserId?: string;
  serviceOrderId?: string;
  q?: string;
  from?: string;
  to?: string;
}

export const useMeasurements = (f: MeasurementFilters, enabled = true) =>
  useQuery({
    queryKey: ['measurements', f],
    queryFn: () => api<MeasurementSummaryDto[]>(`/api/v1/measurements${qs({ ...f })}`),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useMeasurement = (id: string | null) =>
  useQuery({
    queryKey: ['measurement', id],
    queryFn: () => api<MeasurementDetailDto>(`/api/v1/measurements/${id}`),
    enabled: Boolean(id),
  });

export const useMyMeasurements = (enabled = true) =>
  useQuery({
    queryKey: ['my-measurements'],
    queryFn: () => api<MeasurementSummaryDto[]>('/api/v1/measurements/mine'),
    enabled,
  });

export const useAwaitingMeasurement = (enabled = true) =>
  useQuery({
    queryKey: ['measurements-awaiting'],
    queryFn: () => api<AwaitingMeasurementDto[]>('/api/v1/measurements/awaiting'),
    enabled,
  });

export const useAssignees = (enabled = true) =>
  useQuery({
    queryKey: ['measurement-assignees'],
    queryFn: () => api<MeasurementAssigneeDto[]>('/api/v1/measurements/assignees'),
    enabled,
  });

export const usePlanning = (from?: string, to?: string) =>
  useQuery({
    queryKey: ['planning', from ?? '', to ?? ''],
    queryFn: () => api<PlanningDto>(`/api/v1/materials/planning${qs({ from, to })}`),
    placeholderData: keepPreviousData,
  });

export const useConsolidated = (from?: string, to?: string) =>
  useQuery({
    queryKey: ['consolidated', from ?? '', to ?? ''],
    queryFn: () => api<ConsolidatedListDto>(`/api/v1/materials/consolidated${qs({ from, to })}`),
    placeholderData: keepPreviousData,
  });

/** "12,5" ou "12.5" → 12.5; vazio/ inválido → NaN. */
export function parseDecimal(v: string): number {
  const t = v.trim().replace(/\s/g, '');
  if (!t) return Number.NaN;
  const n = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  return /^-?\d+(\.\d+)?$/.test(n) ? Number(n) : Number.NaN;
}

export const decimalText = (n: number | null | undefined) =>
  n === null || n === undefined ? '' : String(n).replace('.', ',');
