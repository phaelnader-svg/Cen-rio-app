import { z } from 'zod';

/**
 * Reformulação, Fase 0 — funcionalidades operacionais que podem ser ligadas e desligadas sem
 * nova imagem e sem apagar nada (o histórico continua legível). Fonte única: o servidor decide
 * pela tabela `module_settings`; a interface só esconde o que o servidor já recusa.
 *
 * Ausência de registro = valor padrão. Todos os padrões são "ligado": uma instalação nova ou
 * migrada mantém o comportamento anterior até alguém desligar algo de forma explícita.
 *
 * `configurable: false` = a chave já existe (para os próximos passos), mas ainda não pode ser
 * alterada: desligar a embalagem obrigatória depende da Fase 3.
 *
 * Fase 1: a logística passou a ser configurável (a entrega direta pela OS substitui a operação de
 * entregas) e "materiais" controla as travas de materiais na liberação da produção.
 */
export const MODULE_KEYS = ['logistica', 'ajuda', 'embalagem', 'materiais'] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

export interface ModuleDefinition {
  label: string;
  description: string;
  defaultEnabled: boolean;
  configurable: boolean;
}

export const MODULES: Record<ModuleKey, ModuleDefinition> = {
  logistica: {
    label: 'Logística',
    description:
      'Retiradas, entregas agendadas, roteiro e custos de viagem. Desligada, a entrega é confirmada direto na OS ("Marcar como entregue"); o histórico de viagens fica só para consulta. Só pode ser desligada sem entregas e retiradas em andamento.',
    defaultEnabled: true,
    configurable: true,
  },
  ajuda: {
    label: 'Pedidos de ajuda',
    description:
      'Pedir ajudante, ajuda urgente e apoio prolongado pelo tablet, com fila e avisos ao gestor. Desligada, a produção continua normal e o histórico fica só para consulta.',
    defaultEnabled: true,
    configurable: true,
  },
  embalagem: {
    label: 'Embalagem obrigatória',
    description:
      'Etapa de embalagem entre a qualidade aprovada e "pronta para entrega". Desligar depende da Fase 3.',
    defaultEnabled: true,
    configurable: false,
  },
  materiais: {
    label: 'Travas de materiais na produção',
    description:
      'Ligada, as etapas que exigem material só são liberadas com compra recebida ou reserva. Desligada, a produção começa mesmo com materiais pendentes: a disponibilidade vira só aviso, e compras, reservas e estoque formais continuam disponíveis para quem quiser usar.',
    defaultEnabled: true,
    configurable: true,
  },
};

export type ModuleState = Record<ModuleKey, boolean>;

export const isModuleKey = (k: string): k is ModuleKey =>
  (MODULE_KEYS as readonly string[]).includes(k);

/**
 * Estado efetivo a partir dos registros gravados: chave ausente = padrão; chave desconhecida
 * (gravada por uma versão futura, por exemplo) é ignorada; chave ainda não configurável fica
 * sempre no padrão, mesmo que haja registro (nada muda de comportamento antes da fase certa).
 */
export function resolveModules(rows: readonly { key: string; enabled: boolean }[]): ModuleState {
  const state = Object.fromEntries(
    MODULE_KEYS.map((k) => [k, MODULES[k].defaultEnabled]),
  ) as ModuleState;
  for (const r of rows)
    if (isModuleKey(r.key) && MODULES[r.key].configurable) state[r.key] = r.enabled;
  return state;
}

/** Avisos de tablet/painel que pertencem a um módulo (escondidos quando ele está desligado). */
export const MODULE_NOTIFICATION_KINDS: Record<ModuleKey, readonly string[]> = {
  logistica: ['ENTREGA_ATRIBUIDA', 'ENTREGA_AGENDADA', 'ENTREGA_CONCLUIDA'],
  ajuda: [
    'AJUDA_SOLICITADA',
    'AJUDA_ATRIBUIDA',
    'AJUDA_EM_ESPERA',
    'AJUDA_CANCELADA',
    'AJUDA_CONCLUIDA',
  ],
  embalagem: [],
  materiais: [],
};

/** Tipos de notificação a esconder no estado atual (vazio = nenhum). */
export function hiddenNotificationKinds(state: ModuleState): string[] {
  return MODULE_KEYS.filter((k) => !state[k]).flatMap((k) => MODULE_NOTIFICATION_KINDS[k]);
}

export const updateModuleSchema = z.object({
  enabled: z.boolean(),
  /** Versão lida (0 = nunca configurado). */
  version: z.number().int().min(0),
});
export type UpdateModuleInput = z.infer<typeof updateModuleSchema>;

export interface ModuleSettingDto {
  key: ModuleKey;
  label: string;
  description: string;
  enabled: boolean;
  defaultEnabled: boolean;
  configurable: boolean;
  /** 0 = nunca configurado (vale o padrão). */
  version: number;
  updatedAt: string | null;
  updatedBy: { id: string; displayName: string } | null;
}
