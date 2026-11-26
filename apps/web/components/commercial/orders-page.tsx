'use client';

import clsx from 'clsx';
import { ORDER_STATUSES, ORDER_STATUS_LABEL } from '@cenario/shared';
import type { OrderSummaryDto } from '@cenario/shared';
import { ClipboardPlus, FileSignature, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useDeferredValue, useState } from 'react';
import { Input, Select } from '@/components/ui/field';
import { Alert, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { ExportLink } from '@/components/ui/export-link';
import { buttonClass } from '@/components/ui/button-styles';
import { formatDay, useOrders } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import { OrderStatusBadge, ReworkBadge, ServiceStateBadge } from './badges';
import { MarkArrivedButton } from './order-detail';

export function OrdersPage() {
  const can = useCan();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  // Fluxo da OS (2026-11-18): o pedido que virou OS sai da lista principal (vai para Ordens de
  // serviço); "Já viraram OS" e "Todos" continuam a um clique.
  const [stage, setStage] = useState('SEM_OS');
  const orders = useOrders({ q: useDeferredValue(q), status, stage });
  return (
    <>
      <PageHeader
        title="Pedidos"
        description="Serviços fechados, da retirada até virar ordem de serviço."
        help="O pedido nasce quando o cliente aprova o orçamento e você fecha o serviço. Daqui você agenda a retirada da peça e, quando ela chega, gera a OS para a oficina."
        actions={
          <>
            <ExportLink href="/api/v1/export/pedidos.csv" testId="export-pedidos" />
            {/* Revisão geral (item 4): o pedido nasce do orçamento aprovado ("Fechar serviço"). */}
            {can('orcamentos.gerenciar') && (
              <Link
                href="/painel/orcamentos"
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-700 px-4 text-[15px] font-semibold text-white hover:bg-brand-800"
              >
                <Plus className="size-4" aria-hidden /> Novo orçamento
              </Link>
            )}
          </>
        }
      />
      <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-[1fr_200px_220px]">
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
        <Select
          aria-label="Etapa"
          value={stage}
          onChange={(e) => setStage(e.target.value)}
          data-testid="orders-stage"
        >
          <option value="SEM_OS">Aguardando OS</option>
          <option value="COM_OS">Já viraram OS</option>
          <option value="">Todos</option>
        </Select>
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
              <li
                key={o.id}
                className={clsx(
                  'flex flex-col sm:flex-row sm:items-center',
                  o.rework && 'border-l-4 border-l-danger-600 bg-danger-50/40',
                )}
              >
                <Link
                  href={`/painel/pedidos/${o.id}`}
                  // Melhoria 160: no celular, cartão com o cliente em cima e os selos embaixo.
                  className="flex min-w-0 flex-1 flex-col gap-1.5 px-5 py-3.5 hover:bg-subtle/70 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:gap-y-1"
                  data-testid={`order-${o.code}`}
                >
                  <span className="font-mono text-xs font-semibold text-ink-muted sm:w-24 sm:text-sm sm:text-ink">
                    {o.code}
                  </span>
                  <div className="min-w-0 sm:min-w-[12rem] sm:flex-1">
                    <p className="truncate font-medium">{o.customer.name}</p>
                    <p className="truncate text-sm text-ink-muted">{o.contractedService}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:contents">
                    <span className="text-sm text-ink-muted tabular-nums">
                      {o.onSite
                        ? `${o.totalPieces} ${o.totalPieces === 1 ? 'peça' : 'peças'} no local`
                        : `${o.receivedPieces}/${o.totalPieces} peças na oficina`}
                      {o.nextPickup?.scheduledDate && o.receivedPieces < o.totalPieces
                        ? ` · ${o.nextPickup.kind === 'NO_LOCAL' ? 'no local' : 'retirada'} ${formatDay(o.nextPickup.scheduledDate)}${o.nextPickup.windowStart ? ` ${o.nextPickup.windowStart}` : ''}`
                        : ''}
                    </span>
                    <ReworkBadge rework={o.rework} />
                    <OrderStatusBadge
                      status={o.status}
                      customerDropOff={o.customerDropOff}
                      onSite={o.onSite}
                    />
                    <ServiceStateBadge state={o.serviceState} returned={o.returnedPieces} />
                  </div>
                  <span className="hidden w-32 text-right text-xs text-ink-muted md:block">
                    {formatDateTime(o.createdAt)}
                  </span>
                </Link>
                <OrderQuickAction order={o} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

/**
 * Fluxo da OS (2026-11-18): o próximo passo do pedido num botão — "Peça chegou" enquanto a peça
 * não chegou; "Gerar OS" quando ela está na tapeçaria; "Ver OS" depois.
 */
function OrderQuickAction({ order: o }: { order: OrderSummaryDto }) {
  const can = useCan();
  if (o.status === 'CANCELADO') return null;
  const arrived = o.receivedPieces > 0;
  const missing = o.receivedPieces < o.totalPieces - o.returnedPieces;
  let action: React.ReactNode = null;
  if (o.serviceOrderCount > 0) {
    if (can('os.ver'))
      action = (
        <Link
          href={`/painel/os?pedido=${o.id}`}
          className={buttonClass('secondary', 'sm')}
          data-testid={`order-see-os-${o.code}`}
        >
          Ver OS
        </Link>
      );
  } else if (arrived && can('os.gerenciar')) {
    action = (
      <Link
        href={`/painel/os/nova?pedido=${o.id}`}
        className={buttonClass('primary', 'sm')}
        data-testid={`order-generate-os-${o.code}`}
      >
        <ClipboardPlus className="size-4" aria-hidden /> Gerar OS
      </Link>
    );
  } else if (missing && can('pedidos.gerenciar')) {
    action = <MarkArrivedButton order={o} size="sm" />;
  }
  if (!action) return null;
  return <div className="shrink-0 px-5 pb-3.5 sm:py-3.5 sm:pl-0">{action}</div>;
}
