'use client';

import { SERVICE_ORDER_STATUSES, SERVICE_ORDER_STATUS_LABEL } from '@cenario/shared';
import { ClipboardList, Search } from 'lucide-react';
import Link from 'next/link';
import { useDeferredValue, useState } from 'react';
import { Input, Select } from '@/components/ui/field';
import { Alert, Avatar, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { formatDay, useServiceOrders } from '@/lib/commercial';
import { PriorityBadge, ServiceOrderStatusBadge } from './badges';

export function ServiceOrdersPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('ABERTA');
  const list = useServiceOrders({ q: useDeferredValue(q), status });
  return (
    <>
      <PageHeader
        title="Ordens de serviço"
        description="OS técnicas criadas a partir das peças recebidas. Para criar uma OS, abra o pedido após o recebimento."
      />
      <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-[1fr_220px]">
        <label className="relative">
          <span className="sr-only">Pesquisar OS</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted"
            aria-hidden
          />
          <Input
            className="pl-9"
            placeholder="Número (OS-00001), cliente ou peça"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <Select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todas</option>
          {SERVICE_ORDER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {SERVICE_ORDER_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
      </Card>
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{list.error.message}</Alert>
      ) : list.data.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ClipboardList className="size-6" aria-hidden />}
            title="Nenhuma OS encontrada"
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {list.data.items.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/painel/os/${s.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5 hover:bg-subtle/70"
                  data-testid={`so-${s.code}`}
                >
                  <span className="w-24 font-mono text-sm font-semibold">{s.code}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{s.customer.name}</p>
                    <p className="text-sm text-ink-muted">
                      Pedido {s.order.code} · {s.pieceCount} peça(s) em {s.itemCount} item(ns)
                      {s.promisedDate ? ` · prazo ${formatDay(s.promisedDate, true)}` : ''}
                    </p>
                  </div>
                  {s.technicalLead && (
                    <span className="flex items-center gap-1.5 text-sm text-ink-soft">
                      <Avatar
                        name={s.technicalLead.displayName}
                        color={s.technicalLead.color}
                        photoUrl={s.technicalLead.photoUrl}
                        size={22}
                      />
                      {s.technicalLead.displayName}
                    </span>
                  )}
                  <PriorityBadge priority={s.priority} />
                  <ServiceOrderStatusBadge status={s.status} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
