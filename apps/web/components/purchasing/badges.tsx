import {
  LINE_STAGE_LABEL,
  MATERIAL_READINESS_LABEL,
  PURCHASE_ORDER_STATUS_LABEL,
  RESERVATION_STATUS_LABEL,
  type LineStage,
  type MaterialReadiness,
  type PurchaseOrderStatus,
  type ReservationStatus,
} from '@cenario/shared';
import { Badge } from '@/components/ui/misc';

type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger' | 'info' | 'bronze';

const PO_TONE: Record<PurchaseOrderStatus, Tone> = {
  RASCUNHO: 'neutral',
  CONFIRMADO: 'info',
  PARCIALMENTE_RECEBIDO: 'bronze',
  RECEBIDO: 'ok',
  CANCELADO: 'neutral',
};
const READY_TONE: Record<MaterialReadiness, Tone> = {
  SEM_LEVANTAMENTO: 'neutral',
  AGUARDANDO_APROVACAO: 'warn',
  AGUARDANDO_COMPRA: 'warn',
  AGUARDANDO_RECEBIMENTO: 'info',
  PARCIALMENTE_DISPONIVEL: 'bronze',
  COMPLETO: 'ok',
  COM_DIVERGENCIA: 'danger',
};
const STAGE_TONE: Record<LineStage, Tone> = {
  SOLICITADO: 'neutral',
  APROVADO: 'warn',
  COMPRADO: 'info',
  PARCIALMENTE_RECEBIDO: 'bronze',
  RECEBIDO_CONFERIDO: 'brand',
  RESERVADO: 'brand',
  DISPONIVEL: 'ok',
};

export const PurchaseStatusBadge = ({ status }: { status: PurchaseOrderStatus }) => (
  <Badge tone={PO_TONE[status]} dot>
    {PURCHASE_ORDER_STATUS_LABEL[status]}
  </Badge>
);
export const ReadinessBadge = ({ state }: { state: MaterialReadiness }) => (
  <Badge tone={READY_TONE[state]} dot>
    {MATERIAL_READINESS_LABEL[state]}
  </Badge>
);
export const StageBadge = ({ stage }: { stage: LineStage }) => (
  <Badge tone={STAGE_TONE[stage]}>{LINE_STAGE_LABEL[stage]}</Badge>
);
export const ReservationBadge = ({ status }: { status: ReservationStatus }) => (
  <Badge tone={status === 'ATIVA' ? 'brand' : status === 'CONSUMIDA' ? 'ok' : 'neutral'}>
    {RESERVATION_STATUS_LABEL[status]}
  </Badge>
);
