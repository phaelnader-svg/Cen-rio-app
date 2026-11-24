import { z } from 'zod';
import type { OperationalReason, OperationalState } from './operational-state';

/**
 * Oficina sem tablet (2026-11-24, pedido do Raphael): o gestor troca o andamento do serviço pelo
 * computador ou pelo celular, um clique por etapa, na ordem real da oficina:
 *
 *   Material comprado → Começou → Ficou pronta → Aprovada → Saiu para entrega → Entregue
 *
 * Não é uma segunda fonte de verdade: cada botão grava pelos MESMOS caminhos do tablet, da
 * qualidade e da entrega (tarefas, inspeção, entrega), em nome do tapeceiro da OS, e o histórico
 * guarda quem marcou. A próxima etapa sai do estado da OS (operational-state), que é o mesmo da
 * lista, do cabeçalho da OS e do Início.
 */
export const NEXT_STEPS = ['COMECOU', 'PRONTA', 'APROVADA', 'SAIU', 'ENTREGUE'] as const;
export type NextStep = (typeof NEXT_STEPS)[number];

export const NEXT_STEP_LABEL: Record<NextStep, string> = {
  COMECOU: 'Começou',
  PRONTA: 'Ficou pronta',
  APROVADA: 'Aprovada',
  SAIU: 'Saiu para entrega',
  ENTREGUE: 'Entregue',
};

/** Frase do histórico e do aviso de "feito" (OS-00012 começou…). */
export const NEXT_STEP_DONE: Record<NextStep, string> = {
  COMECOU: 'começou',
  PRONTA: 'ficou pronta',
  APROVADA: 'foi aprovada na qualidade',
  SAIU: 'saiu para entrega',
  ENTREGUE: 'foi entregue',
};

/** Permissão que cada etapa exige (a mesma da tela que já fazia aquilo). */
export const NEXT_STEP_PERMISSION = {
  COMECOU: 'producao.planejar',
  PRONTA: 'producao.planejar',
  APROVADA: 'qualidade.gerenciar',
  SAIU: 'entregas.gerenciar',
  ENTREGUE: 'entregas.gerenciar',
} as const satisfies Record<NextStep, string>;

/** Chave da funcionalidade em Empresa → Funcionalidades. */
export const SHOP_FLOOR_MODULE = 'oficina_sem_tablet';

/**
 * Próxima etapa da OS (null = nada a marcar agora). Sem "Material comprado" a próxima etapa é o
 * botão de material, que já existe na lista; depois disso, a etapa vem do estado da OS.
 */
export function nextStepOf(input: {
  state: OperationalState;
  reasons?: readonly (OperationalReason | string)[];
  materialPurchased: boolean;
  cancelled?: boolean;
}): NextStep | null {
  if (input.cancelled) return null;
  switch (input.state) {
    case 'NAO_PLANEJADA':
    case 'AGUARDANDO_MATERIAIS':
    case 'PRODUCAO_IMPEDIDA':
    case 'PRONTA_PARA_PRODUCAO':
      return input.materialPurchased ? 'COMECOU' : null;
    case 'EM_PRODUCAO':
    case 'CORRECAO_NECESSARIA':
      return 'PRONTA';
    case 'AGUARDANDO_QUALIDADE':
      return 'APROVADA';
    case 'PRONTA_PARA_ENTREGA':
      // Ocorrência que bloqueia a expedição: resolve primeiro (tela de entregas).
      return input.reasons?.includes('BLOQUEIO_EXPEDICAO') ? null : 'SAIU';
    case 'EM_ENTREGA':
      return 'ENTREGUE';
    default:
      return null;
  }
}

export const advanceServiceOrderSchema = z.object({
  /** A etapa que a pessoa viu no botão: se a OS já andou, nada é marcado duas vezes. */
  step: z.enum(NEXT_STEPS),
  /**
   * "Cliente buscou": a partir de "Pronta para entrega", marca entregue sem passar pela saída.
   * Só vale com step = ENTREGUE.
   */
  pickedUpByCustomer: z.boolean().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});
export type AdvanceServiceOrderInput = z.infer<typeof advanceServiceOrderSchema>;

export interface AdvanceServiceOrderResultDto {
  serviceOrderId: string;
  code: string;
  /** Etapa marcada agora (null = a OS já estava adiante; nada foi gravado). */
  done: NextStep | null;
  /** Próxima etapa depois desta. */
  next: NextStep | null;
  /** Estado da OS depois do clique. */
  state: OperationalState;
  /** Quem ficou com o serviço (nome do tapeceiro), quando houver. */
  upholsterer: string | null;
  /** Inspeção onde a foto do serviço pronto entra (álbum "pronto"), quando houver. */
  photoTarget: { entityType: 'QUALITY_INSPECTION'; entityId: string } | null;
}

/** "Hoje na oficina": serviços em andamento por tapeceiro. */
export interface ShopFloorServiceDto {
  id: string;
  code: string;
  customer: { id: string; name: string; phone: string | null };
  pieces: string;
  promisedDate: string | null;
  priority: string;
  state: OperationalState;
  next: NextStep | null;
  materialPurchased: boolean;
  rework: boolean;
  version: number;
  /** Último movimento da OS (início, etapa, qualidade, entrega). */
  lastMoveAt: string | null;
  /** Dias desde o último movimento (só quando a produção já começou). */
  stoppedDays: number | null;
  late: boolean;
}

export interface ShopFloorGroupDto {
  upholsterer: {
    id: string;
    displayName: string;
    color: string | null;
    photoUrl: string | null;
  } | null;
  services: ShopFloorServiceDto[];
}

export interface ShopFloorDto {
  /** Funcionalidade "Oficina sem tablet" ligada. */
  withoutTablet: boolean;
  groups: ShopFloorGroupDto[];
  counts: { started: number; ready: number; delivery: number; waiting: number };
}

/** Serviço em produção sem nenhum movimento há este número de dias vira aviso no sininho. */
export const STOPPED_SERVICE_DAYS = 3;
