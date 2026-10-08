'use client';

import type {
  EmployeeSkillsDto,
  HelpRequestDto,
  HelpStatus,
  PlanningActionDto,
  ProductionTaskDto,
  ProposalStatus,
  RescheduleProposalDto,
} from '@cenario/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Fase 8 — pedidos de ajuda, propostas de reprogramação, histórico e competências. */
export const useMyHelp = (enabled = true) =>
  useQuery({
    queryKey: ['my-help'],
    queryFn: () => api<HelpRequestDto[]>('/api/v1/help-requests/mine'),
    enabled,
    refetchInterval: 60_000,
  });

export const useHelpRequests = (status?: HelpStatus) =>
  useQuery({
    queryKey: ['help-requests', status],
    queryFn: () =>
      api<HelpRequestDto[]>(`/api/v1/help-requests${status ? `?status=${status}` : ''}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

export const useHelpRequest = (id: string | null) =>
  useQuery({
    queryKey: ['help-request', id],
    queryFn: () => api<HelpRequestDto>(`/api/v1/help-requests/${id}`),
    enabled: Boolean(id),
  });

export const useProposals = (status?: ProposalStatus) =>
  useQuery({
    queryKey: ['reschedule-proposals', status],
    queryFn: () =>
      api<RescheduleProposalDto[]>(
        `/api/v1/reschedule-proposals${status ? `?status=${status}` : ''}`,
      ),
    placeholderData: keepPreviousData,
  });

export const usePlanningActions = (automatic?: boolean) =>
  useQuery({
    queryKey: ['planning-actions', automatic],
    queryFn: () =>
      api<PlanningActionDto[]>(
        `/api/v1/planning-actions${automatic === undefined ? '' : `?automatic=${automatic}`}`,
      ),
    placeholderData: keepPreviousData,
  });

export const useSkills = () =>
  useQuery({
    queryKey: ['skills'],
    queryFn: () => api<EmployeeSkillsDto[]>('/api/v1/skills'),
  });

export const useAlternatives = (enabled = true) =>
  useQuery({
    queryKey: ['alternatives'],
    queryFn: () => api<ProductionTaskDto[]>('/api/v1/production-tasks/alternatives'),
    enabled,
  });
