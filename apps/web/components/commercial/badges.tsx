import {
  DEADLINE_REASON_LABEL,
  DEADLINE_STATE_LABEL,
  ORDER_DEADLINE_LABEL,
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
  type OrderDeadlineState,
  type ServiceDeadline,
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

/** Rótulo da situação do pedido: sem retirada, "aguardando" é a entrega pelo cliente. */
export const orderStatusLabel = (status: OrderStatus, customerDropOff?: boolean) =>
  status === 'AGUARDANDO_RETIRADA' && customerDropOff
    ? 'Aguardando entrega do cliente'
    : ORDER_STATUS_LABEL[status];

export const OrderStatusBadge = ({
  status,
  customerDropOff,
}: {
  status: OrderStatus;
  customerDropOff?: boolean;
}) => (
  <Badge tone={ORDER_TONE[status]} dot>
    {orderStatusLabel(status, customerDropOff)}
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

/**
 * Prazos e serviços em risco: rótulo discreto do estado do prazo (calculado pela API — a tela
 * não recalcula). Só ATRASADO, EM_RISCO e PROXIMO aparecem; o resto fica sem rótulo.
 */
export function DeadlineBadge({
  deadline,
  withReasons = false,
}: {
  deadline: ServiceDeadline;
  withReasons?: boolean;
}) {
  const tone: Partial<Record<ServiceDeadline['state'], Tone>> = {
    ATRASADO: 'danger',
    EM_RISCO: 'warn',
    PROXIMO: 'neutral',
  };
  const t = tone[deadline.state];
  if (!t) return null;
  const why = [...deadline.reasons.map((r) => DEADLINE_REASON_LABEL[r]), ...deadline.context];
  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-testid="deadline-state">
      <Badge tone={t}>{DEADLINE_STATE_LABEL[deadline.state]}</Badge>
      {withReasons && why.length > 0 && (
        <span className="text-sm text-ink-muted" data-testid="deadline-reasons">
          {why.join(' · ')}
        </span>
      )}
    </span>
  );
}

export function OrderDeadlineBadge({ state }: { state: OrderDeadlineState | null }) {
  if (!state) return null;
  return (
    <Badge tone={state === 'PRAZO_VENCIDO' ? 'danger' : 'warn'}>
      {ORDER_DEADLINE_LABEL[state]} · peça não recebida
    </Badge>
  );
}
