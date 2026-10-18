'use client';

import type {
  AttendanceConfigDto,
  AttendanceDayDto,
  AttendanceHistoryDto,
  AttendanceImpactDto,
  HolidayDto,
  LeaveDto,
  MyAttendanceDto,
  OpenShiftDto,
} from '@cenario/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from './api';

const qs = (params: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Presença do próprio funcionário (tablet). Recarrega a cada minuto para acompanhar o relógio. */
export const useMyAttendance = (enabled = true) =>
  useQuery({
    queryKey: ['attendance-me'],
    queryFn: () => api<MyAttendanceDto>('/api/v1/attendance/me'),
    enabled,
    refetchInterval: 60_000,
  });

export const useTeamAttendance = (date?: string, employeeId?: string) =>
  useQuery({
    queryKey: ['attendance-team', date, employeeId],
    queryFn: () =>
      api<{ date: string; config: AttendanceConfigDto; days: AttendanceDayDto[] }>(
        `/api/v1/attendance/team${qs({ date, employeeId })}`,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

export const useAttendanceImpacts = (date?: string, employeeId?: string) =>
  useQuery({
    queryKey: ['attendance-impacts', date, employeeId],
    queryFn: () =>
      api<AttendanceImpactDto[]>(`/api/v1/attendance/impacts${qs({ date, employeeId })}`),
    placeholderData: keepPreviousData,
  });

export const useAttendanceHistory = (employeeId: string | null) =>
  useQuery({
    queryKey: ['attendance-history', employeeId],
    queryFn: () =>
      api<{
        employee: { id: string; displayName: string };
        from: string;
        to: string;
        days: (AttendanceDayDto & { history: AttendanceHistoryDto[] })[];
      }>(`/api/v1/attendance/history${qs({ employeeId: employeeId ?? undefined })}`),
    enabled: Boolean(employeeId),
  });

/** Simplificação Fase 7: expedientes de dias anteriores sem saída (o gestor resolve). */
export const useOpenShifts = () =>
  useQuery({
    queryKey: ['attendance-open-shifts'],
    queryFn: () => api<OpenShiftDto[]>('/api/v1/attendance/open-shifts'),
    refetchInterval: 60_000,
  });

export const useLeaves = (from?: string) =>
  useQuery({
    queryKey: ['attendance-leaves', from],
    queryFn: () => api<LeaveDto[]>(`/api/v1/attendance/leaves${qs({ from })}`),
  });

export const useHolidays = (from?: string) =>
  useQuery({
    queryKey: ['attendance-holidays', from],
    queryFn: () => api<HolidayDto[]>(`/api/v1/attendance/holidays${qs({ from })}`),
  });
