import { plural } from '@cenario/shared';
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
import Link from 'next/link';
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
/** Melhoria 161: nas listas, a prioridade só aparece quando foge do normal (alta ou urgente). */
export const PriorityBadge = ({ priority, always }: { priority: Priority; always?: boolean }) =>
  always || priority === 'ALTA' || priority === 'URGENTE' ? (
    <Badge tone={PRIORITY_TONE[priority]}>
      Prioridade {PRIORITY_LABEL[priority].toLowerCase()}
    </Badge>
  ) : null;
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
      {returned > 0 && state === 'SERVICO_CONCLUIDO'
        ? ` · ${plural(returned, 'devolvida', 'devolvidas')}`
        : ''}
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

/** 2026-11-18: tudo que nasce de um retrabalho aparece em vermelho (agenda, OS, pedidos). */
export function ReworkBadge({ rework }: { rework?: { code: string } | null }) {
  if (!rework) return null;
  return <Badge tone="danger">Retrabalho {rework.code}</Badge>;
}

/** Faixa vermelha no topo do pedido e da OS de um retrabalho. */
export function ReworkBanner({ rework }: { rework?: { code: string } | null }) {
  if (!rework) return null;
  return (
    <p className="mb-4 flex items-center gap-2 rounded-lg border border-danger-600/30 bg-danger-50 px-4 py-2.5 text-sm font-medium text-danger-700">
      <span className="size-2 rounded-full bg-danger-600" aria-hidden />
      Retrabalho {rework.code}: serviço que voltou para ser refeito, sem cobrança.{' '}
      <Link href="/painel/retrabalhos" className="ml-auto underline">
        Ver retrabalhos
      </Link>
    </p>
  );
}
