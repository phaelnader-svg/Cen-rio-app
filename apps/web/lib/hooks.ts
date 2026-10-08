'use client';

import type { MeDto, Permission } from '@cenario/shared';
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
