import type { Tx } from '@cenario/db';
import type { ActorContext } from './types';

/**
 * Fase 10: alteração técnica relevante de uma peça da OS (dados técnicos do item ou novas
 * medidas). Quem precisa reagir (ex.: qualidade invalida a aprovação) se registra aqui,
 * sem acoplar o módulo de OS aos módulos seguintes.
 */
export interface ItemTechnicalChange {
  itemId: string;
  serviceOrderId: string;
  scope: 'ITEM' | 'MEDICAO';
  summary: string;
}
type Listener = (tx: Tx, actor: ActorContext, change: ItemTechnicalChange) => Promise<void>;
const listeners: Listener[] = [];

export function onItemTechnicalChange(listener: Listener) {
  listeners.push(listener);
}
export async function emitItemTechnicalChange(
  tx: Tx,
  actor: ActorContext,
  change: ItemTechnicalChange,
) {
  for (const l of listeners) await l(tx, actor, change);
}
