'use client';
import type {
  AttachmentDto,
  OsMaterialsDto,
  ServiceOrderDto,
  AgentConversationDto,
  AgentDto,
  AgentRoleTemplate,
  GameLayoutRevisionDto,
  GameMaterialSearchDto,
  GameSlotDetailDto,
  GameSlotMaterialDto,
  GameSnapshotDto,
  GameSpaceDto,
  IntegrationDto,
  SupplierDto,
} from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { AvatarLook } from './models';
import type { ProgressStore } from './progress';

export interface GamePerson {
  userId: string;
  employeeId: string;
  name: string;
  color: string;
  jobTitle: string | null;
  roles: string[];
}

export const useSpaces = () =>
  useQuery({
    queryKey: ['game-spaces'],
    queryFn: () => api<GameSpaceDto[]>('/api/v1/game/spaces'),
    staleTime: 60_000,
  });

/** Retrato da operação: recarregado pelos eventos (tempo real) e, por segurança, a cada 20 s. */
export const useSnapshot = (enabled: boolean) =>
  useQuery({
    queryKey: ['game-snapshot'],
    queryFn: () => api<GameSnapshotDto>('/api/v1/game/snapshot'),
    enabled,
    refetchInterval: 20_000,
    staleTime: 5_000,
  });

export const useAgents = () =>
  useQuery({
    queryKey: ['game-agents'],
    queryFn: () => api<AgentDto[]>('/api/v1/game/agents'),
    staleTime: 30_000,
  });
export const usePeople = () =>
  useQuery({
    queryKey: ['game-people'],
    queryFn: () => api<GamePerson[]>('/api/v1/game/people'),
    staleTime: 120_000,
  });
export const useItemLocations = () =>
  useQuery({
    queryKey: ['game-item-locations'],
    queryFn: () => api<{ id: string; key: string; label: string }[]>('/api/v1/game/item-locations'),
    staleTime: 300_000,
  });
export const useIntegrations = () =>
  useQuery({
    queryKey: ['game-integrations'],
    queryFn: () => api<IntegrationDto[]>('/api/v1/game/integrations'),
    staleTime: 300_000,
  });
export const useAgentTemplates = () =>
  useQuery({
    queryKey: ['game-agent-templates'],
    queryFn: () => api<AgentRoleTemplate[]>('/api/v1/game/agent-templates'),
    staleTime: 600_000,
  });
export const useConversation = (id: string | null) =>
  useQuery({
    queryKey: ['game-agent', id],
    queryFn: () => api<AgentConversationDto>(`/api/v1/game/agents/${id}/conversation`),
    enabled: Boolean(id),
  });
export const useSlot = (id: string | null) =>
  useQuery({
    queryKey: ['game-slot', id],
    queryFn: () => api<GameSlotDetailDto>(`/api/v1/game/slots/${id}`),
    enabled: Boolean(id),
  });
export const useMaterial = (id: string | null) =>
  useQuery({
    queryKey: ['game-material', id],
    queryFn: () => api<GameSlotMaterialDto>(`/api/v1/game/materials/${id}`),
    enabled: Boolean(id),
  });
export const useMaterialSearch = (q: string, enabled = true) =>
  useQuery({
    queryKey: ['game-material-search', q],
    queryFn: () =>
      api<GameMaterialSearchDto[]>(`/api/v1/game/materials?q=${encodeURIComponent(q)}`),
    enabled,
    staleTime: 10_000,
  });
export const useRevisions = (key: string | null) =>
  useQuery({
    queryKey: ['game-revisions', key],
    queryFn: () => api<GameLayoutRevisionDto[]>(`/api/v1/game/spaces/${key}/revisions`),
    enabled: Boolean(key),
  });

/** Ficha da OS, materiais e fotos: rotas oficiais do Cenário Gestão. */
export const useServiceOrder = (id: string | null) =>
  useQuery({
    queryKey: ['service-order', id],
    queryFn: () => api<ServiceOrderDto>(`/api/v1/service-orders/${id}`),
    enabled: Boolean(id),
  });
/** Lista simples de materiais da OS (informativa; Compras e prontidão saíram do Cenário). */
export const useOsMaterials = (id: string | null) =>
  useQuery({
    queryKey: ['game-os-materials', id],
    queryFn: () => api<OsMaterialsDto>(`/api/v1/service-orders/${id}/material-list`),
    enabled: Boolean(id),
  });
export const usePhotos = (entityType: string, id: string | null) =>
  useQuery({
    queryKey: ['game-photos', entityType, id],
    queryFn: () =>
      api<AttachmentDto[]>(`/api/v1/attachments?entityType=${entityType}&entityId=${id}`),
    enabled: Boolean(id),
  });

/** Fornecedores do escritório (agente de Compras). */
export const useSuppliers = (enabled = true) =>
  useQuery({
    queryKey: ['game-suppliers'],
    queryFn: () => api<SupplierDto[]>('/api/v1/game/suppliers'),
    enabled,
    staleTime: 60_000,
  });

/** Progresso do jogo (nível, missões, placar) guardado no servidor, por empresa. */
export const useProgressStore = (enabled: boolean) =>
  useQuery({
    queryKey: ['game-progress'],
    queryFn: () => api<ProgressStore>('/api/v1/game/progress'),
    enabled,
    staleTime: 60_000,
    retry: 1,
  });

/** Aparência do boneco "Você" desta pessoa. */
export const useAvatarLook = () =>
  useQuery({
    queryKey: ['game-avatar'],
    queryFn: () => api<{ look: AvatarLook | null }>('/api/v1/game/avatar'),
    staleTime: 300_000,
  });
