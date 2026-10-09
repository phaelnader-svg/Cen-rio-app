'use client';

import type {
  MyQueueDto,
  PlanDistributionDto,
  NotificationDto,
  PlanCandidateDto,
  ProductionPlanDto,
  ProductionTaskDetailDto,
  ProductionTaskDto,
  ProductionTemplateDto,
  WorkerDto,
} from '@cenario/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from './api';

const qs = (params: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const usePlansOfWeek = (week: string) =>
  useQuery({
    queryKey: ['production-plans', week],
    queryFn: () =>
      api<{ id: string; weekStart: string; status: string; mode: string; revision: number }[]>(
        `/api/v1/production-plans${qs({ week })}`,
      ),
  });

export const usePlan = (id: string | null) =>
  useQuery({
    queryKey: ['production-plan', id],
    queryFn: () => api<ProductionPlanDto>(`/api/v1/production-plans/${id}`),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  });

export const useCandidates = (planId: string | null) =>
  useQuery({
    queryKey: ['production-candidates', planId],
    queryFn: () => api<PlanCandidateDto[]>(`/api/v1/production-plans/${planId}/candidates`),
    enabled: Boolean(planId),
  });

export const useWorkers = (enabled = true) =>
  useQuery({
    queryKey: ['production-workers'],
    queryFn: () => api<WorkerDto[]>('/api/v1/production/workers'),
    enabled,
  });

export const useTemplates = () =>
  useQuery({
    queryKey: ['production-templates'],
    queryFn: () => api<ProductionTemplateDto[]>('/api/v1/production-templates'),
  });

export interface BoardFilters {
  from?: string;
  to?: string;
  assigneeUserId?: string;
  status?: string;
  activity?: string;
  serviceOrderId?: string;
}
export const useBoard = (f: BoardFilters) =>
  useQuery({
    queryKey: ['production-board', f],
    queryFn: () => api<ProductionTaskDto[]>(`/api/v1/production-board${qs({ ...f })}`),
    placeholderData: keepPreviousData,
  });

export const useTask = (id: string | null) =>
  useQuery({
    queryKey: ['production-task', id],
    queryFn: () => api<ProductionTaskDetailDto>(`/api/v1/production-tasks/${id}`),
    enabled: Boolean(id),
  });

export const useMyTasks = (enabled = true) =>
  useQuery({
    queryKey: ['my-tasks'],
    queryFn: () =>
      api<{ today: ProductionTaskDto[]; upcoming: ProductionTaskDto[] }>(
        '/api/v1/production-tasks/mine',
      ),
    enabled,
    refetchInterval: 60_000,
  });

/** Evolução Fase 2: minha fila semanal (ordem, atual, próxima executável). */
export const useMyQueue = (enabled = true) =>
  useQuery({
    queryKey: ['my-queue'],
    queryFn: () => api<MyQueueDto>('/api/v1/production-tasks/mine/queue'),
    enabled,
    refetchInterval: 60_000,
  });

/** Evolução Fase 3: distribuição por peça (titular, responsáveis e pendências). */
export const useDistribution = (planId: string | null) =>
  useQuery({
    queryKey: ['production-distribution', planId],
    queryFn: () => api<PlanDistributionDto>(`/api/v1/production-plans/${planId}/distribution`),
    enabled: Boolean(planId),
  });

/** Fila de um funcionário (gestão). */
export const useQueueOf = (userId: string | null) =>
  useQuery({
    queryKey: ['production-queue', userId],
    queryFn: () => api<MyQueueDto>(`/api/v1/production-queue/${userId}`),
    enabled: Boolean(userId),
  });

export const useOsProduction = (serviceOrderId: string, enabled = true) =>
  useQuery({
    queryKey: ['os-production', serviceOrderId],
    queryFn: () => api<ProductionTaskDto[]>(`/api/v1/service-orders/${serviceOrderId}/production`),
    enabled,
  });

/** Caixa de notificações do usuário (atualizada em tempo real e recarregada após reconexão). */
export const useNotifications = (enabled = true) =>
  useQuery({
    queryKey: ['notifications'],
    queryFn: () =>
      api<{ items: NotificationDto[]; unread: number }>('/api/v1/notifications?limit=50'),
    enabled,
  });
