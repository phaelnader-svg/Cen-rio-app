'use client';

import { MATERIAL_SOURCING_LABEL, formatCents } from '@cenario/shared';
import Link from 'next/link';
import { Section } from '@/components/commercial/section';
import { Alert, Spinner } from '@/components/ui/misc';
import { formatDay } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useOsReadiness } from '@/lib/purchasing';
import { PurchaseStatusBadge, ReadinessBadge, ReservationBadge, StageBadge } from './badges';
import { qtyText, specText } from './format';

/** Aba Materiais da OS: solicitações aprovadas, compras, recebimentos, reservas, pendências e prontidão. */
export function OsMaterialsOverview({ serviceOrderId }: { serviceOrderId: string }) {
  const q = useOsReadiness(serviceOrderId);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const r = q.data;
  const pending = r.lines.filter((l) => l.covered < l.need);
  return (
    <div className="space-y-6" data-testid="os-materials-overview">
      <Section title="Prontidão de materiais">
        <div className="flex flex-wrap items-center gap-3">
          <span data-testid="os-readiness-state">
            <ReadinessBadge state={r.state} />
          </span>
          <span className="text-sm text-ink-muted">
            {r.pending.openMeasurements
              ? `${r.pending.openMeasurements} medição(ões) em aberto · `
              : ''}
            {r.pending.pendingRequests
              ? `${r.pending.pendingRequests} solicitação(ões) aguardando aprovação · `
              : ''}
            {pending.length
              ? `${pending.length} material(is) pendente(s)`
              : r.lines.length
                ? 'todos os materiais disponíveis'
                : ''}
          </span>
        </div>
        <p className="mt-3 rounded-lg bg-subtle px-3 py-2 text-xs text-ink-soft">
          Materiais disponíveis não autorizam o início da produção: a liberação depende da
          programação (fase futura).
        </p>
      </Section>

      <Section title="Materiais aprovados" bodyClassName="p-0">
        {r.lines.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-muted">
            Nenhuma solicitação aprovada para esta OS.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[760px]" data-testid="os-material-lines">
              <thead>
                <tr>
                  <th>Material</th>
                  <th className="text-right">Aprovado</th>
                  <th className="text-right">Comprado</th>
                  <th className="text-right">Recebido</th>
                  <th className="text-right">Reservado</th>
                  <th className="text-right">Disponível</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {r.lines.map((l) => (
                  <tr key={l.requirementId}>
                    <td>
                      {specText(l)}
                      <span className="block text-xs text-ink-muted">
                        {l.itemCode ?? 'Toda a OS'} · {MATERIAL_SOURCING_LABEL[l.sourcing]}
                        {l.transferredIn
                          ? ` · ${qtyText(l.transferredIn, l.unit)} de sobra transferida`
                          : ''}
                        {l.divergence ? ' · recebimento com divergência' : ''}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{qtyText(l.need, l.unit)}</td>
                    <td className="text-right tabular-nums">{qtyText(l.purchased, l.unit)}</td>
                    <td className="text-right tabular-nums">{qtyText(l.received, l.unit)}</td>
                    <td className="text-right tabular-nums">
                      {l.sourcing === 'ESTOQUE' ? qtyText(l.reserved, l.unit) : '—'}
                    </td>
                    <td className="text-right font-semibold tabular-nums">
                      {qtyText(l.covered, l.unit)}
                    </td>
                    <td>
                      <StageBadge stage={l.stage} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Compras" bodyClassName="p-0">
          {r.purchaseOrders.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-muted">Nenhum pedido de compra.</p>
          ) : (
            <ul className="divide-y divide-line">
              {r.purchaseOrders.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2 px-5 py-3 text-sm">
                  <Link
                    href={`/painel/compras/${p.id}`}
                    className="font-mono font-semibold text-brand-700 hover:underline"
                  >
                    {p.code}
                  </Link>
                  <span className="flex-1">
                    {p.supplierName ?? 'Fornecedor a definir'}
                    {p.expectedDate ? ` · previsto ${formatDay(p.expectedDate)}` : ''}
                  </span>
                  {p.totalCents !== null && (
                    <span className="tabular-nums">{formatCents(p.totalCents)}</span>
                  )}
                  <PurchaseStatusBadge status={p.status} />
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Recebimentos" bodyClassName="p-0">
          {r.receipts.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-muted">Nenhum recebimento.</p>
          ) : (
            <ul className="divide-y divide-line">
              {r.receipts.map((x) => (
                <li key={x.id} className="px-5 py-3 text-sm">
                  <strong>{x.code}</strong> ({x.purchaseOrderCode}) · {formatDateTime(x.receivedAt)}{' '}
                  · {x.receivedBy}
                  {x.issues ? (
                    <span className="text-danger-600"> · {x.issues} divergência(s)</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Reservas de estoque" bodyClassName="p-0">
          {r.reservations.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-muted">Nenhuma reserva.</p>
          ) : (
            <ul className="divide-y divide-line">
              {r.reservations.map((x) => (
                <li key={x.id} className="flex flex-wrap items-center gap-2 px-5 py-3 text-sm">
                  <span className="flex-1">
                    {x.stockItem.code} · {x.stockItem.description} ·{' '}
                    {qtyText(x.quantity, x.stockItem.unit)}
                  </span>
                  <ReservationBadge status={x.status} />
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Sobras" bodyClassName="p-0">
          {r.leftovers.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-muted">Nenhuma sobra registrada.</p>
          ) : (
            <ul className="divide-y divide-line">
              {r.leftovers.map((x) => (
                <li key={x.id} className="px-5 py-3 text-sm">
                  {x.description} {x.color} · {qtyText(x.quantity, x.unit)} · {x.location}
                  {x.serviceOrder.id !== serviceOrderId && (
                    <span className="text-ink-muted"> · recebida da {x.serviceOrder.code}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
