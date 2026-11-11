'use client';

import {
  OPERATIONAL_NEXT_STEP,
  OPERATIONAL_STATE_LABEL,
  OPERATIONAL_STATE_TONE,
  OPERATIONAL_STATES,
  type OperationalState,
  type OperationalStateDto,
} from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { Badge } from '@/components/ui/misc';
import { api } from '@/lib/api';

export const useOperationalState = (serviceOrderId: string, enabled = true) =>
  useQuery({
    queryKey: ['os-state', serviceOrderId],
    queryFn: () =>
      api<OperationalStateDto>(`/api/v1/service-orders/${serviceOrderId}/operational-state`),
    enabled,
  });

/**
 * Reformulação, Fase 3 — apresentação ÚNICA do estado geral da OS (regra da Fase 0): mesmo
 * rótulo e mesmo tom em todas as telas (cabeçalho da OS, lista de OS…), sem cada tela inventar
 * o seu.
 */
export function OsStateBadge({ state }: { state: OperationalState }) {
  return (
    <Badge tone={OPERATIONAL_STATE_TONE[state]} dot>
      <span data-testid="os-state-badge" data-state={state}>
        {OPERATIONAL_STATE_LABEL[state]}
      </span>
    </Badge>
  );
}

/**
 * Reformulação, Fase 2 — estado geral da OS no cabeçalho (o estado operacional da Fase 0, que
 * existia só na API): a peça menos avançada define o estado; ao lado, quantas peças estão em cada
 * estado e o próximo passo, com atalho para a aba que trata dele. Só leitura.
 */
export function OsStateHeader({
  serviceOrderId,
  onGo,
}: {
  serviceOrderId: string;
  onGo: (tab: string) => void;
}) {
  const q = useOperationalState(serviceOrderId);
  if (!q.data) return null;
  const s = q.data;
  const next = OPERATIONAL_NEXT_STEP[s.state];
  const parts = OPERATIONAL_STATES.filter((k) => s.counts[k]).map(
    (k) => `${s.counts[k]} ${OPERATIONAL_STATE_LABEL[k].toLowerCase()}`,
  );
  return (
    <div
      className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface px-4 py-3"
      data-testid="os-state"
      data-state={s.state}
    >
      <span className="text-sm text-ink-muted">Situação</span>
      <OsStateBadge state={s.state} />
      {s.totalItems > 1 && parts.length > 1 && (
        <span className="text-xs text-ink-muted" data-testid="os-state-counts">
          {parts.join(' · ')}
        </span>
      )}
      <span className="ml-auto flex items-center gap-2 text-sm">
        <span className="text-ink-muted">Próximo passo:</span>
        {next.area ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline"
            onClick={() => onGo(next.area!)}
            data-testid="os-next-step"
          >
            {next.text} <ArrowRight className="size-3.5" aria-hidden />
          </button>
        ) : (
          <span className="font-medium" data-testid="os-next-step">
            {next.text}
          </span>
        )}
      </span>
    </div>
  );
}
