'use client';

import type { EmployeeInviteDto, GettingStartedDto } from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Começo guiado do Início e perguntas do primeiro acesso (lista de 26/11/2026). */
export function useGettingStarted(enabled = true) {
  return useQuery({
    queryKey: ['onboarding'],
    queryFn: () => api<GettingStartedDto>('/api/onboarding'),
    staleTime: 30_000,
    retry: false,
    enabled,
  });
}

/** Telas cuja explicação a pessoa já leu (item 5): a explicação abre sozinha só na 1ª vez. */
export function useSeenTips(enabled = true) {
  return useQuery({
    queryKey: ['me', 'tips'],
    queryFn: () => api<{ seen: string[] }>('/api/me/tips'),
    staleTime: Infinity,
    retry: false,
    enabled,
  });
}

export function useMarkTipSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => api(`/api/me/tips/${key}`, { method: 'POST' }),
    onMutate: (key) => {
      qc.setQueryData<{ seen: string[] }>(['me', 'tips'], (old) => ({
        seen: [...(old?.seen ?? []), key],
      }));
    },
  });
}

/** A chave da explicação de uma tela: o endereço, sem números nem barras. */
export function tipKeyFor(pathname: string): string | null {
  const key = pathname
    .toLowerCase()
    .replace(/\/\d+(?=\/|$)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return key.length >= 2 ? key : null;
}

export function createEmployeeInvite(employeeId: string) {
  return api<EmployeeInviteDto>(`/api/employees/${employeeId}/invite`, { method: 'POST' });
}
