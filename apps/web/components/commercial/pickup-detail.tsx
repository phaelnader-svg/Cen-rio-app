'use client';

import type { PickupDto, PickupStatus } from '@cenario/shared';
import { PICKUP_STATUS_LABEL, PICKUP_TEAM_LABEL, formatPhone } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { formatDay, useOrder, usePickup } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import { addressLines } from './address-form';
import { PickupStatusBadge } from './badges';
import { PhotoGallery } from './photo-gallery';
import { PickupForm } from './pickup-form';
import { Detail } from './section';

const ACTION_LABEL: Partial<Record<PickupStatus, string>> = {
  AGENDADA: 'Marcar como agendada',
  EM_EXECUCAO: 'Equipe a caminho / em execução',
  RETIRADA_REALIZADA: 'Confirmar retirada realizada',
  COM_OCORRENCIA: 'Registrar ocorrência',
  AGUARDANDO_AGENDAMENTO: 'Voltar para aguardando agendamento',
  CANCELADA: 'Cancelar retirada',
};

const EVENT_LABEL: Record<string, string> = {
  ...PICKUP_STATUS_LABEL,
  SOLICITADA: 'Retirada solicitada',
  REAGENDADA: 'Reagendada',
  AGENDA_REMOVIDA: 'Data removida',
  DADOS_ALTERADOS: 'Dados alterados',
};

export function PickupDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const can = useCan();
  const pickup = usePickup(id);
  const order = useOrder(pickup.data && can('pedidos.ver') ? pickup.data.order.id : null);
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState<PickupStatus | null>(null);
  const manage = can('retiradas.gerenciar');

  if (editing && pickup.data && order.data) {
    return <PickupForm order={order.data} pickup={pickup.data} onClose={() => setEditing(false)} />;
  }

  const p = pickup.data;
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={p ? `Retirada ${p.code}` : 'Retirada'}
      description={p ? `${p.customer.name} · pedido ${p.order.code}` : undefined}
    >
      {!p ? (
        pickup.isError ? (
          <Alert tone="danger">{pickup.error.message}</Alert>
        ) : (
          <Spinner />
        )
      ) : (
        <div className="space-y-5" data-testid="pickup-detail">
          <div className="flex flex-wrap items-center gap-2">
            <PickupStatusBadge status={p.status} />
            {manage &&
              ['AGUARDANDO_AGENDAMENTO', 'AGENDADA', 'COM_OCORRENCIA'].includes(p.status) &&
              order.data && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Pencil className="size-3.5" aria-hidden />}
                  onClick={() => setEditing(true)}
                >
                  Editar / reagendar
                </Button>
              )}
            {can('recebimentos.registrar') &&
              ['AGENDADA', 'EM_EXECUCAO', 'RETIRADA_REALIZADA', 'COM_OCORRENCIA'].includes(
                p.status,
              ) && (
                <Link
                  href={`/painel/recebimentos/novo?pedido=${p.order.id}&retirada=${p.id}`}
                  className="inline-flex h-8 items-center rounded-lg bg-brand-700 px-3 text-sm font-semibold text-white hover:bg-brand-800"
                >
                  Registrar recebimento na oficina
                </Link>
              )}
          </div>
          {manage && p.allowedTransitions.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label="Registrar andamento">
              {p.allowedTransitions.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={
                    s === 'CANCELADA' || s === 'COM_OCORRENCIA' ? 'outline-danger' : 'secondary'
                  }
                  onClick={() => setTarget(s)}
                >
                  {ACTION_LABEL[s] ?? PICKUP_STATUS_LABEL[s]}
                </Button>
              ))}
            </div>
          )}
          <dl className="grid gap-4 sm:grid-cols-2">
            <Detail label="Data e janela">
              {p.scheduledDate
                ? `${formatDay(p.scheduledDate, true)}${p.windowStart ? `, ${p.windowStart}–${p.windowEnd ?? ''}` : ''}`
                : 'Aguardando agendamento'}
            </Detail>
            <Detail label="Equipe">{`${PICKUP_TEAM_LABEL[p.team]}${p.teamNotes ? ` · ${p.teamNotes}` : ''}`}</Detail>
            <Detail label="Endereço">
              {p.address
                ? `${p.address.label}\n${addressLines(p.address)}${p.address.reference ? `\nRef.: ${p.address.reference}` : ''}`
                : null}
            </Detail>
            <Detail label="Contato">
              {[formatPhone(p.customer.whatsapp), formatPhone(p.customer.phone)]
                .filter(Boolean)
                .join(' · ')}
            </Detail>
            <Detail label="Peças">
              {p.items.map((i) => `${i.quantity}× ${i.description}`).join('\n')}
            </Detail>
            <Detail label="Instruções">{p.instructions}</Detail>
            {p.externalReference && (
              <Detail label="Referência externa">{p.externalReference}</Detail>
            )}
          </dl>
          <div>
            <h3 className="mb-2 text-sm font-semibold">Linha do tempo</h3>
            <ol className="space-y-2 border-l-2 border-line pl-4" data-testid="pickup-timeline">
              {p.events.map((e) => (
                <li key={e.id} className="text-sm">
                  <p className="font-medium">{EVENT_LABEL[e.kind] ?? e.kind}</p>
                  {e.note && <p className="text-ink-soft">{e.note}</p>}
                  <p className="text-xs text-ink-muted">
                    {formatDateTime(e.occurredAt)} · {e.recordedBy ?? 'Sistema'}
                    {e.source !== 'MANUAL' ? ' · automático' : ''}
                  </p>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold">Fotografias</h3>
            <PhotoGallery entityType="PICKUP" entityId={p.id} canManage={manage} />
          </div>
        </div>
      )}
      {target && p && (
        <TransitionDialog pickup={p} target={target} onClose={() => setTarget(null)} />
      )}
    </Dialog>
  );
}

function TransitionDialog({
  pickup,
  target,
  onClose,
}: {
  pickup: PickupDto;
  target: PickupStatus;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const needsNote = target === 'COM_OCORRENCIA' || target === 'CANCELADA';
  const m = useMutation({
    mutationFn: () =>
      api<PickupDto>(`/api/v1/pickups/${pickup.id}/transition`, {
        method: 'POST',
        body: { toStatus: target, note: note || null, version: pickup.version },
      }),
    onSuccess: (p) => {
      qc.setQueryData(['pickup', p.id], p);
      void qc.invalidateQueries({ queryKey: ['pickups'] });
      toast('ok', `Retirada ${p.code}: ${PICKUP_STATUS_LABEL[p.status]}.`);
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={ACTION_LABEL[target] ?? PICKUP_STATUS_LABEL[target]}
      description={`${PICKUP_STATUS_LABEL[pickup.status]} → ${PICKUP_STATUS_LABEL[target]}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            variant={needsNote ? 'danger' : 'primary'}
            loading={m.isPending}
            disabled={needsNote && !note.trim()}
            onClick={() => m.mutate()}
          >
            Confirmar
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <Field label={needsNote ? 'Motivo / descrição (obrigatório)' : 'Observação (opcional)'}>
        {(p) => (
          <Textarea
            {...p}
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            autoFocus
          />
        )}
      </Field>
      <p className="mt-2 text-xs text-ink-muted">
        Registro manual da confirmação (a integração com a logística virá em fase futura).
      </p>
    </Dialog>
  );
}
