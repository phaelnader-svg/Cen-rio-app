'use client';

import type { LogisticsRouteStopDto } from '@cenario/shared';
import {
  DELIVERY_STATUS_LABEL,
  PICKUP_STATUS_LABEL,
  PICKUP_TEAM_LABEL,
  type DeliveryStatus,
  type PickupStatus,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, MapPin } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { PickupDetailDialog } from '@/components/commercial/pickup-detail';
import { Button } from '@/components/ui/button';
import { DateField, FormActions, FormGrid, TextField } from '@/components/ui/form';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { addDays, arrivalText, todayIso } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import { useLogisticsRoute, useLogisticsRouteHistory } from '@/lib/quality';

/**
 * Correção global — ROTEIRO DO DIA (gestor). Ordem das paradas (sequência operacional) separada
 * do horário combinado com o cliente: mover uma parada nunca altera a data ou a chegada
 * combinada. Alertas apenas com dados confiáveis (sem estimativas de deslocamento).
 */

const key = (s: LogisticsRouteStopDto) => `${s.job.kind}:${s.job.id}`;
const statusLabel = (s: LogisticsRouteStopDto) =>
  s.job.kind === 'ENTREGA'
    ? DELIVERY_STATUS_LABEL[s.job.status as DeliveryStatus]
    : PICKUP_STATUS_LABEL[s.job.status as PickupStatus];

export function LogisticsRoutePage() {
  const params = useSearchParams();
  const router = useRouter();
  const can = useCan();
  const date = params.get('data') ?? todayIso();
  const q = useLogisticsRoute(date);
  const history = useLogisticsRouteHistory(date);
  const manage = can('entregas.gerenciar') || can('retiradas.gerenciar');
  // Rascunho da nova ordem, sempre ligado ao dia em que foi feito (trocar o dia descarta).
  const [pending, setDraft0] = useState<{ date: string; order: string[] } | null>(null);
  const [reason, setReason] = useState('');
  const [pickupOpen, setPickupOpen] = useState<string | null>(null);
  const idem = useRef(newIdempotencyKey());
  const qc = useQueryClient();
  const toast = useToast();
  const go = (d: string) => {
    setDraft(null);
    router.replace(`/painel/roteiro?data=${d}`);
  };
  const draft = pending?.date === date ? pending.order : null;
  const setDraft = (order: string[] | null) => setDraft0(order ? { date, order } : null);

  const stops = useMemo(() => {
    const list = q.data?.stops ?? [];
    if (!draft) return list;
    const by = new Map(list.map((s) => [key(s), s]));
    return draft.map((k) => by.get(k)).filter((s): s is LogisticsRouteStopDto => Boolean(s));
  }, [q.data, draft]);
  const dirty = Boolean(draft && q.data && draft.join() !== q.data.stops.map(key).join());

  const move = (idx: number, delta: -1 | 1) => {
    const order = stops.map(key);
    const j = idx + delta;
    if (j < 0 || j >= order.length) return;
    [order[idx], order[j]] = [order[j]!, order[idx]!];
    setDraft(order);
  };

  const save = useMutation({
    mutationFn: () =>
      api('/api/v1/logistics/route/sequence', {
        method: 'PUT',
        body: {
          date,
          stops: stops.map((s) => ({ kind: s.job.kind, id: s.job.id })),
          reason: reason.trim() || null,
        },
        idempotencyKey: idem.current,
      }),
    onSuccess: () => {
      idem.current = newIdempotencyKey();
      setDraft(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['logistics-route', date] });
      toast('ok', 'Sequência do roteiro salva. Horários combinados com os clientes não mudaram.');
    },
    onError: (e) => {
      idem.current = newIdempotencyKey();
      if (e instanceof ApiError && e.status === 409) {
        setDraft(null);
        void qc.invalidateQueries({ queryKey: ['logistics-route', date] });
      }
      toast('danger', e instanceof Error ? e.message : 'Não foi possível salvar a sequência.');
    },
  });

  return (
    <>
      <PageHeader
        title="Roteiro do dia"
        description="Retiradas e entregas do dia na ordem de execução. A ordem é operacional: mudá-la não altera o horário de chegada combinado com o cliente."
      />
      <Card className="mb-5 p-4 sm:p-5">
        <FormGrid>
          <DateField
            label="Dia"
            cols={4}
            value={date}
            onChange={(e) => e.target.value && go(e.target.value)}
            data-testid="route-date"
          />
          <div className="field-action sm:col-span-8">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => go(addDays(date, -1))}
                icon={<ChevronLeft className="size-4" aria-hidden />}
              >
                Dia anterior
              </Button>
              <Button variant="secondary" onClick={() => go(todayIso())}>
                Hoje
              </Button>
              <Button variant="secondary" onClick={() => go(addDays(todayIso(), 1))}>
                Amanhã
              </Button>
              <Button
                variant="secondary"
                onClick={() => go(addDays(date, 1))}
                icon={<ChevronRight className="size-4" aria-hidden />}
              >
                Próximo dia
              </Button>
            </div>
          </div>
        </FormGrid>
      </Card>

      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : !stops.length ? (
        <EmptyState title="Nenhuma retirada ou entrega neste dia" />
      ) : (
        <div className="space-y-4">
          {q.data.warnings.map((w) => (
            <Alert key={w} tone="warn">
              {w}
            </Alert>
          ))}
          <ol className="space-y-3" data-testid="route-stops" aria-label="Paradas do roteiro">
            {stops.map((s, idx) => (
              <li key={key(s)} data-testid={`stop-${s.job.code}`} data-position={idx + 1}>
                <StopCard
                  s={s}
                  position={idx + 1}
                  manage={manage}
                  first={idx === 0}
                  last={idx === stops.length - 1}
                  onUp={() => move(idx, -1)}
                  onDown={() => move(idx, 1)}
                  onOpenPickup={() => setPickupOpen(s.job.id)}
                />
              </li>
            ))}
          </ol>
          {manage && dirty && (
            <Card className="p-4 sm:p-5" data-testid="route-save">
              <FormGrid>
                <TextField
                  label="Motivo da nova ordem (opcional)"
                  cols={8}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Ex.: cliente pediu prioridade; trânsito"
                />
                <div className="field-action sm:col-span-4">
                  <FormActions className="w-full">
                    <Button variant="secondary" onClick={() => setDraft(null)}>
                      Descartar
                    </Button>
                    <Button loading={save.isPending} onClick={() => save.mutate()}>
                      Salvar sequência
                    </Button>
                  </FormActions>
                </div>
              </FormGrid>
              <p className="mt-2 text-xs text-ink-muted">
                A ordem é só da execução: data e horário combinados com cada cliente continuam os
                mesmos. A alteração fica registrada no histórico.
              </p>
            </Card>
          )}
        </div>
      )}

      <Card className="mt-6 p-4 sm:p-5">
        <h2 className="mb-3 font-semibold">Histórico de alterações da sequência</h2>
        {!history.data?.length ? (
          <p className="text-sm text-ink-muted">Nenhuma alteração neste dia.</p>
        ) : (
          <ul className="space-y-2 text-sm" data-testid="route-history">
            {history.data.map((h) => (
              <li key={h.at} className="rounded-xl bg-subtle/60 px-3 py-2">
                <span className="font-medium">{formatDateTime(h.at)}</span>
                {h.actor ? ` · ${h.actor}` : ''}: {h.after.join(' → ')}
                {h.reason && <span className="block text-ink-muted">Motivo: {h.reason}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {pickupOpen && <PickupDetailDialog id={pickupOpen} onClose={() => setPickupOpen(null)} />}
    </>
  );
}

function StopCard({
  s,
  position,
  manage,
  first,
  last,
  onUp,
  onDown,
  onOpenPickup,
}: {
  s: LogisticsRouteStopDto;
  position: number;
  manage: boolean;
  first: boolean;
  last: boolean;
  onUp: () => void;
  onDown: () => void;
  onOpenPickup: () => void;
}) {
  const j = s.job;
  const a = j.address;
  return (
    <Card className="flex gap-3 p-4 sm:gap-4 sm:p-5">
      <div
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-700 text-lg font-bold text-white"
        aria-label={`Parada ${position}`}
      >
        {position}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={j.kind === 'ENTREGA' ? 'brand' : 'bronze'}>
            {j.kind === 'ENTREGA' ? 'Entrega' : 'Retirada'}
          </Badge>
          {j.kind === 'ENTREGA' ? (
            <Link
              href={`/painel/entregas/${j.id}`}
              className="font-mono text-sm font-semibold text-brand-700 hover:underline"
            >
              {j.code}
            </Link>
          ) : (
            <button
              type="button"
              onClick={onOpenPickup}
              className="font-mono text-sm font-semibold text-brand-700 hover:underline"
            >
              {j.code}
            </button>
          )}
          <span className="text-sm font-semibold" data-testid="stop-arrival">
            {arrivalText(j.windowStart, j.windowEnd)}
          </span>
          <Badge tone={s.confirmed ? 'neutral' : 'warn'}>{statusLabel(s)}</Badge>
          {!s.confirmed && <Badge tone="warn">Não confirmada</Badge>}
        </div>
        <p className="font-medium">{j.customerName}</p>
        {a && (
          <p className="flex items-start gap-1.5 text-sm text-ink-soft">
            <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              {a.street}, {a.number}
              {a.complement ? ` — ${a.complement}` : ''} · {a.district ? `${a.district}, ` : ''}
              {a.city}/{a.state}
            </span>
          </p>
        )}
        <p className="text-sm text-ink-muted">
          {s.serviceOrders.length ? `OS: ${s.serviceOrders.join(', ')} · ` : ''}
          {PICKUP_TEAM_LABEL[s.team]}
          {s.responsible ? ` · responsável ${s.responsible.displayName}` : ' · sem responsável'}
          {s.participants.length
            ? ` · equipe: ${s.participants.map((p) => p.displayName).join(', ')}`
            : ''}
        </p>
        {j.instructions && (
          <p className="rounded-lg bg-warn-50 px-3 py-1.5 text-sm text-warn-600">
            {j.instructions}
          </p>
        )}
        {s.conflicts.map((c) => (
          <p key={c} className="flex items-start gap-1.5 text-sm text-danger-600" role="note">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {c}
          </p>
        ))}
      </div>
      {manage && (
        <div className="flex shrink-0 flex-col gap-2">
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Mover ${j.code} para cima`}
            disabled={first}
            onClick={onUp}
            icon={<ArrowUp className="size-4" aria-hidden />}
          />
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Mover ${j.code} para baixo`}
            disabled={last}
            onClick={onDown}
            icon={<ArrowDown className="size-4" aria-hidden />}
          />
        </div>
      )}
    </Card>
  );
}
