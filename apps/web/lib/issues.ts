'use client';

import type {
  AttentionDto,
  CandidateEvaluation,
  IssueDto,
  IssueImpactDto,
  IssueStatus,
} from '@cenario/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Fase 9 — ocorrências e central de atenção. */
export const useMyIssues = (enabled = true) =>
  useQuery({
    queryKey: ['my-issues'],
    queryFn: () => api<IssueDto[]>('/api/v1/issues/mine'),
    enabled,
  });

export const useIssues = (status?: IssueStatus) =>
  useQuery({
    queryKey: ['issues', status],
    queryFn: () => api<IssueDto[]>(`/api/v1/issues${status ? `?status=${status}` : ''}`),
    placeholderData: keepPreviousData,
  });

export const useIssue = (id: string | null) =>
  useQuery({
    queryKey: ['issue', id],
    queryFn: () => api<IssueDto>(`/api/v1/issues/${id}`),
    enabled: Boolean(id),
  });

export const useIssueImpacts = (id: string | null) =>
  useQuery({
    queryKey: ['issue-impacts', id],
    queryFn: () => api<IssueImpactDto>(`/api/v1/issues/${id}/impacts`),
    enabled: Boolean(id),
  });

export const useAttention = (filters: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
  const qs = p.toString();
  return useQuery({
    queryKey: ['attention', qs],
    queryFn: () => api<AttentionDto>(`/api/v1/attention${qs ? `?${qs}` : ''}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
};

export const useHelpCandidates = (id: string | null) =>
  useQuery({
    queryKey: ['help-candidates', id],
    queryFn: () =>
      api<{ candidates: CandidateEvaluation[] }>(`/api/v1/help-requests/${id}/candidates`),
    enabled: Boolean(id),
  });
