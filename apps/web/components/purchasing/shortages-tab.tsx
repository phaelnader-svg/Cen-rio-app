'use client';

import type { PurchaseShortageDto, PurchaseShortageRowDto } from '@cenario/shared';
import {
  DEADLINE_STATE_LABEL,
  MATERIAL_SOURCING_LABEL,
  PURCHASE_ORDER_STATUS_LABEL,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PackageSearch, ShoppingCart } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PriorityBadge } from '@/components/commercial/badges';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { formatDay } from '@/lib/commercial';
import { useCan } from '@/lib/hooks';
import { decimalText, parseDecimal } from '@/lib/measurements';
import { usePurchaseOrders, useShortages } from '@/lib/purchasing';
import { StageBadge } from './badges';
import { qtyText, specText } from './format';

type Filter = 'TODOS' | 'FALTA' | 'AGUARDANDO' | 'BLOQUEIA';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'TODOS', label: 'Tudo pendente' },
  { key: 'FALTA', label: 'Falta comprar' },
  { key: 'AGUARDANDO', label: 'Aguardando chegada' },
  { key: 'BLOQUEIA', label: 'Bloqueia produção' },
];

const rowMatches = (r: PurchaseShortageRowDto, f: Filter) =>
  f === 'TODOS' ||
  (f === 'FALTA' && r.pendingToBuy > 0) ||
  (f === 'AGUARDANDO' && r.awaiting > 0) ||
  (f === 'BLOQUEIA' && r.blocksProduction);

const DEADLINE_TONE = { ATRASADO: 'danger', EM_RISCO: 'warn', PROXIMO: 'neutral' } as const;

/**
 * "A comprar": um material por especificação, com a falta de cada OS logo abaixo. A sugestão de
 * compra desconta o estoque livre e a compra de estoque já pendente, mas nada é reservado,
 * transferido ou comprado sem a ação de alguém (Reservar / Transferir sobra / Comprar).
 */
export function ShortagesTab() {
  const can = useCan();
  const router = useRouter();
  const list = useShortages();
  const openPos = usePurchaseOrders({ status: 'RASCUNHO,CONFIRMADO,PARCIALMENTE_RECEBIDO' });
  const [filter, setFilter] = useState<Filter>('TODOS');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reserve, setReserve] = useState<PurchaseShortageDto | null>(null);
  const [transfer, setTransfer] = useState<PurchaseShortageDto | null>(null);
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  if (list.isPending) return <Spinner />;
  if (list.isError) return <Alert tone="danger">{list.error.message}</Alert>;
  const canBuy = can('compras.gerenciar');
  const canReserve = can('estoque.gerenciar');
  const canTransfer = can('estoque.autorizar');
  const groups = list.data
    .map((g) => ({ ...g, rows: g.rows.filter((r) => rowMatches(r, filter)) }))
    .filter((g) => g.rows.length > 0);
  const orphans = (openPos.data ?? []).filter((po) => po.withoutDestination.length > 0);
  const buy = (ids: string[]) => router.push(`/painel/compras/novo?req=${ids.join(',')}`);

  return (
    <>
      {orphans.length > 0 && (
        <div className="mb-4" data-testid="orphan-purchases">
          <Alert tone="warn" title="Compra sem destino operacional">
            {orphans.map((po) => (
              <span key={po.id} className="block">
                <Link
                  href={`/painel/compras/${po.id}`}
                  className="font-mono font-semibold text-brand-700 hover:underline"
                >
                  {po.code}
                </Link>{' '}
                ({PURCHASE_ORDER_STATUS_LABEL[po.status]}) é para{' '}
                {po.withoutDestination.map((s) => s.code).join(', ')}, que foi cancelada.
              </span>
            ))}
            <span className="mt-1 block">
              Nada é cancelado ou redistribuído sozinho: material comum entra no estoque livre ao
              chegar; material exclusivo continua identificado na OS cancelada
              (sobra/reaproveitamento manual).
            </span>
          </Alert>
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filtro">
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            size="sm"
            variant={filter === f.key ? 'primary' : 'secondary'}
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </Button>
        ))}
        <span className="flex-1" />
        {canBuy && (
          <Button
            icon={<ShoppingCart className="size-4" aria-hidden />}
            disabled={selected.size === 0}
            onClick={() => buy([...selected])}
          >
            Criar pedido de compra ({selected.size})
          </Button>
        )}
      </div>
      <p className="mb-4 text-sm text-ink-muted">
        Falta = necessidade − disponível − em compra. Sugestão de compra (estoque) = falta − estoque
        livre − compra de estoque pendente. O estoque livre só desconta da sugestão: para ligá-lo a
        uma OS use “Reservar”. Sobras aparecem como sugestão a conferir e não descontam.
      </p>
      {groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={<PackageSearch className="size-6" aria-hidden />}
            title={filter === 'TODOS' ? 'Nada pendente de compra' : 'Nada neste filtro'}
            description="Materiais aparecem aqui quando o gestor aprova as solicitações das medições."
          />
        </Card>
      ) : (
        <div className="space-y-4" data-testid="shortages">
          {groups.map((g) => (
            <Card key={g.key} className="overflow-hidden" data-testid={`shortage-${g.description}`}>
              <div className="flex flex-wrap items-start gap-x-6 gap-y-2 border-b border-line px-5 py-3">
                <div className="min-w-0 flex-1 basis-64">
                  <p className="font-semibold">{specText(g)}</p>
                  <p className="text-xs text-ink-muted">
                    {MATERIAL_SOURCING_LABEL[g.sourcing]}
                    {g.sourcing === 'EXCLUSIVO_OS' ? ' · comprado por OS' : ' · somado entre OS'}
                    {g.stockItem ? ` · ${g.stockItem.code}` : ''}
                  </p>
                  {g.blocksProduction && (
                    <Badge tone="danger" className="mt-1">
                      Bloqueia produção
                    </Badge>
                  )}
                </div>
                <dl className="grid grid-cols-3 gap-x-5 gap-y-1 text-sm sm:grid-cols-6">
                  <Num label="Necessidade" v={qtyText(g.need, g.unit)} />
                  <Num
                    label="Estoque livre"
                    v={g.freeStock === null ? '—' : qtyText(g.freeStock, g.unit)}
                    testid={`free-${g.description}`}
                  />
                  <Num label="Disponível" v={qtyText(g.covered, g.unit)} />
                  <Num
                    label="Em compra"
                    v={qtyText(g.inPurchase + g.freePending, g.unit)}
                    hint={
                      g.freePending > 0
                        ? `${qtyText(g.freePending, g.unit)} para o estoque sem destino`
                        : g.inDraft > 0
                          ? `${qtyText(g.inDraft, g.unit)} em rascunho`
                          : undefined
                    }
                  />
                  <Num label="Falta" v={qtyText(g.shortfall, g.unit)} />
                  <Num
                    label="Sugestão de compra"
                    v={qtyText(g.suggestion, g.unit)}
                    strong
                    testid={`suggestion-${g.description}`}
                  />
                </dl>
              </div>
              {g.sourcing === 'ESTOQUE' && (g.freeStock ?? 0) > 0 && g.shortfall > 0 && (
                <p className="border-b border-line bg-subtle px-5 py-2 text-sm">
                  Falta {qtyText(g.shortfall, g.unit)} · estoque livre{' '}
                  {qtyText(g.freeStock ?? 0, g.unit)}
                  {g.freePending > 0
                    ? ` · em compra p/ estoque ${qtyText(g.freePending, g.unit)}`
                    : ''}{' '}
                  → comprar <strong>{qtyText(g.suggestion, g.unit)}</strong>. O estoque livre ainda
                  não está reservado para nenhuma OS.
                </p>
              )}
              {g.leftovers.length > 0 && (
                <p
                  className="border-b border-line bg-subtle px-5 py-2 text-sm"
                  data-testid={`leftover-hint-${g.description}`}
                >
                  Sobra disponível:{' '}
                  {g.leftovers
                    .map((l) => `${qtyText(l.quantity, g.unit)} na ${l.serviceOrder.code}`)
                    .join(' · ')}{' '}
                  — conferir compatibilidade (cor, lote, tonalidade) antes de usar.
                </p>
              )}
              <div className="overflow-x-auto">
                <table className="data-table min-w-[900px]">
                  <thead>
                    <tr>
                      {canBuy && <th className="w-10" />}
                      <th>OS / cliente</th>
                      <th>Peça</th>
                      <th className="text-right">Necessidade</th>
                      <th className="text-right">Disponível</th>
                      <th className="text-right">Aguardando chegada</th>
                      <th className="text-right">Falta</th>
                      <th>Situação</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {g.rows.map((n) => (
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
                          <span className="flex flex-wrap gap-1">
                            <PriorityBadge priority={n.serviceOrder.priority} />
                            {n.deadlineState in DEADLINE_TONE && (
                              <Badge
                                tone={DEADLINE_TONE[n.deadlineState as keyof typeof DEADLINE_TONE]}
                              >
                                {DEADLINE_STATE_LABEL[n.deadlineState]}
                              </Badge>
                            )}
                          </span>
                        </td>
                        <td className="text-sm">{n.itemCode ?? 'Toda a OS'}</td>
                        <td className="text-right tabular-nums">{qtyText(n.need, n.unit)}</td>
                        <td className="text-right tabular-nums">{qtyText(n.covered, n.unit)}</td>
                        <td className="text-right tabular-nums">
                          {qtyText(n.awaiting, n.unit)}
                          {n.purchases
                            .filter((p) => p.status !== 'RECEBIDO')
                            .map((p) => (
                              <Link
                                key={p.purchaseOrderId}
                                href={`/painel/compras/${p.purchaseOrderId}`}
                                className="block text-xs text-brand-700 hover:underline"
                              >
                                {p.code} · {PURCHASE_ORDER_STATUS_LABEL[p.status]}
                              </Link>
                            ))}
                        </td>
                        <td
                          className="text-right font-semibold tabular-nums"
                          data-testid={`to-buy-${n.serviceOrder.code}-${n.description}`}
                        >
                          {qtyText(n.pendingToBuy, n.unit)}
                        </td>
                        <td>
                          <span className="flex flex-wrap gap-1">
                            <StageBadge stage={n.stage} />
                            {n.blocksProduction && <Badge tone="danger">Bloqueia produção</Badge>}
                            {n.divergence && <Badge tone="danger">Recusa a decidir</Badge>}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
                {g.sourcing === 'ESTOQUE' &&
                  canReserve &&
                  g.stockItem &&
                  (g.freeStock ?? 0) > 0 && (
                    <Button size="sm" variant="secondary" onClick={() => setReserve(g)}>
                      Reservar
                    </Button>
                  )}
                {g.leftovers.length > 0 && canTransfer && (
                  <Button size="sm" variant="secondary" onClick={() => setTransfer(g)}>
                    Transferir sobra
                  </Button>
                )}
                {canBuy && (
                  <Button
                    size="sm"
                    icon={<ShoppingCart className="size-4" aria-hidden />}
                    disabled={g.suggestion <= 0}
                    onClick={() =>
                      buy(g.rows.filter((r) => r.pendingToBuy > 0).map((r) => r.requirementId))
                    }
                  >
                    Comprar {g.suggestion > 0 ? qtyText(g.suggestion, g.unit) : ''}
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      {reserve && <ReserveDialog group={reserve} onClose={() => setReserve(null)} />}
      {transfer && <TransferDialog group={transfer} onClose={() => setTransfer(null)} />}
    </>
  );
}

function Num({
  label,
  v,
  strong,
  hint,
  testid,
}: {
  label: string;
  v: string;
  strong?: boolean;
  hint?: string;
  testid?: string;
}) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={`tabular-nums ${strong ? 'font-semibold' : ''}`} data-testid={testid}>
        {v}
        {hint && <span className="block text-xs font-normal text-ink-muted">{hint}</span>}
      </dd>
    </div>
  );
}

function useAction(success: string, onDone: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      for (const k of ['needs', 'stock-items', 'stock-reservations', 'leftovers', 'readiness'])
        void qc.invalidateQueries({ queryKey: [k] });
      void qc.invalidateQueries({ queryKey: ['os-readiness'] });
      toast('ok', success);
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return { m, error };
}

/** Reserva explícita do estoque livre para uma OS (a ação existente de reserva). */
function ReserveDialog({ group, onClose }: { group: PurchaseShortageDto; onClose: () => void }) {
  const rows = group.rows.filter((r) => r.need - r.covered > 0);
  const [rid, setRid] = useState(rows[0]?.requirementId ?? '');
  const row = rows.find((r) => r.requirementId === rid);
  const max = row ? Math.min(group.freeStock ?? 0, row.need - row.covered) : 0;
  const [qty, setQty] = useState(decimalText(Math.max(0, Math.round(max * 1000) / 1000)));
  const [key] = useState(newIdempotencyKey);
  const { m, error } = useAction('Material reservado para a OS.', onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Reservar ${group.description}`}
      description={`Estoque livre: ${qtyText(group.freeStock ?? 0, group.unit)}. A reserva liga o material à OS escolhida.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            disabled={!row || !(parseDecimal(qty) > 0)}
            onClick={() =>
              m.mutate(() =>
                api('/api/v1/stock-reservations', {
                  method: 'POST',
                  idempotencyKey: key,
                  body: {
                    stockItemId: group.stockItem!.id,
                    serviceOrderId: row!.serviceOrder.id,
                    materialRequirementId: row!.requirementId,
                    quantity: parseDecimal(qty),
                  },
                }),
              )
            }
          >
            Reservar
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Para a OS">
          {(p) => (
            <Select
              {...p}
              value={rid}
              onChange={(e) => {
                setRid(e.target.value);
                const r = rows.find((x) => x.requirementId === e.target.value);
                if (r)
                  setQty(
                    decimalText(
                      Math.round(Math.min(group.freeStock ?? 0, r.need - r.covered) * 1000) / 1000,
                    ),
                  );
              }}
            >
              {rows.map((r) => (
                <option key={r.requirementId} value={r.requirementId}>
                  {r.serviceOrder.code} · {r.itemCode ?? 'Toda a OS'} · falta cobrir{' '}
                  {qtyText(r.need - r.covered, r.unit)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Quantidade">
          {(p) => (
            <Input
              {...p}
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

/** Transferência de sobra (ação existente, com autorização): só depois de conferir a peça. */
function TransferDialog({ group, onClose }: { group: PurchaseShortageDto; onClose: () => void }) {
  const rows = group.rows.filter((r) => r.need - r.covered > 0);
  const [lid, setLid] = useState(group.leftovers[0]?.id ?? '');
  const [rid, setRid] = useState(rows[0]?.requirementId ?? '');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [key] = useState(newIdempotencyKey);
  const row = rows.find((r) => r.requirementId === rid);
  const { m, error } = useAction('Sobra transferida.', onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Transferir sobra — ${group.description}`}
      description="Confira cor, lote e tonalidade antes de transferir: especificação igual no texto não garante compatibilidade."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            disabled={!row || !lid || !(parseDecimal(qty) > 0) || reason.trim().length < 3}
            onClick={() =>
              m.mutate(() =>
                api(`/api/v1/material-leftovers/${lid}/transfer`, {
                  method: 'POST',
                  idempotencyKey: key,
                  body: {
                    targetServiceOrderId: row!.serviceOrder.id,
                    targetRequirementId: row!.requirementId,
                    quantity: parseDecimal(qty),
                    reason,
                  },
                }),
              )
            }
          >
            Transferir
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Sobra">
          {(p) => (
            <Select {...p} value={lid} onChange={(e) => setLid(e.target.value)}>
              {group.leftovers.map((l) => (
                <option key={l.id} value={l.id}>
                  {qtyText(l.quantity, group.unit)} da {l.serviceOrder.code} · {l.location}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Para a OS">
          {(p) => (
            <Select {...p} value={rid} onChange={(e) => setRid(e.target.value)}>
              {rows.map((r) => (
                <option key={r.requirementId} value={r.requirementId}>
                  {r.serviceOrder.code} · {r.itemCode ?? 'Toda a OS'}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Quantidade">
          {(p) => (
            <Input
              {...p}
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          )}
        </Field>
        <Field label="Motivo (conferência feita)" className="sm:col-span-2">
          {(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}
