'use client';

import type { ReworkDto, ReworkStatsDto } from '@cenario/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from './api';

/** 2026-11-18: Retrabalhos (substituem Devoluções no menu). Chave raiz ['reworks']. */
export type ReworkSituation = 'abertos' | 'concluidos' | 'cancelados' | 'todos';

export interface ReworkCandidate {
  id: string;
  code: string;
  customer: string;
  service: string;
  createdAt: string;
  deliveredAt: string | null;
  items: { id: string; description: string; quantity: number; delivered: number }[];
}

export const useReworks = (situacao: ReworkSituation, q: string) =>
  useQuery({
    queryKey: ['reworks', 'list', situacao, q],
    queryFn: () =>
      api<ReworkDto[]>(
        `/api/v1/reworks?situacao=${situacao}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      ),
    placeholderData: keepPreviousData,
  });

export const useReworkStats = (from: string, to: string) =>
  useQuery({
    queryKey: ['reworks', 'stats', from, to],
    queryFn: () => api<ReworkStatsDto>(`/api/v1/reworks/stats?from=${from}&to=${to}`),
    placeholderData: keepPreviousData,
  });

export const useReworkCandidates = (q: string, enabled: boolean) =>
  useQuery({
    queryKey: ['reworks', 'candidates', q],
    queryFn: () => api<ReworkCandidate[]>(`/api/v1/reworks/candidates?q=${encodeURIComponent(q)}`),
    placeholderData: keepPreviousData,
    enabled,
  });
