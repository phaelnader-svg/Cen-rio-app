'use client';

import {
  MATERIAL_SOURCING_LABEL,
  PURCHASE_ORDER_STATUSES,
  PURCHASE_ORDER_STATUS_LABEL,
  formatCents,
} from '@cenario/shared';
import { PackageSearch, Search, ShoppingCart } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDeferredValue, useState } from 'react';
import { PriorityBadge } from '@/components/commercial/badges';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select } from '@/components/ui/field';
import { Alert, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { formatDay } from '@/lib/commercial';
import { useCan } from '@/lib/hooks';
import { useNeeds, usePurchaseOrders } from '@/lib/purchasing';
import { PurchaseStatusBadge, StageBadge } from './badges';
import { qtyText, specText } from './format';

/** Central de compras: necessidades aprovadas (Fase 3) → pedidos de compra. */
export function PurchasingPage() {
  const [tab, setTab] = useState('necessidades');
  const needs = useNeeds(true);
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
        ]}
      >
        {tab === 'necessidades' ? <NeedsTab /> : <OrdersTab />}
      </Tabs>
    </>
  );
}

function NeedsTab() {
  const can = useCan();
  const router = useRouter();
  const [all, setAll] = useState(false);
  const needs = useNeeds(!all);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  if (needs.isPending) return <Spinner />;
  if (needs.isError) return <Alert tone="danger">{needs.error.message}</Alert>;
  const canBuy = can('compras.gerenciar');
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Checkbox
          label="Mostrar também o que já está em compra"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
        />
        <span className="flex-1" />
        {canBuy && (
          <Button
            icon={<ShoppingCart className="size-4" aria-hidden />}
            disabled={selected.size === 0}
            onClick={() => router.push(`/painel/compras/novo?req=${[...selected].join(',')}`)}
          >
            Criar pedido de compra ({selected.size})
          </Button>
        )}
      </div>
      {needs.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<PackageSearch className="size-6" aria-hidden />}
            title="Nada pendente de compra"
            description="Materiais aparecem aqui quando o gestor aprova as solicitações das medições."
          />
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="data-table min-w-[980px]" data-testid="needs">
            <thead>
              <tr>
                {canBuy && <th className="w-10" />}
                <th>OS / cliente</th>
                <th>Material</th>
                <th className="text-right">Aprovado</th>
                <th className="text-right">Em compra</th>
                <th className="text-right">A comprar</th>
                <th>Compras</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {needs.data.map((n) => (
                <tr
                  key={n.requirementId}
                  data-testid={`need-${n.serviceOrder.code}-${n.description}`}
                >
                  {canBuy && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Selecionar ${n.description} da ${n.serviceOrder.code}`}
                        className="size-5 accent-brand-700"
                        checked={selected.has(n.requirementId)}
                        disabled={n.pendingToBuy <= 0}
                        onChange={() => toggle(n.requirementId)}
                      />
                    </td>
                  )}
                  <td>
                    <Link
                      href={`/painel/os/${n.serviceOrder.id}`}
                      className="font-mono font-semibold text-brand-700 hover:underline"
                    >
                      {n.serviceOrder.code}
                    </Link>
                    <span className="block text-xs text-ink-muted">
                      {n.customerName} · prazo {formatDay(n.serviceOrder.promisedDate)}
                    </span>
                    <PriorityBadge priority={n.serviceOrder.priority} />
                  </td>
                  <td>
                    {specText(n)}
                    <span className="block text-xs text-ink-muted">
                      {n.itemCode ?? 'Toda a OS'} · {MATERIAL_SOURCING_LABEL[n.sourcing]}
                    </span>
                  </td>
                  <td className="text-right tabular-nums">{qtyText(n.need, n.unit)}</td>
                  <td className="text-right tabular-nums">
                    {qtyText(n.purchased + n.purchasedDraft, n.unit)}
                  </td>
                  <td className="text-right font-semibold tabular-nums">
                    {qtyText(n.pendingToBuy, n.unit)}
                  </td>
                  <td className="text-xs">
                    {n.purchases.map((p) => (
                      <Link
                        key={p.purchaseOrderId}
                        href={`/painel/compras/${p.purchaseOrderId}`}
                        className="block text-brand-700 hover:underline"
                      >
                        {p.code} · {p.supplierName ?? 'sem fornecedor'} ·{' '}
                        {PURCHASE_ORDER_STATUS_LABEL[p.status]}
                        {p.unitPriceCents !== null ? ` · ${formatCents(p.unitPriceCents)}/un.` : ''}
                      </Link>
                    ))}
                  </td>
                  <td>
                    <StageBadge stage={n.stage} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
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
                  {po.hasIssues && (
                    <span className="text-sm font-semibold text-danger-600">Divergência</span>
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
