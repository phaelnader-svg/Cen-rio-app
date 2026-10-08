'use client';

import type {
  AttendanceConfigDto,
  AttendanceDayDto,
  AttendanceHistoryDto,
  AttendanceImpactDto,
  MyAttendanceDto,
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
