'use client';

import type {
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
