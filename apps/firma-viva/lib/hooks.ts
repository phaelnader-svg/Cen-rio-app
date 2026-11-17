'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface FirmaMe {
  permissions: string[];
  user: { id: string; name: string; email: string };
  organizations: { id: string; name: string; role: string; roleLabel: string }[];
  organization: {
    id: string;
    name: string;
    role: string;
    roleLabel: string;
    cenario: { status: string; companyName: string | null; lastSyncAt: string | null };
  } | null;
}

export function useMe(enabled = true) {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api<FirmaMe>('/api/auth/me'),
    retry: false,
    staleTime: 30_000,
    enabled,
  });
}

export function useCan() {
  const { data } = useMe();
  const set = new Set(data?.permissions ?? []);
  return (p: string) => set.has(p);
}
