'use client';

import type { PickupDto, PickupStatus } from '@cenario/shared';
import {
  PICKUP_KIND_LABEL,
  PICKUP_STATUS_LABEL,
  PICKUP_TEAM_LABEL,
  formatMoney,
  formatPhone,
  pickupStatusLabel,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { formatDay, useOrder, usePickup, arrivalText } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import { addressLines } from './address-form';
import { PickupKindBadge, PickupStatusBadge } from './badges';
import { PhotoGallery } from './photo-gallery';
import { PickupForm } from './pickup-form';
import { Detail } from './section';
import { TripCostCard } from '@/components/finance/trip-cost';

const ACTION_LABEL: Partial<Record<PickupStatus, string>> = {
  AGENDADA: 'Marcar como agendada',
  EM_EXECUCAO: 'Equipe a caminho / em execução',
  RETIRADA_REALIZADA: 'Confirmar retirada realizada',
  RECEBIDA_NA_OFICINA: 'Peças chegaram na oficina',
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
  TIPO_ALTERADO: 'Retirada ↔ No local',
  NAO_ACONTECEU: 'Não aconteceu',
  RESPONSAVEL: 'Responsável',
};

/** 2026-11-25: botões do serviço "No local" (a peça não vem para a tapeçaria). */
const ON_SITE_ACTION_LABEL: Partial<Record<PickupStatus, string>> = {
  AGENDADA: 'Marcar como agendado',
  EM_EXECUCAO: 'Equipe chegou / fazendo no local',
  RETIRADA_REALIZADA: 'Serviço feito no local',
  RECEBIDA_NA_OFICINA: 'Serviço feito no local',
  CANCELADA: 'Cancelar serviço no local',
};
const actionLabel = (p: Pick<PickupDto, 'kind' | 'status'>, s: PickupStatus) =>
  // 2026-11-26: desfaz a chegada (automática ou não) quando a retirada não foi feita.
  (p.status === 'RECEBIDA_NA_OFICINA' && s === 'COM_OCORRENCIA'
    ? p.kind === 'NO_LOCAL'
      ? 'O serviço no local não aconteceu'
      : 'A retirada não aconteceu'
    : undefined) ??
  (p.kind === 'NO_LOCAL' ? ON_SITE_ACTION_LABEL[s] : undefined) ??
  ACTION_LABEL[s] ??
  pickupStatusLabel(s, p.kind);

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
      title={p ? `${PICKUP_KIND_LABEL[p.kind]} ${p.code}` : 'Agendamento'}
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
          <TripCostCard pickupId={p.id} />
          <div className="flex flex-wrap items-center gap-2">
            <PickupKindBadge kind={p.kind} />
            <PickupStatusBadge status={p.status} kind={p.kind} />
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
                  {actionLabel(p, s)}
                </Button>
              ))}
            </div>
          )}
          <dl className="grid gap-4 sm:grid-cols-2">
            <Detail label="Data e janela">
              {p.scheduledDate
                ? `${formatDay(p.scheduledDate, true)}${p.windowStart ? `, ${arrivalText(p.windowStart, p.windowEnd)}` : ''}`
                : 'Aguardando agendamento'}
            </Detail>
            <Detail label="Equipe">{`${PICKUP_TEAM_LABEL[p.team]}${p.teamNotes ? ` · ${p.teamNotes}` : ''}`}</Detail>
            <Detail label={p.kind === 'NO_LOCAL' ? 'Quem vai fazer' : 'Quem vai retirar'}>
              {[p.executor?.displayName, ...p.participants.map((x) => x.displayName)]
                .filter(Boolean)
                .filter((n, i, all) => all.indexOf(n) === i)
                .join(', ') || 'A definir'}
            </Detail>
            <Detail label="Levar ao cliente">
              {[
                p.bringSamples
                  ? `Mostruário${p.samplesDescription ? `: ${p.samplesDescription}` : ''}`
                  : null,
                p.bringCardMachine ? 'Maquininha' : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'Nada a levar'}
            </Detail>
            {p.order.agreedValueCents !== undefined && p.order.agreedValueCents !== null && (
              <Detail label="Valor do serviço">{formatMoney(p.order.agreedValueCents)}</Detail>
            )}
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
  const undo = pickup.status === 'RECEBIDA_NA_OFICINA';
  const m = useMutation({
    mutationFn: () =>
      api<PickupDto>(`/api/v1/pickups/${pickup.id}/transition`, {
        method: 'POST',
        body: { toStatus: target, note: note || null, version: pickup.version },
      }),
    onSuccess: (p) => {
      qc.setQueryData(['pickup', p.id], p);
      void qc.invalidateQueries({ queryKey: ['pickups'] });
      toast(
        'ok',
        `${PICKUP_KIND_LABEL[p.kind]} ${p.code}: ${pickupStatusLabel(p.status, p.kind)}.`,
      );
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={actionLabel(pickup, target)}
      description={
        undo
          ? pickup.kind === 'NO_LOCAL'
            ? 'O serviço volta a ficar "com ocorrência". Depois é só reagendar (ou cancelar).'
            : 'As peças saem da tapeçaria e a retirada fica "com ocorrência". Depois é só reagendar (ou cancelar).'
          : `${pickupStatusLabel(pickup.status, pickup.kind)} → ${pickupStatusLabel(target, pickup.kind)}`
      }
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
      <Field
        label={
          undo
            ? 'O que aconteceu? (obrigatório)'
            : needsNote
              ? 'Motivo / descrição (obrigatório)'
              : 'Observação (opcional)'
        }
      >
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
      {!undo && (
        <p className="mt-2 text-xs text-ink-muted">
          Registro manual da confirmação pelo gestor. A execução pela logística (saída e retirada
          realizada) é registrada pelo responsável no celular.
        </p>
      )}
    </Dialog>
  );
}
