import { z } from 'zod';

/**
 * Reformulação, Fase 0 — funcionalidades operacionais que podem ser ligadas e desligadas sem
 * nova imagem e sem apagar nada (o histórico continua legível). Fonte única: o servidor decide
 * pela tabela `module_settings`; a interface só esconde o que o servidor já recusa.
 *
 * Ausência de registro = valor padrão. Logística e ajuda vêm "ligadas" (comportamento
 * anterior até alguém desligar). Etapa E1 da correção da reformulação: as travas de materiais
 * ("materiais") vêm DESLIGADAS — a produção não depende do processo formal de compras, medições,
 * aprovações, recebimentos ou reservas; quem quiser esse controle liga em Empresa → Funcionalidades.
 *
 * `configurable: false` = a chave existe mas ainda não pode ser alterada (nenhuma hoje).
 *
 * Fase 1: a logística passou a ser configurável (a entrega direta pela OS substitui a operação de
 * entregas) e "materiais" controla as travas de materiais na liberação da produção.
 */
/**
 * Reformulação S1: "embalagem" deixou de existir (a embalagem não é mais etapa). Remoção dos módulos
 * (2026-11): "ajuda" (pedidos de ajuda) e "materiais" (travas de materiais) também deixaram de
 * existir. Registros antigos com essas chaves em `module_settings` são ignorados por
 * `resolveModules` (chave desconhecida).
 */
export const MODULE_KEYS = ['logistica'] as const;
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
};

/**
 * Avisos de funcionalidades removidas do sistema (pedidos de ajuda, compras, medições e
 * recebimentos): os registros antigos ficam no banco, mas nunca aparecem mais.
 */
export const RETIRED_NOTIFICATION_KINDS: readonly string[] = [
  'AJUDA_SOLICITADA',
  'AJUDA_ATRIBUIDA',
  'AJUDA_EM_ESPERA',
  'AJUDA_CANCELADA',
  'AJUDA_CONCLUIDA',
];

/** Tipos de notificação a esconder no estado atual. */
export function hiddenNotificationKinds(state: ModuleState): string[] {
  return [
    ...RETIRED_NOTIFICATION_KINDS,
    ...MODULE_KEYS.filter((k) => !state[k]).flatMap((k) => MODULE_NOTIFICATION_KINDS[k]),
  ];
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
