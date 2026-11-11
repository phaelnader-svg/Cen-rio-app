import type { PieceType } from './domain';
import type { FulfillmentStage } from './quality-domain';

/**
 * Reformulação, Fase 2 — mapa interno da oficina: onde cada peça está fisicamente.
 *
 * Usa as localizações que já existiam (item_locations, cadastradas em Qualidade › Inspetor e
 * localizações) e a localização atual de cada peça (current_location_id, movida pelo registro já
 * existente de movimentação). Nada de mapa geográfico: é a planta da oficina por áreas.
 * Peças sem movimentação registrada aparecem em "Sem localização registrada", com o texto do
 * recebimento como referência.
 */
export const WORKSHOP_MAP_PERMISSIONS = [
  'os.ver',
  'producao.ver',
  'producao.planejar',
  'qualidade.gerenciar',
  'entregas.ver',
  'entregas.gerenciar',
] as const;

/** Etapas em que a peça já saiu da oficina (ou deixou de existir para ela). */
export const OFF_WORKSHOP_STAGES = ['ENTREGUE', 'DEVOLVIDA', 'CANCELADA'] as const;

export interface WorkshopMapPieceDto {
  id: string;
  code: string;
  description: string;
  pieceType: PieceType;
  quantity: number;
  serviceOrderId: string;
  serviceOrderCode: string;
  customerName: string;
  stage: FulfillmentStage;
  /** Onde ficou no recebimento (texto livre), para quem ainda não foi movida. */
  receiptLocations: string[];
  movedAt: string | null;
  movedBy: string | null;
}

export interface WorkshopMapAreaDto {
  id: string;
  key: string;
  label: string;
  position: number;
  active: boolean;
  pieces: WorkshopMapPieceDto[];
}

export interface WorkshopMapDto {
  areas: WorkshopMapAreaDto[];
  unplaced: WorkshopMapPieceDto[];
  can: { move: boolean; manageAreas: boolean };
}
