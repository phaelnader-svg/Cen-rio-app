'use client';

import type {
  OverviewDto,
  ServiceTimelineDto,
  AuditLogDto,
  CompanySettingsDto,
  DeviceDto,
  EmployeeDto,
  RoleDto,
  SessionDto,
} from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface PermissionCatalog {
  groups: Record<string, string>;
  permissions: {
    key: string;
    group: string;
    label: string;
    description: string;
    critical?: boolean;
  }[];
}

export const useEmployees = (enabled = true) =>
  useQuery({
    queryKey: ['employees'],
    queryFn: () => api<EmployeeDto[]>('/api/employees'),
    enabled,
  });

export const useRoles = (enabled = true) =>
  useQuery({ queryKey: ['roles'], queryFn: () => api<RoleDto[]>('/api/roles'), enabled });

export const usePermissionCatalog = (enabled = true) =>
  useQuery({
    queryKey: ['permissions'],
    queryFn: () => api<PermissionCatalog>('/api/permissions'),
    staleTime: Infinity,
    enabled,
  });

export const useDevices = (enabled = true) =>
  useQuery({ queryKey: ['devices'], queryFn: () => api<DeviceDto[]>('/api/devices'), enabled });

export const useSessions = (enabled = true) =>
  useQuery({ queryKey: ['sessions'], queryFn: () => api<SessionDto[]>('/api/sessions'), enabled });

export const useCompany = (enabled = true) =>
  useQuery({
    queryKey: ['company'],
    queryFn: () => api<CompanySettingsDto>('/api/company/settings'),
    enabled,
  });

export const useRecentAudit = (limit: number, enabled = true) =>
  useQuery({
    queryKey: ['audit', 'recent', limit],
    queryFn: () =>
      api<{ items: AuditLogDto[]; nextCursor: string | null }>(`/api/audit?limit=${limit}`),
    enabled,
  });

/** Fase 10: Início do gestor (seções por permissão; null = sem acesso, nunca zero). */
export const useOverview = (enabled = true) =>
  useQuery({
    queryKey: ['overview'],
    queryFn: () => api<OverviewDto>('/api/v1/management/overview'),
    enabled,
    refetchInterval: 60_000,
  });

/** Fase 10: linha do tempo do serviço (históricos canônicos, só leitura). */
export const useServiceTimeline = (serviceOrderId: string, enabled = true) =>
  useQuery({
    queryKey: ['service-order', serviceOrderId, 'timeline'],
    queryFn: () => api<ServiceTimelineDto>(`/api/v1/service-orders/${serviceOrderId}/timeline`),
    enabled,
  });
