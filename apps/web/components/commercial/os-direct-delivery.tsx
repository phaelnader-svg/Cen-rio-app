'use client';

import type { DirectDeliveryResultDto } from '@cenario/shared';
import { PackageCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { Alert, Badge, Spinner } from '@/components/ui/misc';
import { formatDateTime } from '@/lib/format';
import { useCan, useModules } from '@/lib/hooks';
import { useAction, useDirectDelivery } from '@/lib/simple-materials';
import { RevertDirectDelivery } from './revert-direct-delivery';

/**
 * Reformulação, Fase 1 — "Marcar como entregue" direto na OS.
 * Mesmas exigências da logística (qualidade aprovada, embalagem, sem correção aberta); grava a
 * entrega como "confirmação direta pela OS", sem viagem. Fase 3 (D5): a última entrega direta pode
 * ser desfeita, com prévia e justificativa, por quem tem entregas.gerenciar E financeiro.gerenciar.
 */
export function OsDirectDelivery({ serviceOrderId }: { serviceOrderId: string }) {
  const can = useCan();
  const modules = useModules();
  const q = useDirectDelivery(serviceOrderId);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState('');
  const act = useAction<DirectDeliveryResultDto>(
    [['direct-delivery', serviceOrderId], ['pieces'], ['service-order'], ['deliveries'], ['fin']],
    'OS marcada como entregue.',
  );
  const canDeliver = can('entregas.gerenciar');
  const canRevert = can('entregas.gerenciar') && can('financeiro.gerenciar');
  const logisticsOn = modules.logistica;

  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const e = q.data;
  const last = e.lastDelivery;

  return (
    <section
      className="space-y-4 rounded-xl border border-line p-4"
      data-testid="os-direct-delivery"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">Entrega ao cliente</h3>
        {e.delivered ? (
          <Badge tone="ok" dot>
            Entregue
          </Badge>
        ) : e.eligible ? (
          <Badge tone="info" dot>
            Pronta para entregar
          </Badge>
        ) : (
          <Badge tone="neutral">Ainda não pode ser entregue</Badge>
        )}
      </header>

      {last && (
        <p className="text-sm" data-testid="os-direct-delivery-last">
          {last.origin === 'DIRETA' ? 'Confirmada diretamente pela OS' : 'Entregue pela logística'}
          {last.completedAt && ` em ${formatDateTime(last.completedAt)}`}
          {last.confirmedBy && ` por ${last.confirmedBy.displayName}`} ·{' '}
          <Link className="text-brand-700 hover:underline" href={`/painel/entregas/${last.id}`}>
            {last.code}
          </Link>
        </p>
      )}
      {e.delivered && last?.origin === 'DIRETA' && canRevert && (
        <RevertDirectDelivery serviceOrderId={serviceOrderId} />
      )}
      {e.lastReverted && (
        <p className="text-sm text-ink-muted" data-testid="os-direct-delivery-reverted">
          Entrega {e.lastReverted.code} desfeita em {formatDateTime(e.lastReverted.revertedAt)}
          {e.lastReverted.revertedBy ? ` por ${e.lastReverted.revertedBy}` : ''} —{' '}
          {e.lastReverted.reason}
        </p>
      )}

      {!e.delivered && e.blocks.length > 0 && (
        <Alert tone="warn" title="O que falta para entregar">
          <ul className="list-disc space-y-0.5 pl-4" data-testid="os-direct-delivery-blocks">
            {e.blocks.map((b) => (
              <li key={b.itemId}>
                <span className="font-mono font-semibold">{b.code}</span>: {b.reasons.join('; ')}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      {!e.delivered && logisticsOn && (
        <p className="text-xs text-ink-muted">
          A logística está ligada: a entrega também pode ser programada por lá. Use a confirmação
          direta quando o cliente já recebeu ou retirou as peças.
        </p>
      )}

      {act.error && <Alert tone="danger">{act.error}</Alert>}

      {canDeliver && e.eligible && !confirming && (
        <Button
          icon={<PackageCheck className="size-4" aria-hidden />}
          onClick={() => setConfirming(true)}
          data-testid="os-direct-delivery-start"
        >
          Marcar como entregue
        </Button>
      )}
      {canDeliver && e.eligible && confirming && (
        <div className="space-y-3 rounded-lg bg-subtle p-3">
          <p className="text-sm">
            Confirma a entrega de <strong>{e.pendingItems.map((p) => p.code).join(', ')}</strong> ao
            cliente? A cobrança com vencimento na entrega passa a vencer conforme a regra combinada.
            Desfazer depois só é possível em até 7 dias, com justificativa e sem pagamentos ligados
            a ela.
          </p>
          <Textarea
            aria-label="Observação (opcional)"
            placeholder="Observação (opcional): quem recebeu, onde…"
            value={note}
            onChange={(ev) => setNote(ev.target.value)}
            rows={2}
          />
          <div className="flex gap-2">
            <Button
              loading={act.isPending}
              onClick={() =>
                act.mutate(
                  {
                    path: `/api/v1/service-orders/${serviceOrderId}/deliver`,
                    body: note.trim() ? { note: note.trim() } : {},
                  },
                  { onSuccess: () => setConfirming(false) },
                )
              }
              data-testid="os-direct-delivery-confirm"
            >
              Confirmar entrega
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Voltar
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
