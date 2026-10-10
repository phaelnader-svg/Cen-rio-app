'use client';

import type {
  DeliveryDto,
  InspectionDto,
  LocationDto,
  LogisticsJobDto,
  LogisticsOccurrenceDto,
  LogisticsRouteChangeDto,
  LogisticsRouteDto,
  PackagingDto,
  PieceReturnDto,
  PieceStatusDto,
  QualityTemplateDto,
} from '@cenario/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Fase 10 — qualidade, embalagem, expedição, entregas, logística e devoluções. */
const qs = (filters: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const useInspections = (filters: Record<string, string | undefined> = {}, enabled = true) =>
  useQuery({
    queryKey: ['inspections', qs(filters)],
    queryFn: () => api<InspectionDto[]>(`/api/v1/quality/inspections${qs(filters)}`),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useInspection = (id: string | null) =>
  useQuery({
    queryKey: ['inspection', id],
    queryFn: () => api<InspectionDto>(`/api/v1/quality/inspections/${id}`),
    enabled: Boolean(id),
  });

export const useInspectors = () =>
  useQuery({
    queryKey: ['inspectors'],
    queryFn: () =>
      api<{ userId: string; displayName: string; isMain: boolean }[]>('/api/v1/quality/inspectors'),
  });

export const useQualitySettings = () =>
  useQuery({
    queryKey: ['quality-settings'],
    queryFn: () =>
      api<{
        qualityInspectorUserId: string | null;
        effectiveInspector: { userId: string; displayName: string } | null;
      }>('/api/v1/quality/settings'),
  });

export const useQualityTemplates = () =>
  useQuery({
    queryKey: ['quality-templates'],
    queryFn: () => api<QualityTemplateDto[]>('/api/v1/quality/templates'),
  });

export const usePackaging = (scope: 'open' | 'all' | 'mine' = 'open', enabled = true) =>
  useQuery({
    queryKey: ['packaging', scope],
    queryFn: () => api<PackagingDto[]>(`/api/v1/packaging?scope=${scope}`),
    enabled,
  });

export const usePackagingRecord = (id: string | null) =>
  useQuery({
    queryKey: ['packaging', 'one', id],
    queryFn: () => api<PackagingDto>(`/api/v1/packaging/${id}`),
    enabled: Boolean(id),
  });

export const useLocations = (enabled = true) =>
  useQuery({
    queryKey: ['locations'],
    queryFn: () => api<LocationDto[]>('/api/v1/locations'),
    enabled,
  });

export const usePieces = (filters: Record<string, string | undefined>) =>
  useQuery({
    queryKey: ['pieces', qs(filters)],
    queryFn: () => api<PieceStatusDto[]>(`/api/v1/pieces${qs(filters)}`),
    placeholderData: keepPreviousData,
  });

export const usePiece = (id: string | null) =>
  useQuery({
    queryKey: ['piece', id],
    queryFn: () => api<PieceStatusDto>(`/api/v1/pieces/${id}`),
    enabled: Boolean(id),
  });

export const useDeliveries = (filters: Record<string, string | undefined> = {}) =>
  useQuery({
    queryKey: ['deliveries', qs(filters)],
    queryFn: () => api<DeliveryDto[]>(`/api/v1/deliveries${qs(filters)}`),
    placeholderData: keepPreviousData,
  });

export const useDelivery = (id: string | null) =>
  useQuery({
    queryKey: ['delivery', id],
    queryFn: () => api<DeliveryDto>(`/api/v1/deliveries/${id}`),
    enabled: Boolean(id),
  });

export const useLogisticsPeople = (enabled = true) =>
  useQuery({
    queryKey: ['logistics-people'],
    enabled,
    queryFn: () =>
      api<
        { userId: string; displayName: string; team: 'LOGISTICA_TERCEIRIZADA' | 'EQUIPE_PROPRIA' }[]
      >('/api/v1/logistics/people'),
  });

export const useLogisticsJobs = (enabled = true) =>
  useQuery({
    queryKey: ['logistics-jobs'],
    queryFn: () => api<LogisticsJobDto[]>('/api/v1/logistics/jobs'),
    enabled,
  });

/** Correção global — roteiro do dia (gestor: todas as paradas; equipe: as suas). */
export const useLogisticsRoute = (date: string, enabled = true) =>
  useQuery({
    queryKey: ['logistics-route', date],
    queryFn: () => api<LogisticsRouteDto>(`/api/v1/logistics/route?date=${date}`),
    enabled: enabled && Boolean(date),
    placeholderData: keepPreviousData,
  });

export const useLogisticsRouteHistory = (date: string, enabled = true) =>
  useQuery({
    queryKey: ['logistics-route', date, 'history'],
    queryFn: () => api<LogisticsRouteChangeDto[]>(`/api/v1/logistics/route/history?date=${date}`),
    enabled: enabled && Boolean(date),
  });

export const useLogisticsOccurrences = (filters: Record<string, string | undefined> = {}) =>
  useQuery({
    queryKey: ['logistics-occurrences', qs(filters)],
    queryFn: () => api<LogisticsOccurrenceDto[]>(`/api/v1/logistics-occurrences${qs(filters)}`),
    placeholderData: keepPreviousData,
  });

export const useLogisticsOccurrence = (id: string | null) =>
  useQuery({
    queryKey: ['logistics-occurrence', id],
    queryFn: () => api<LogisticsOccurrenceDto>(`/api/v1/logistics-occurrences/${id}`),
    enabled: Boolean(id),
  });

export const useReturns = () =>
  useQuery({
    queryKey: ['returns'],
    queryFn: () => api<PieceReturnDto[]>('/api/v1/returns'),
  });
