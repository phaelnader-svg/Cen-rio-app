import { plural } from '@cenario/shared';
import {
  DEADLINE_REASON_LABEL,
  DEADLINE_STATE_LABEL,
  ORDER_DEADLINE_LABEL,
  ORDER_SERVICE_STATE_LABEL,
  ORDER_STATUS_LABEL,
  pickupStatusLabel,
  PRIORITY_LABEL,
  SERVICE_ORDER_STATUS_LABEL,
  type OrderStatus,
  type PickupKind,
  type PickupStatus,
  type Priority,
  type ServiceOrderStatus,
  type OrderServiceState,
  type OrderDeadlineState,
  type ServiceDeadline,
} from '@cenario/shared';
import { House } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/misc';

type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger' | 'info' | 'bronze';

const ORDER_TONE: Record<OrderStatus, Tone> = {
  AGUARDANDO_RETIRADA: 'warn',
  RETIRADA_AGENDADA: 'info',
  RECEBIDO_PARCIAL: 'bronze',
  RECEBIDO: 'ok',
  // Revisão geral (item 7): cancelado é informação (cinza); vermelho só atraso e retrabalho.
  CANCELADO: 'neutral',
};
const PICKUP_TONE: Record<PickupStatus, Tone> = {
  AGUARDANDO_AGENDAMENTO: 'warn',
  AGENDADA: 'info',
  EM_EXECUCAO: 'brand',
  RETIRADA_REALIZADA: 'bronze',
  RECEBIDA_NA_OFICINA: 'ok',
  CANCELADA: 'neutral',
  COM_OCORRENCIA: 'warn',
};
const PRIORITY_TONE: Record<Priority, Tone> = {
  BAIXA: 'neutral',
  NORMAL: 'info',
  ALTA: 'warn',
  // Revisão geral (item 7): vermelho é só atraso e retrabalho; urgente é atenção (laranja).
  URGENTE: 'warn',
};

/** Rótulo da situação do pedido: sem retirada, "aguardando" é a entrega pelo cliente. */
/** 2026-11-25: pedido "No local" (serviço na casa do cliente) usa palavras próprias. */
const ON_SITE_ORDER_LABEL: Partial<Record<OrderStatus, string>> = {
  RETIRADA_AGENDADA: 'No local agendado',
  RECEBIDO_PARCIAL: 'Feito no local em parte',
  RECEBIDO: 'Feito no local',
};

export const orderStatusLabel = (
  status: OrderStatus,
  customerDropOff?: boolean,
  onSite?: boolean,
) =>
  status === 'AGUARDANDO_RETIRADA' && customerDropOff
    ? 'Aguardando entrega do cliente'
    : (onSite && ON_SITE_ORDER_LABEL[status]) || ORDER_STATUS_LABEL[status];

export const OrderStatusBadge = ({
  status,
  customerDropOff,
  onSite,
}: {
  status: OrderStatus;
  customerDropOff?: boolean;
  onSite?: boolean;
}) => (
  <Badge tone={ORDER_TONE[status]} dot>
    {orderStatusLabel(status, customerDropOff, onSite)}
  </Badge>
);
export const PickupStatusBadge = ({
  status,
  kind,
}: {
  status: PickupStatus;
  kind?: PickupKind;
}) => (
  <Badge tone={PICKUP_TONE[status]} dot>
    {pickupStatusLabel(status, kind)}
  </Badge>
);
/** 2026-11-25: etiqueta "No local" (serviço na casa do cliente); Retirada não precisa de etiqueta. */
export const PickupKindBadge = ({ kind }: { kind: PickupKind }) =>
  kind === 'NO_LOCAL' ? (
    <Badge tone="brand">
      <House className="size-3.5" aria-hidden /> No local
    </Badge>
  ) : null;
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
    // Revisão geral (item 7): prazo perto é atenção (laranja), como "em risco".
    PROXIMO: 'warn',
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

export function OrderDeadlineBadge({
  state,
  onSite,
}: {
  state: OrderDeadlineState | null;
  onSite?: boolean;
}) {
  if (!state) return null;
  return (
    <Badge tone={state === 'PRAZO_VENCIDO' ? 'danger' : 'warn'}>
      {ORDER_DEADLINE_LABEL[state]} ·{' '}
      {onSite ? 'serviço no local ainda não feito' : 'peça não recebida'}
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
