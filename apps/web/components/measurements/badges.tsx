import {
  MATERIAL_REQUEST_STATUS_LABEL,
  MEASUREMENT_STATUS_LABEL,
  type MaterialRequestStatus,
  type MeasurementKind,
  type MeasurementStatus,
} from '@cenario/shared';
import { Badge } from '@/components/ui/misc';

type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger' | 'info' | 'bronze';

const STATUS_TONE: Record<MeasurementStatus, Tone> = {
  PENDENTE: 'warn',
  EM_ANDAMENTO: 'info',
  CONCLUIDA: 'ok',
  CANCELADA: 'neutral',
};
const REQUEST_TONE: Record<MaterialRequestStatus, Tone> = {
  RASCUNHO: 'neutral',
  ENVIADA: 'brand',
  EM_REVISAO: 'info',
  APROVADA: 'ok',
  DEVOLVIDA: 'danger',
  CANCELADA: 'neutral',
};

export const MeasurementStatusBadge = ({ status }: { status: MeasurementStatus }) => (
  <Badge tone={STATUS_TONE[status]} dot>
    {MEASUREMENT_STATUS_LABEL[status]}
  </Badge>
);

export const RequestStatusBadge = ({ status }: { status: MaterialRequestStatus }) => (
  <Badge tone={REQUEST_TONE[status]}>
    Materiais: {MATERIAL_REQUEST_STATUS_LABEL[status].toLowerCase()}
  </Badge>
);

export const KindBadge = ({ kind }: { kind: MeasurementKind }) =>
  kind === 'ROTINA' ? (
    <Badge tone="bronze">Sexta (rotina)</Badge>
  ) : (
    <Badge tone="warn">Extraordinária</Badge>
  );
