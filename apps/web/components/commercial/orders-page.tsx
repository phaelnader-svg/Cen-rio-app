'use client';

import { ORDER_STATUSES, ORDER_STATUS_LABEL } from '@cenario/shared';
import { FileSignature, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useDeferredValue, useState } from 'react';
import { Input, Select } from '@/components/ui/field';
import { Alert, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { useOrders } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import { OrderStatusBadge } from './badges';

export function OrdersPage() {
  const can = useCan();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const orders = useOrders({ q: useDeferredValue(q), status });
  return (
    <>
      <PageHeader
        title="Pedidos comerciais"
        description="Serviços aprovados pelo cliente: organizam a retirada e preservam o que foi vendido."
        actions={
          can('pedidos.gerenciar') && (
            <Link
              href="/painel/pedidos/novo"
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-700 px-4 text-[15px] font-semibold text-white hover:bg-brand-800"
            >
              <Plus className="size-4" aria-hidden /> Novo pedido
            </Link>
          )
        }
      />
      <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-[1fr_240px]">
        <label className="relative">
          <span className="sr-only">Pesquisar pedidos</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted"
            aria-hidden
          />
          <Input
            className="pl-9"
            placeholder="Número (PC-00001), cliente ou serviço"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <Select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todas as situações</option>
          {ORDER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ORDER_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
      </Card>
      {orders.isPending ? (
        <Spinner />
      ) : orders.isError ? (
        <Alert tone="danger">{orders.error.message}</Alert>
      ) : orders.data.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FileSignature className="size-6" aria-hidden />}
            title="Nenhum pedido encontrado"
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {orders.data.items.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/painel/pedidos/${o.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5 hover:bg-subtle/70"
                  data-testid={`order-${o.code}`}
                >
                  <span className="w-24 font-mono text-sm font-semibold">{o.code}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{o.customer.name}</p>
                    <p className="truncate text-sm text-ink-muted">{o.contractedService}</p>
                  </div>
                  <span className="text-sm text-ink-muted tabular-nums">
                    {o.receivedPieces}/{o.totalPieces} peças na oficina
                  </span>
                  <OrderStatusBadge status={o.status} />
                  <span className="hidden w-32 text-right text-xs text-ink-muted md:block">
                    {formatDateTime(o.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
