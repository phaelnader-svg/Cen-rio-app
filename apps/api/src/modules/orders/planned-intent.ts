import type { Tx } from '@cenario/db';
import { Errors } from '../../lib/errors';
import { loadTeam, upholstererOk, type Team } from '../production/distribution';

/**
 * Estabilização da Simplificação, Fase 2 (Fase 1 §4.3 opção B): o fechamento do serviço registra,
 * por peça, o tapeceiro titular e a mão de obra PREVISTA. É intenção técnica do item do pedido —
 * nenhuma obrigação financeira nasce aqui. Quando a chegada gera a OS, a intenção vira titular e
 * mão de obra combinada (valor por unidade × quantidade que chegou), pela mesma regra da criação
 * manual da OS. As permissões são as mesmas da criação da OS: titular exige `producao.planejar`;
 * mão de obra exige `financeiro.ver` + `financeiro.gerenciar`.
 */
export interface PlannedIntent {
  description: string;
  plannedUpholstererUserId?: string | null;
  plannedLaborUnitCents?: number | null;
}

type Perms = { has(permission: string): boolean };

export const canPlanUpholsterer = (perms: Perms) => perms.has('producao.planejar');
export const canPlanLabor = (perms: Perms) =>
  perms.has('financeiro.ver') && perms.has('financeiro.gerenciar');

/** Quem pode receber a mão de obra por produção: o tapeceiro principal (mesma regra do financeiro). */
export const laborEligible = (team: Team, userId: string) => {
  const m = team.get(userId);
  return Boolean(m && m.canExecute && m.isTapeceiro);
};

/** Valida permissões e elegibilidade da intenção (recusa com a mesma mensagem da OS manual). */
export async function assertPlannedIntent(
  tx: Tx,
  perms: Perms,
  items: PlannedIntent[],
): Promise<void> {
  const withOwner = items.filter((i) => i.plannedUpholstererUserId);
  if (withOwner.length && !canPlanUpholsterer(perms))
    throw Errors.forbidden('Definir o tapeceiro titular exige a permissão de planejar a produção.');
  if (items.some((i) => i.plannedLaborUnitCents) && !canPlanLabor(perms))
    throw Errors.forbidden('Combinar a mão de obra exige a permissão de gerenciar o financeiro.');
  await assertIntentEligible(tx, withOwner);
}

/** Elegibilidade atual do titular (e do recebedor da mão de obra) previstos. */
export async function assertIntentEligible(tx: Tx, items: PlannedIntent[]): Promise<void> {
  const withOwner = items.filter((i) => i.plannedUpholstererUserId);
  if (!withOwner.length) return;
  const team = await loadTeam(tx);
  for (const it of withOwner) {
    const userId = it.plannedUpholstererUserId!;
    if (!upholstererOk(team, userId))
      throw Errors.business(
        `"${it.description}": o titular precisa ser um tapeceiro ativo com permissão de produção.`,
      );
    if (it.plannedLaborUnitCents && !laborEligible(team, userId))
      throw Errors.business(
        `"${it.description}": pagamento por produção é só para o tapeceiro principal (equipe de remuneração fixa usa "Custos de equipe").`,
      );
  }
}
