'use client';

import {
  DRAFT_STALE_DAYS,
  PURCHASE_ORDER_STATUSES,
  PURCHASE_ORDER_STATUS_LABEL,
  RECEIVING_SITUATIONS,
  RECEIVING_SITUATION_LABEL,
  formatCents,
} from '@cenario/shared';
import { Search, ShoppingCart } from 'lucide-react';
import Link from 'next/link';
import { useDeferredValue, useState } from 'react';
import { Input, Select } from '@/components/ui/field';
import { Alert, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { formatDay } from '@/lib/commercial';
import { usePurchaseOrders, useReceiving, useShortages } from '@/lib/purchasing';
import { PurchaseStatusBadge } from './badges';
import { ShortagesTab } from './shortages-tab';

/** Central de compras: necessidades aprovadas (Fase 3) → pedidos de compra. */
export function PurchasingPage() {
  const [tab, setTab] = useState('necessidades');
  const needs = useShortages();
  return (
    <>
      <PageHeader
        title="Compras"
        description="Materiais aprovados para compra, pedidos aos fornecedores e situação de cada compra. Tecidos são sempre comprados por OS."
        actions={
          <Link
            href="/painel/fornecedores"
            className="text-sm font-medium text-brand-700 hover:underline"
          >
            Fornecedores →
          </Link>
        }
      />
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'necessidades', label: 'A comprar', count: needs.data?.length },
          { key: 'pedidos', label: 'Pedidos de compra' },
          { key: 'recebimentos', label: 'Recebimentos' },
        ]}
      >
        {tab === 'necessidades' ? (
          <ShortagesTab />
        ) : tab === 'recebimentos' ? (
          <ReceivingTab />
        ) : (
          <OrdersTab />
        )}
      </Tabs>
    </>
  );
}

function OrdersTab() {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const list = usePurchaseOrders({ status, q: useDeferredValue(q) });
  return (
    <>
      <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-[1fr_240px]">
        <label className="relative">
          <span className="sr-only">Pesquisar pedido</span>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted"
            aria-hidden
          />
          <Input
            className="pl-9"
            placeholder="CP-00001 ou fornecedor"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <Select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todas as situações</option>
          {PURCHASE_ORDER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {PURCHASE_ORDER_STATUS_LABEL[s]}
            </option>
          ))}
        </Select>
      </Card>
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{list.error.message}</Alert>
      ) : list.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ShoppingCart className="size-6" aria-hidden />}
            title="Nenhum pedido de compra"
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line" data-testid="purchase-orders">
            {list.data.map((po) => (
              <li key={po.id}>
                <Link
                  href={`/painel/compras/${po.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5 hover:bg-subtle/70"
                  data-testid={`po-${po.code}`}
                >
                  <span className="w-20 font-mono text-sm font-semibold">{po.code}</span>
                  <div className="min-w-0 flex-1 basis-[calc(100%-6rem)] sm:basis-0">
                    <p className="truncate font-medium">
                      {po.supplier?.name ?? 'Fornecedor a definir'}
                    </p>
                    <p className="text-sm text-ink-muted">
                      {po.itemCount} item(ns) ·{' '}
                      {po.serviceOrders.map((s) => s.code).join(', ') || 'estoque'}
                      {po.expectedDate ? ` · previsto ${formatDay(po.expectedDate)}` : ''}
                    </p>
                  </div>
                  {po.totalCents !== null && (
                    <span className="font-semibold tabular-nums">{formatCents(po.totalCents)}</span>
                  )}
                  {po.draftDays !== null && (
                    <span
                      className={`text-sm ${po.draftDays >= DRAFT_STALE_DAYS ? 'font-semibold text-warn-600' : 'text-ink-muted'}`}
                      data-testid={`po-draft-age-${po.code}`}
                    >
                      {po.draftDays === 0
                        ? 'Rascunho de hoje'
                        : `Em rascunho há ${po.draftDays} dia${po.draftDays === 1 ? '' : 's'}`}
                    </span>
                  )}
                  {po.hasIssues && (
                    <span className="text-sm font-semibold text-danger-600">Recusa a decidir</span>
                  )}
                  {po.withoutDestination.length > 0 && (
                    <span className="text-sm font-semibold text-warn-600">
                      Sem destino ({po.withoutDestination.map((x) => x.code).join(', ')} cancelada)
                    </span>
                  )}
                  <PurchaseStatusBadge status={po.status} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

/**
 * Rodada 3 (F6-03): fila "Recebimentos" — aguardando entrega, parcialmente recebido, aguardando
 * conferência, recebido, conferido e cancelado (derivados do pedido e das chegadas; sem preços).
 */
function ReceivingTab() {
  const [situation, setSituation] = useState('');
  const list = useReceiving(situation);
  return (
    <>
      <Card className="mb-4 grid gap-3 p-4 sm:grid-cols-[240px]">
        <Select
          aria-label="Situação do recebimento"
          data-testid="receiving-situation"
          value={situation}
          onChange={(e) => setSituation(e.target.value)}
        >
          <option value="">Todas as situações</option>
          {RECEIVING_SITUATIONS.map((s) => (
            <option key={s} value={s}>
              {RECEIVING_SITUATION_LABEL[s]}
            </option>
          ))}
        </Select>
      </Card>
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{list.error.message}</Alert>
      ) : list.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ShoppingCart className="size-6" aria-hidden />}
            title="Nenhum recebimento nesta situação"
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line" data-testid="receiving-list">
            {list.data.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/painel/compras/${r.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5 hover:bg-subtle/70"
                  data-testid={`receiving-${r.code}`}
                >
                  <span className="w-20 font-mono text-sm font-semibold">{r.code}</span>
                  <div className="min-w-0 flex-1 basis-[calc(100%-6rem)] sm:basis-0">
                    <p className="truncate font-medium">{r.supplier ?? 'Fornecedor a definir'}</p>
                    <p className="text-sm text-ink-muted">
                      {r.pendingItems
                        ? `${r.pendingItems} de ${r.itemCount} item(ns) com saldo a receber`
                        : `${r.itemCount} item(ns) recebidos`}
                      {r.pendingConference
                        ? ` · ${r.pendingConference} chegada(s) aguardando conferência`
                        : ''}
                      {r.receipts.length ? ` · último: ${r.receipts[0]!.code}` : ''}
                      {r.expectedDate ? ` · previsto ${formatDay(r.expectedDate)}` : ''}
                    </p>
                  </div>
                  <span
                    className="text-sm font-semibold"
                    data-testid={`receiving-situation-${r.code}`}
                  >
                    {RECEIVING_SITUATION_LABEL[r.situation]}
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
