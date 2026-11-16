'use client';

import type {
  EmployeeSkillsDto,
  PlanningActionDto,
  ProductionTaskDto,
  ProposalStatus,
  RescheduleProposalDto,
} from '@cenario/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Propostas de reprogramação, histórico do planejamento e competências. */
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
