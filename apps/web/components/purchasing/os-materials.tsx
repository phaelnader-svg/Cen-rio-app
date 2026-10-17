'use client';

import {
  MATERIAL_SOURCING_LABEL,
  REQUIREMENT_STATUS_LABEL,
  formatCents,
  type MaterialReadinessDto,
  type ReadinessLineDto,
  type RequirementOrphanDto,
} from '@cenario/shared';
import Link from 'next/link';
import { useState } from 'react';
import { Section } from '@/components/commercial/section';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/misc';
import { useCan } from '@/lib/hooks';
import { formatDay } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useOsReadiness } from '@/lib/purchasing';
import { PurchaseStatusBadge, ReadinessBadge, ReservationBadge, StageBadge } from './badges';
import { qtyText, specText } from './format';
import { LeftoverDialog, type LeftoverPrefill } from './stock-page';

/** Aba Materiais da OS: solicitações aprovadas, compras, recebimentos, reservas, pendências e prontidão. */
export function OsMaterialsOverview({ serviceOrderId }: { serviceOrderId: string }) {
  const q = useOsReadiness(serviceOrderId);
  const can = useCan();
  const [leftover, setLeftover] = useState<LeftoverPrefill | null>(null);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const r = q.data;
  const pending = r.lines.filter((l) => l.covered < l.need);
  const canLeftover = can('estoque.gerenciar');
  const prefillOf = (
    x: ReadinessLineDto | RequirementOrphanDto,
    quantity: number,
    unitPriceCents: number | null,
    purchaseOrders: string[],
  ): LeftoverPrefill => ({
    serviceOrderId: r.serviceOrder.id,
    serviceOrderLabel: `${r.serviceOrder.code} — ${r.customerName}`,
    kind: x.kind,
    description: x.description,
    color: x.color,
    reference: x.reference,
    foamDensity: x.foamDensity,
    thicknessCm: x.thicknessCm,
    quantity,
    unit: x.unit,
    // Custo/origem só quando conhecidos (nada é inventado).
    notes:
      [
        purchaseOrders.length ? `Origem: ${purchaseOrders.join(', ')}` : null,
        unitPriceCents !== null ? `custo unitário ${formatCents(unitPriceCents)}` : null,
      ]
        .filter(Boolean)
        .join(' · ') || null,
  });
  return (
    <div className="space-y-6" data-testid="os-materials-overview">
      {leftover && <LeftoverDialog prefill={leftover} onClose={() => setLeftover(null)} />}
      {r.unconfirmedConsumption && (
        <div data-testid="os-unconfirmed-consumption">
          <Alert tone="warn" title="Material reservado ainda não teve consumo confirmado.">
            A OS já foi entregue e ainda há reserva de estoque ativa: o material está fora do custo
            da OS. Em{' '}
            <Link
              href="/painel/estoque?tab=reservas"
              className="font-medium text-brand-700 hover:underline"
            >
              Estoque → Reservas por OS
            </Link>
            , confirme o consumo (“Entregar à OS”) ou libere a reserva.
          </Alert>
        </div>
      )}
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
            {r.pending.forecasts
              ? `${r.pending.forecasts} previsão(ões) aguardando a medição real · `
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
            <table className="data-table min-w-[960px]" data-testid="os-material-lines">
              <thead>
                <tr>
                  <th>Material</th>
                  <th className="text-right">Aprovado</th>
                  <th className="text-right">Comprado</th>
                  <th className="text-right">Recebido</th>
                  <th className="text-right">Reservado</th>
                  <th className="text-right">Disponível</th>
                  <th className="text-right">Aguardando chegada</th>
                  <th className="text-right">Falta comprar</th>
                  <th>Situação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {r.lines.map((l) => (
                  <tr key={l.requirementId}>
                    <td>
                      {specText(l)}
                      {l.forecast && (
                        <span
                          className="ml-2 rounded bg-warn-50 px-1.5 py-0.5 text-xs font-medium text-warn-600"
                          data-testid={`os-forecast-${l.requirementId}`}
                        >
                          Previsão — não medido
                        </span>
                      )}
                      <span className="block text-xs text-ink-muted">
                        {l.itemCode ?? 'Toda a OS'} · {MATERIAL_SOURCING_LABEL[l.sourcing]}
                        {l.transferredIn
                          ? ` · ${qtyText(l.transferredIn, l.unit)} de sobra transferida`
                          : ''}
                        {l.divergence
                          ? ' · recusa no recebimento aguardando decisão (repor/não repor)'
                          : ''}
                      </span>
                      {l.replaces[0] && (
                        <span
                          className="block text-xs text-ink-soft"
                          data-testid={`os-replaces-${l.requirementId}`}
                        >
                          {l.replaces[0].forecast
                            ? `Previsto ${qtyText(l.replaces[0].quantity, l.unit)} / Medido ${qtyText(l.need, l.unit)} / Substitui previsão`
                            : `Necessidade alterada: ${qtyText(l.replaces[0].quantity, l.unit)} → ${qtyText(l.need, l.unit)}`}
                          {l.replaces[0].inherited
                            ? ''
                            : ' · especificação nova: começa sem a cobertura anterior'}
                        </span>
                      )}
                      <ExcessWarnings
                        l={l}
                        onLeftover={
                          canLeftover && l.leftoverDraft
                            ? () =>
                                setLeftover(
                                  prefillOf(
                                    l,
                                    l.leftoverDraft!.quantity,
                                    l.leftoverDraft!.unitPriceCents,
                                    l.leftoverDraft!.purchaseOrders,
                                  ),
                                )
                            : null
                        }
                      />
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
                    <td className="text-right tabular-nums">{qtyText(l.awaiting, l.unit)}</td>
                    <td
                      className={`text-right tabular-nums ${l.shortfall > 0 ? 'font-semibold text-danger-600' : ''}`}
                      data-testid={`os-shortfall-${l.requirementId}`}
                    >
                      {qtyText(l.shortfall, l.unit)}
                      {l.inDraft > 0 && (
                        <span className="block text-xs font-normal text-ink-muted">
                          + {qtyText(l.inDraft, l.unit)} em rascunho
                        </span>
                      )}
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

      {r.orphans.length > 0 && (
        <Orphans
          r={r}
          onLeftover={
            canLeftover
              ? (o) =>
                  setLeftover(
                    prefillOf(
                      o,
                      o.receivedExclusive,
                      null,
                      o.purchaseOrders.map((p) => p.code),
                    ),
                  )
              : null
          }
        />
      )}

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
                  {x.serviceOrder && x.serviceOrder.id !== serviceOrderId && (
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

/**
 * Etapa 2: o que passa da necessidade atual (redução), por estágio — só avisos que pedem ação.
 * Nada é cancelado, liberado ou movido sozinho.
 */
function ExcessWarnings({
  l,
  onLeftover,
}: {
  l: ReadinessLineDto;
  onLeftover: (() => void) | null;
}) {
  const e = l.excess;
  if (e.total <= 0) return null;
  const stock = l.sourcing === 'ESTOQUE';
  return (
    <ul
      className="mt-1 space-y-0.5 text-xs text-warn-600"
      data-testid={`os-excess-${l.requirementId}`}
    >
      {e.draft > 0 && (
        <li>
          Compra excedente: rascunho com {qtyText(e.draft, l.unit)} além da necessidade — edite o
          rascunho.
        </li>
      )}
      {e.awaiting > 0 && (
        <li>
          Compra excedente: {qtyText(e.awaiting, l.unit)} confirmado(s) além da necessidade — decida
          no pedido (manter ou encerrar o saldo).
        </li>
      )}
      {e.available > 0 &&
        (stock ? (
          <li>
            Reserva excedente: {qtyText(e.available, l.unit)} além da necessidade — libere em{' '}
            <Link
              href="/painel/estoque?tab=reservas"
              className="font-medium text-brand-700 hover:underline"
            >
              Estoque → Reservas
            </Link>{' '}
            se não for usar.
          </li>
        ) : (
          <li className="flex flex-wrap items-center gap-2">
            <span>Recebido {qtyText(e.available, l.unit)} além da necessidade.</span>
            {onLeftover && (
              <Button size="sm" variant="secondary" onClick={onLeftover}>
                Registrar sobra
              </Button>
            )}
          </li>
        ))}
      {e.consumed > 0 && (
        <li className="text-ink-muted">
          {qtyText(e.consumed, l.unit)} já entregue(s) à OS além da necessidade (informativo).
        </li>
      )}
    </ul>
  );
}

/** Compras/reservas que ficaram sem necessidade ativa (substituída por outra especificação ou cancelada). */
function Orphans({
  r,
  onLeftover,
}: {
  r: MaterialReadinessDto;
  onLeftover: ((o: RequirementOrphanDto) => void) | null;
}) {
  return (
    <Section title="Sem necessidade ativa" bodyClassName="p-0">
      <ul className="divide-y divide-line" data-testid="os-orphans">
        {r.orphans.map((o) => {
          const active = o.reservations.filter((x) => x.status === 'ATIVA');
          return (
            <li
              key={o.requirementId}
              className="space-y-1 px-5 py-3 text-sm"
              data-testid={`os-orphan-${o.requirementId}`}
            >
              <div>
                <strong>{specText(o)}</strong>{' '}
                <span className="text-ink-muted">
                  · {o.itemCode ?? 'Toda a OS'} · {REQUIREMENT_STATUS_LABEL[o.status]}
                  {o.closeReason ? ` (${o.closeReason})` : ''}
                </span>
              </div>
              <ul className="space-y-0.5 text-xs text-warn-600">
                {(o.awaiting > 0 || o.draft > 0) && (
                  <li>
                    Compra sem necessidade ativa:{' '}
                    {[
                      o.awaiting > 0 ? `${qtyText(o.awaiting, o.unit)} aguardando chegada` : null,
                      o.draft > 0 ? `${qtyText(o.draft, o.unit)} em rascunho` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}{' '}
                    —{' '}
                    {o.purchaseOrders.map((p, i) => (
                      <span key={p.id}>
                        {i ? ', ' : ''}
                        <Link
                          href={`/painel/compras/${p.id}`}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {p.code}
                        </Link>
                      </span>
                    ))}
                  </li>
                )}
                {active.length > 0 && (
                  <li>
                    Reserva sem necessidade ativa:{' '}
                    {qtyText(
                      active.reduce((s, x) => s + x.quantity, 0),
                      o.unit,
                    )}{' '}
                    — libere em{' '}
                    <Link
                      href="/painel/estoque?tab=reservas"
                      className="font-medium text-brand-700 hover:underline"
                    >
                      Estoque → Reservas
                    </Link>{' '}
                    se não for usar.
                  </li>
                )}
                {o.receivedExclusive > 0 && (
                  <li className="flex flex-wrap items-center gap-2">
                    <span>
                      Recebido {qtyText(o.receivedExclusive, o.unit)} sem necessidade ativa.
                    </span>
                    {onLeftover && (
                      <Button size="sm" variant="secondary" onClick={() => onLeftover(o)}>
                        Registrar sobra
                      </Button>
                    )}
                  </li>
                )}
              </ul>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
