'use client';

import {
  formatCents,
  type DirectDeliveryRevertPreviewDto,
  type DirectDeliveryRevertResultDto,
} from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/field';
import { Alert, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useAction } from '@/lib/simple-materials';

const day = (iso: string) => iso.split('-').reverse().join('/');

/**
 * Reformulação, Fase 3 (D5) — desfazer a última entrega direta: prévia dos efeitos (ou do que
 * impede), justificativa obrigatória e confirmação. O servidor revalida tudo na confirmação.
 */
export function RevertDirectDelivery({ serviceOrderId }: { serviceOrderId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline-danger"
        size="sm"
        icon={<Undo2 className="size-4" aria-hidden />}
        onClick={() => setOpen(true)}
        data-testid="os-direct-delivery-revert"
      >
        Desfazer entrega
      </Button>
      {open && <RevertDialog serviceOrderId={serviceOrderId} onClose={() => setOpen(false)} />}
    </>
  );
}

function RevertDialog({
  serviceOrderId,
  onClose,
}: {
  serviceOrderId: string;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ['direct-delivery-revert', serviceOrderId],
    queryFn: () =>
      api<DirectDeliveryRevertPreviewDto>(
        `/api/v1/service-orders/${serviceOrderId}/direct-delivery/revert-preview`,
      ),
  });
  const [reason, setReason] = useState('');
  const act = useAction<DirectDeliveryRevertResultDto>(
    [
      ['direct-delivery', serviceOrderId],
      ['direct-delivery-revert', serviceOrderId],
      ['pieces'],
      ['service-order'],
      ['os-state'],
      ['deliveries'],
      ['fin'],
    ],
    'Entrega desfeita.',
  );
  const p = q.data;
  const okReason = reason.trim().length >= 10;
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title="Desfazer a entrega direta?"
      description="A entrega continua no histórico, marcada como desfeita. Só a última entrega direta, em até 7 dias."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            variant="danger"
            disabled={!p?.allowed || !okReason}
            loading={act.isPending}
            onClick={() =>
              act.mutate(
                {
                  path: `/api/v1/service-orders/${serviceOrderId}/direct-delivery/revert`,
                  body: { deliveryId: p!.delivery!.id, reason: reason.trim() },
                },
                { onSuccess: onClose },
              )
            }
            data-testid="revert-confirm"
          >
            Desfazer entrega
          </Button>
        </>
      }
    >
      {act.error && (
        <Alert tone="danger" className="mb-3">
          {act.error}
        </Alert>
      )}
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : (
        p && (
          <div className="space-y-4 text-sm" data-testid="revert-preview">
            {p.delivery && (
              <p>
                <strong>{p.delivery.code}</strong> · confirmada em{' '}
                {formatDateTime(p.delivery.completedAt)}
                {p.delivery.confirmedBy ? ` por ${p.delivery.confirmedBy}` : ''} · pode ser desfeita
                até {day(p.delivery.deadline)}
              </p>
            )}
            {p.blocks.length > 0 ? (
              <Alert tone="warn" title="Não pode ser desfeita">
                <ul className="list-disc space-y-0.5 pl-4" data-testid="revert-blocks">
                  {p.blocks.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </Alert>
            ) : (
              <div className="space-y-2" data-testid="revert-effects">
                <p className="font-semibold">O que muda</p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    Peças voltam a “pronta para entrega”:{' '}
                    {p.effects.pieces.map((x) => x.code).join(', ')}
                  </li>
                  {p.effects.labor.length > 0 && (
                    <li>
                      Mão de obra “na entrega” volta a prevista:{' '}
                      {p.effects.labor
                        .map((l) => `${l.code} (${l.professional}, ${formatCents(l.agreedCents)})`)
                        .join('; ')}
                    </li>
                  )}
                  {p.effects.receivables.length > 0 && (
                    <li>
                      Cobranças voltam a “aguardando entrega”:{' '}
                      {p.effects.receivables
                        .map((r) => `${r.code} (${formatCents(r.openCents)})`)
                        .join('; ')}
                    </li>
                  )}
                  <li>
                    Prazo do serviço volta a contar
                    {p.effects.deadline.promisedDate
                      ? ` (prometido para ${day(p.effects.deadline.promisedDate)}${p.effects.deadline.overdue ? ' — ficará atrasado' : ''})`
                      : ''}
                    .
                  </li>
                </ul>
                <label className="block font-medium" htmlFor="revert-reason">
                  Justificativa (obrigatória)
                </label>
                <Textarea
                  id="revert-reason"
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                {!okReason && <p className="text-xs text-ink-muted">Mínimo de 10 caracteres.</p>}
              </div>
            )}
          </div>
        )
      )}
    </Dialog>
  );
}
