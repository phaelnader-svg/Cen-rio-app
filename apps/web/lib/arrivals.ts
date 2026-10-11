'use client';

import type { ArrivalsDto, MaterialArrivalDto } from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/**
 * Simplificação Fase 3 — central "Aguardando chegada" compartilhada pelos tablets e pelo painel.
 * Atualiza em tempo real (ver `realtime.tsx`): confirmou em um aparelho, some dos outros.
 */
export const useArrivals = (enabled = true) =>
  useQuery({
    queryKey: ['arrivals'],
    queryFn: () => api<ArrivalsDto>('/api/v1/arrivals'),
    enabled,
  });

/** Chegadas físicas de materiais (rolos etc.) — conferência técnica no painel. */
export const useMaterialArrivals = (status?: MaterialArrivalDto['status'], enabled = true) =>
  useQuery({
    queryKey: ['material-arrivals', status ?? 'all'],
    queryFn: () =>
      api<MaterialArrivalDto[]>(`/api/v1/material-arrivals${status ? `?status=${status}` : ''}`),
    enabled,
  });
