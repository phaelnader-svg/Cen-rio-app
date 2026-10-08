'use client';

import { RECEIPT_ORIGIN_LABEL } from '@cenario/shared';
import { PackageCheck } from 'lucide-react';
import Link from 'next/link';
import { Alert, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { usePendingReceipts, useReceipts } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import { ReceiptCorrectionButton } from '@/components/quality/returns-page';
import { OrderStatusBadge } from './badges';
import type { OrderStatus } from '@cenario/shared';

export function ReceiptsPage() {
  const can = useCan();
  const register = can('recebimentos.registrar');
  const pending = usePendingReceipts(register);
  const receipts = useReceipts(undefined);
  return (
    <>
      <PageHeader
        title="Recebimentos"
        description="Chegada física das peças à oficina. Somente após o recebimento a OS técnica pode ser criada."
      />
      {register && (
        <Card className="mb-6 overflow-hidden">
          <h2 className="border-b border-line px-5 py-3.5 font-semibold">Aguardando chegada</h2>
          {pending.isPending ? (
            <Spinner className="p-5" />
          ) : pending.isError ? (
            <Alert tone="danger" className="m-4">
              {pending.error.message}
            </Alert>
          ) : pending.data.length === 0 ? (
            <EmptyState title="Nenhuma peça aguardando chegada" />
          ) : (
            <ul className="divide-y divide-line">
              {pending.data.map((o) => (
                <li
                  key={o.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5"
                  data-testid={`pending-${o.code}`}
                >
                  <span className="w-24 font-mono text-sm font-semibold">{o.code}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{o.customer.name}</p>
                    <p className="text-sm text-ink-muted">
                      {o.items
                        .filter((i) => i.pending > 0)
                        .map((i) => `${i.pending}× ${i.description}`)
                        .join(' · ')}
                    </p>
                  </div>
                  <OrderStatusBadge status={o.status as OrderStatus} />
                  <Link
                    href={`/painel/recebimentos/novo?pedido=${o.id}${o.pickups[0] ? `&retirada=${o.pickups[0].id}` : ''}`}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-700 px-3 text-sm font-semibold text-white hover:bg-brand-800"
                  >
                    <PackageCheck className="size-3.5" aria-hidden /> Registrar chegada
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      <Card className="overflow-hidden">
        <h2 className="border-b border-line px-5 py-3.5 font-semibold">Recebimentos registrados</h2>
        {receipts.isPending ? (
          <Spinner className="p-5" />
        ) : receipts.isError ? (
          <Alert tone="danger" className="m-4">
            {receipts.error.message}
          </Alert>
        ) : receipts.data.length === 0 ? (
          <EmptyState title="Nenhum recebimento registrado" />
        ) : (
          <ul className="divide-y divide-line" data-testid="receipts-list">
            {receipts.data.map((r) => (
              <li key={r.id} className="px-5 py-3.5 text-sm">
                <p className="flex flex-wrap items-center gap-x-3">
                  <span className="font-mono font-semibold">{r.code}</span>
                  {can('pedidos.ver') ? (
                    <Link
                      href={`/painel/pedidos/${r.order.id}`}
                      className="text-brand-700 hover:underline"
                    >
                      {r.order.code}
                    </Link>
                  ) : (
                    <span>{r.order.code}</span>
                  )}
                  <span className="font-medium">{r.customer.name}</span>
                  <span className="text-ink-muted">
                    {formatDateTime(r.receivedAt)} · {RECEIPT_ORIGIN_LABEL[r.origin]}
                    {r.pickup ? ` (${r.pickup.code})` : ''}
                  </span>
                </p>
                <p className="mt-0.5 text-ink-muted">
                  {r.lines
                    .map(
                      (l) =>
                        `${l.quantity}× ${l.description} → ${l.location}${l.correctedQuantity !== null ? ` (corrigido para ${l.correctedQuantity})` : ''}`,
                    )
                    .join(' · ')}
                  {r.receivedBy ? ` · ${r.receivedBy.displayName}` : ''}
                </p>
                {can('devolucoes.gerenciar') && (
                  <div className="mt-1 flex flex-wrap gap-2">
                    {r.lines.map((l) => (
                      <span key={l.id} className="inline-flex items-center gap-1 text-ink-muted">
                        {l.description}: <ReceiptCorrectionButton line={l} />
                      </span>
                    ))}
                  </div>
                )}
                {r.divergences && <p className="text-warn-600">Divergências: {r.divergences}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
