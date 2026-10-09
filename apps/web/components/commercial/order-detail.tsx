'use client';

import {
  PIECE_TYPE_LABEL,
  RECEIPT_ORIGIN_LABEL,
  cancelOrderSchema,
  formatMoney,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, ClipboardPlus, PackageCheck, Pencil, Truck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { Alert, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { formatDay, useOrder, usePickups, useReceipts, useServiceOrders } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import { addressLines } from './address-form';
import {
  OrderStatusBadge,
  PickupStatusBadge,
  ServiceOrderStatusBadge,
  ServiceStateBadge,
} from './badges';
import { PhotoGallery } from './photo-gallery';
import { PickupDetailDialog } from './pickup-detail';
import { PickupForm } from './pickup-form';
import { BackLink, Detail, Section } from './section';

const linkBtn =
  'inline-flex h-10 items-center gap-2 rounded-xl px-4 text-[15px] font-semibold transition-colors';

export function OrderDetail({ id }: { id: string }) {
  const can = useCan();
  const order = useOrder(id);
  const pickups = usePickups({ orderId: id }, can('retiradas.ver'));
  const receipts = useReceipts(id);
  const serviceOrders = useServiceOrders({ orderId: id }, can('os.ver'));
  const [requesting, setRequesting] = useState(false);
  const [openPickup, setOpenPickup] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  if (order.isPending) return <Spinner />;
  if (order.isError) return <Alert tone="danger">{order.error.message}</Alert>;
  const o = order.data;
  const active = o.status !== 'CANCELADO';
  const pendingPickup = o.items.some(
    (i) => i.quantity - i.receivedQuantity - i.inActivePickups > 0,
  );
  const pendingReceipt = o.items.some((i) => i.receivedQuantity < i.quantity);
  const availableForOs = o.items.some((i) => i.receivedQuantity - i.inServiceOrders > 0);

  return (
    <>
      <BackLink href="/painel/pedidos" label="Pedidos comerciais" />
      <PageHeader
        title={`Pedido ${o.code}`}
        description={`${o.customer.name} · criado em ${formatDateTime(o.createdAt)}${o.createdBy ? ` por ${o.createdBy}` : ''}`}
        actions={
          active && (
            <>
              {can('retiradas.gerenciar') && pendingPickup && (
                <Button
                  icon={<Truck className="size-4" aria-hidden />}
                  onClick={() => setRequesting(true)}
                >
                  Solicitar retirada
                </Button>
              )}
              {can('recebimentos.registrar') && pendingReceipt && (
                <Link
                  href={`/painel/recebimentos/novo?pedido=${o.id}`}
                  className={`${linkBtn} border border-line-strong bg-surface text-ink hover:bg-subtle`}
                >
                  <PackageCheck className="size-4" aria-hidden /> Registrar recebimento
                </Link>
              )}
              {can('os.gerenciar') && availableForOs && (
                <Link
                  href={`/painel/os/nova?pedido=${o.id}`}
                  className={`${linkBtn} border border-line-strong bg-surface text-ink hover:bg-subtle`}
                >
                  <ClipboardPlus className="size-4" aria-hidden /> Criar OS técnica
                </Link>
              )}
              {can('pedidos.gerenciar') && (
                <Link
                  href={`/painel/pedidos/${o.id}/editar`}
                  className={`${linkBtn} text-ink-soft hover:bg-subtle`}
                >
                  <Pencil className="size-4" aria-hidden /> Editar
                </Link>
              )}
              {can('pedidos.cancelar') && (
                <Button
                  variant="ghost"
                  icon={<Ban className="size-4" aria-hidden />}
                  onClick={() => setCancelling(true)}
                >
                  Cancelar pedido
                </Button>
              )}
            </>
          )
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <span data-testid="order-status">
          <OrderStatusBadge status={o.status} />
        </span>
        <span data-testid="order-service-state">
          <ServiceStateBadge state={o.serviceState} returned={o.returnedPieces} />
        </span>
        <span className="text-sm text-ink-muted">
          {o.receivedPieces} de {o.totalPieces} peça(s) na oficina
          {o.returnedPieces > 0 ? ` · ${o.returnedPieces} devolvida(s) ao cliente` : ''}
        </span>
      </div>
      {o.status === 'CANCELADO' && (
        <Alert
          tone="danger"
          className="mb-6"
          title={`Cancelado em ${formatDateTime(o.cancelledAt)}`}
        >
          {o.cancelReason}
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <Section title="Venda" className="lg:col-span-2">
          <dl className="space-y-3">
            <Detail label="Cliente">
              {can('clientes.ver') ? (
                <Link
                  href={`/painel/clientes/${o.customer.id}`}
                  className="text-brand-700 hover:underline"
                >
                  {o.customer.name}
                </Link>
              ) : (
                o.customer.name
              )}
            </Detail>
            <Detail label="Serviço contratado">{o.contractedService}</Detail>
            <Detail label="Descrição preliminar">{o.description}</Detail>
            {o.valuesVisible ? (
              <>
                <Detail label="Valor negociado">
                  <span data-testid="order-value">{formatMoney(o.agreedValueCents)}</span>
                </Detail>
                <Detail label="Condições comerciais">{o.paymentTerms}</Detail>
              </>
            ) : (
              <p className="text-sm text-ink-muted">Valores restritos.</p>
            )}
            <Detail label="Endereço da retirada">
              {o.pickupAddress
                ? `${o.pickupAddress.label}\n${addressLines(o.pickupAddress)}`
                : 'Não definido'}
            </Detail>
            <Detail label="Observações">{o.notes}</Detail>
          </dl>
        </Section>

        <Section title="Peças" className="lg:col-span-3" bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-subtle/70 text-left text-xs text-ink-muted uppercase">
                <tr>
                  <th className="px-5 py-2.5 font-semibold">Peça</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Qtd.</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Em retirada</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Recebidas</th>
                  <th className="px-5 py-2.5 text-right font-semibold">Em OS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {o.items.map((i) => (
                  <tr key={i.id}>
                    <td className="px-5 py-3">
                      <p className="font-medium">{i.description}</p>
                      <p className="text-xs text-ink-muted">
                        {PIECE_TYPE_LABEL[i.pieceType]}
                        {i.notes ? ` · ${i.notes}` : ''}
                      </p>
                    </td>
                    <td className="px-3 text-right tabular-nums">{i.quantity}</td>
                    <td className="px-3 text-right tabular-nums">{i.inActivePickups}</td>
                    <td className="px-3 text-right font-semibold tabular-nums">
                      {i.receivedQuantity}
                    </td>
                    <td className="px-5 text-right tabular-nums">{i.inServiceOrders}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {can('os.gerenciar') && active && !o.items.some((i) => i.receivedQuantity > 0) && (
            <p className="border-t border-line px-5 py-3 text-sm text-ink-muted">
              A OS técnica fica disponível após o registro do recebimento físico das peças.
            </p>
          )}
        </Section>

        {can('retiradas.ver') && (
          <Section title="Retiradas" className="lg:col-span-5" bodyClassName="p-0">
            {pickups.data?.length ? (
              <ul className="divide-y divide-line">
                {pickups.data.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="flex w-full flex-wrap items-center gap-3 px-5 py-3 text-left hover:bg-subtle/70"
                      onClick={() => setOpenPickup(p.id)}
                    >
                      <span className="font-mono text-sm font-semibold">{p.code}</span>
                      <PickupStatusBadge status={p.status} />
                      <span className="text-sm text-ink-soft">
                        {p.scheduledDate
                          ? `${formatDay(p.scheduledDate, true)}${p.windowStart ? ` ${p.windowStart}–${p.windowEnd ?? ''}` : ''}`
                          : 'Sem data'}
                      </span>
                      <span className="text-sm text-ink-muted">
                        {p.items.map((i) => `${i.quantity}× ${i.description}`).join(', ')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Nenhuma retirada solicitada" />
            )}
          </Section>
        )}

        <Section title="Recebimentos na oficina" className="lg:col-span-3" bodyClassName="p-0">
          {receipts.data?.length ? (
            <ul className="divide-y divide-line">
              {receipts.data.map((r) => (
                <li key={r.id} className="px-5 py-3 text-sm">
                  <p>
                    <span className="font-mono font-semibold">{r.code}</span> ·{' '}
                    {formatDateTime(r.receivedAt)} · {RECEIPT_ORIGIN_LABEL[r.origin]}
                    {r.pickup ? ` (${r.pickup.code})` : ''}
                  </p>
                  <p className="text-ink-muted">
                    {r.lines
                      .map((l) => `${l.quantity}× ${l.description} → ${l.location}`)
                      .join(' · ')}
                    {r.receivedBy ? ` · recebido por ${r.receivedBy.displayName}` : ''}
                  </p>
                  {r.divergences && <p className="text-warn-600">Divergências: {r.divergences}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="Nenhuma peça recebida ainda" />
          )}
        </Section>

        {can('os.ver') && (
          <Section title="Ordens de serviço" className="lg:col-span-2" bodyClassName="p-0">
            {serviceOrders.data?.items.length ? (
              <ul className="divide-y divide-line">
                {serviceOrders.data.items.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-5 py-3 text-sm">
                    <Link
                      href={`/painel/os/${s.id}`}
                      className="font-mono font-semibold text-brand-700 hover:underline"
                    >
                      {s.code}
                    </Link>
                    <ServiceOrderStatusBadge status={s.status} />
                    <span className="text-ink-muted">{s.pieceCount} peça(s)</span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Nenhuma OS" />
            )}
          </Section>
        )}

        <Section title="Fotografias" className="lg:col-span-5">
          <PhotoGallery
            entityType="COMMERCIAL_ORDER"
            entityId={o.id}
            canManage={can('pedidos.gerenciar') && active}
          />
        </Section>
      </div>

      {requesting && <PickupForm order={o} onClose={() => setRequesting(false)} />}
      {openPickup && <PickupDetailDialog id={openPickup} onClose={() => setOpenPickup(null)} />}
      {cancelling && (
        <CancelOrderDialog
          id={o.id}
          version={o.version}
          code={o.code}
          onClose={() => setCancelling(false)}
        />
      )}
    </>
  );
}

function CancelOrderDialog({
  id,
  version,
  code,
  onClose,
}: {
  id: string;
  version: number;
  code: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () =>
      api(`/api/v1/orders/${id}/cancel`, {
        method: 'POST',
        body: cancelOrderSchema.parse({ reason, version }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['order', id] });
      void qc.invalidateQueries({ queryKey: ['pickups'] });
      toast('ok', `Pedido ${code} cancelado.`);
      onClose();
    },
    onError: (e) =>
      setError(
        e instanceof Error && 'issues' in e
          ? 'Informe o motivo (mín. 3 caracteres).'
          : errorMessage(e),
      ),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Cancelar o pedido ${code}?`}
      description="Retiradas ainda ativas também serão canceladas. O registro é mantido no histórico."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button variant="danger" loading={m.isPending} onClick={() => m.mutate()}>
            Cancelar pedido
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <Field label="Motivo do cancelamento">
        {(p) => (
          <Textarea
            {...p}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
        )}
      </Field>
    </Dialog>
  );
}
