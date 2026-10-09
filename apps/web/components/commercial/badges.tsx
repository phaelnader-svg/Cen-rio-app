import {
  ORDER_SERVICE_STATE_LABEL,
  ORDER_STATUS_LABEL,
  PICKUP_STATUS_LABEL,
  PRIORITY_LABEL,
  SERVICE_ORDER_STATUS_LABEL,
  type OrderStatus,
  type PickupStatus,
  type Priority,
  type ServiceOrderStatus,
  type OrderServiceState,
} from '@cenario/shared';
import { Badge } from '@/components/ui/misc';

type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger' | 'info' | 'bronze';

const ORDER_TONE: Record<OrderStatus, Tone> = {
  AGUARDANDO_RETIRADA: 'warn',
  RETIRADA_AGENDADA: 'info',
  RECEBIDO_PARCIAL: 'bronze',
  RECEBIDO: 'ok',
  CANCELADO: 'danger',
};
const PICKUP_TONE: Record<PickupStatus, Tone> = {
  AGUARDANDO_AGENDAMENTO: 'warn',
  AGENDADA: 'info',
  EM_EXECUCAO: 'brand',
  RETIRADA_REALIZADA: 'bronze',
  RECEBIDA_NA_OFICINA: 'ok',
  CANCELADA: 'neutral',
  COM_OCORRENCIA: 'danger',
};
const PRIORITY_TONE: Record<Priority, Tone> = {
  BAIXA: 'neutral',
  NORMAL: 'info',
  ALTA: 'warn',
  URGENTE: 'danger',
};

export const OrderStatusBadge = ({ status }: { status: OrderStatus }) => (
  <Badge tone={ORDER_TONE[status]} dot>
    {ORDER_STATUS_LABEL[status]}
  </Badge>
);
export const PickupStatusBadge = ({ status }: { status: PickupStatus }) => (
  <Badge tone={PICKUP_TONE[status]} dot>
    {PICKUP_STATUS_LABEL[status]}
  </Badge>
);
export const PriorityBadge = ({ priority }: { priority: Priority }) => (
  <Badge tone={PRIORITY_TONE[priority]}>Prioridade {PRIORITY_LABEL[priority].toLowerCase()}</Badge>
);
export const ServiceOrderStatusBadge = ({ status }: { status: ServiceOrderStatus }) => (
  <Badge tone={status === 'ABERTA' ? 'ok' : 'neutral'} dot>
    {SERVICE_ORDER_STATUS_LABEL[status]}
  </Badge>
);

/** Fase 12: situação do serviço (devoluções, concluído, cancelado) — oculta "em andamento". */
export const ServiceStateBadge = ({
  state,
  returned = 0,
}: {
  state: OrderServiceState;
  returned?: number;
}) =>
  state === 'EM_ANDAMENTO' ? null : (
    <Badge
      tone={
        state === 'SERVICO_CONCLUIDO'
          ? 'ok'
          : state === 'SERVICO_CANCELADO'
            ? 'neutral'
            : state === 'DEVOLUCAO_TOTAL'
              ? 'danger'
              : 'warn'
      }
    >
      {ORDER_SERVICE_STATE_LABEL[state]}
      {returned > 0 && state === 'SERVICO_CONCLUIDO' ? ` · ${returned} devolvida(s)` : ''}
    </Badge>
  );
