'use client';

import { resolveModules, type MeDto, type ModuleState, type Permission } from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export function useMe(enabled = true) {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api<MeDto>('/api/auth/me'),
    retry: false,
    staleTime: 60_000,
    enabled,
  });
}

export function useCan() {
  const { data } = useMe();
  const set = new Set(data?.permissions ?? []);
  return (p: Permission) => set.has(p);
}

const DEFAULT_MODULES = resolveModules([]);

/**
 * Reformulação, Fase 0: funcionalidades ligadas/desligadas (o servidor é quem recusa; aqui só se
 * esconde o que não vale a pena mostrar). Enquanto carrega, vale o padrão (comportamento
 * anterior). A chave fica sob ['company'] para o tempo real (`company.*`) atualizar sozinho.
 */
export function useModules(enabled = true): ModuleState {
  const q = useQuery({
    queryKey: ['company', 'modules', 'state'],
    queryFn: () => api<ModuleState>('/api/v1/modules'),
    staleTime: 60_000,
    enabled,
  });
  return q.data ?? DEFAULT_MODULES;
}
