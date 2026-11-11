'use client';

import type {
  OsMaterialSuggestionsDto,
  PieceType,
  ServiceModelDto,
  ServiceModelMaterialDto,
  ServiceModelOverviewDto,
  ServiceType,
} from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Reformulação, Fase 2 — modelos de serviço (etapas + checklist + materiais padrão). */
export const SERVICE_MODELS_KEY = ['service-models'] as const;

export const useServiceModelsOverview = () =>
  useQuery({
    queryKey: [...SERVICE_MODELS_KEY, 'overview'],
    queryFn: () => api<ServiceModelOverviewDto>('/api/v1/service-models'),
  });

export const useServiceModel = (pieceType: PieceType, serviceType: ServiceType | null) =>
  useQuery({
    queryKey: [...SERVICE_MODELS_KEY, 'detail', pieceType, serviceType],
    queryFn: () =>
      api<ServiceModelDto>(
        `/api/v1/service-models/detail?pieceType=${pieceType}&serviceType=${serviceType}`,
      ),
    enabled: Boolean(serviceType),
  });

export const useModelMaterials = (pieceType: PieceType) =>
  useQuery({
    queryKey: [...SERVICE_MODELS_KEY, 'materials', pieceType],
    queryFn: () =>
      api<ServiceModelMaterialDto[]>(`/api/v1/service-models/materials?pieceType=${pieceType}`),
  });

export const osMaterialSuggestionsKey = (soId: string) =>
  ['os-material-suggestions', soId] as const;

export const useOsMaterialSuggestions = (soId: string, enabled: boolean) =>
  useQuery({
    queryKey: osMaterialSuggestionsKey(soId),
    queryFn: () =>
      api<OsMaterialSuggestionsDto>(`/api/v1/service-orders/${soId}/material-suggestions`),
    enabled,
  });
