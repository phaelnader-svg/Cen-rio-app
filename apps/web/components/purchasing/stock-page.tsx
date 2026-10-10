'use client';

import type { LeftoverDto, MaterialKind, MaterialUnit, StockItemDto } from '@cenario/shared';
import {
  LEFTOVER_CONDITIONS,
  LEFTOVER_CONDITION_LABEL,
  LEFTOVER_STATUS_LABEL,
  MATERIAL_KINDS,
  MATERIAL_KIND_LABEL,
  MATERIAL_UNIT_LABEL,
  STOCK_MOVEMENT_LABEL,
  UNITS_BY_KIND,
  formatQuantity,
  specKey,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Boxes, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { useServiceOrders } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import { parseDecimal } from '@/lib/measurements';
import {
  useLeftovers,
  useMovements,
  useNeeds,
  useOsReadiness,
  useReservations,
  useStockItems,
} from '@/lib/purchasing';
import { ReservationBadge } from './badges';
import { qtyText, specText } from './format';

/** Mutação simples com toast e erro (invalida as listas de estoque). */
function useSend(success: string, onDone: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      for (const k of [
        'stock-items',
        'stock-movements',
        'stock-reservations',
        'leftovers',
        'readiness',
        'os-readiness',
        'needs',
      ])
        void qc.invalidateQueries({ queryKey: [k] });
      toast('ok', success);
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return { m, error };
}

export function StockPage() {
  const [tab, setTab] = useState('materiais');
  return (
    <>
      <PageHeader
        title="Estoque"
        description="Materiais comuns (espumas, MDF, ferragens, cola…) com saldo físico, reservado e disponível. Tecidos não entram no estoque comum: pertencem à OS que os comprou."
      />
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'materiais', label: 'Materiais' },
          { key: 'movimentacoes', label: 'Movimentações' },
          { key: 'reservas', label: 'Reservas por OS' },
          { key: 'sobras', label: 'Sobras' },
        ]}
      >
        {tab === 'materiais' && <ItemsTab />}
        {tab === 'movimentacoes' && <MovementsTab />}
        {tab === 'reservas' && <ReservationsTab />}
        {tab === 'sobras' && <LeftoversTab />}
      </Tabs>
    </>
  );
}

function ItemsTab() {
  const can = useCan();
  const items = useStockItems();
  const [dialog, setDialog] = useState<
    { kind: 'new' } | { kind: 'adjust' | 'reserve'; item: StockItemDto } | null
  >(null);
  const manage = can('estoque.gerenciar');
  if (items.isPending) return <Spinner />;
  if (items.isError) return <Alert tone="danger">{items.error.message}</Alert>;
  return (
    <>
      {manage && (
        <div className="mb-4 flex justify-end">
          <Button
            icon={<Plus className="size-4" aria-hidden />}
            onClick={() => setDialog({ kind: 'new' })}
          >
            Novo material
          </Button>
        </div>
      )}
      {items.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Boxes className="size-6" aria-hidden />}
            title="Nenhum material no estoque"
            description="Materiais comuns comprados entram aqui automaticamente."
          />
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="data-table min-w-[820px]" data-testid="stock-items">
            <thead>
              <tr>
                <th>Material</th>
                <th className="text-right">Físico</th>
                <th className="text-right">Reservado</th>
                <th className="text-right">Disponível</th>
                <th className="text-right">Mínimo</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.data.map((i) => (
                <tr key={i.id} data-testid={`stock-${i.code}`}>
                  <td>
                    <span className="font-mono text-xs text-ink-muted">{i.code}</span> {specText(i)}
                    {i.location && (
                      <span className="block text-xs text-ink-muted">{i.location}</span>
                    )}
                  </td>
                  <td className="text-right tabular-nums">{qtyText(i.onHand, i.unit)}</td>
                  <td className="text-right tabular-nums">{formatQuantity(i.reserved)}</td>
                  <td className="text-right font-semibold tabular-nums">
                    {formatQuantity(i.available)}
                    {i.belowMinimum && (
                      <Badge tone="danger" className="ml-2">
                        Abaixo do mínimo
                      </Badge>
                    )}
                  </td>
                  <td className="text-right tabular-nums">
                    {i.minQuantity === null ? '—' : formatQuantity(i.minQuantity)}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {manage && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDialog({ kind: 'reserve', item: i })}
                        >
                          Reservar
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDialog({ kind: 'adjust', item: i })}
                        >
                          Ajustar
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {dialog?.kind === 'new' && <NewItemDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'adjust' && (
        <AdjustDialog item={dialog.item} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'reserve' && (
        <ReserveDialog item={dialog.item} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

function NewItemDialog({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<'ESPUMA' | 'OUTRO'>('OUTRO');
  const [v, setV] = useState({
    description: '',
    foamDensity: '',
    thicknessCm: '',
    lengthCm: '',
    widthCm: '',
    minQuantity: '',
    location: '',
  });
  const [unit, setUnit] = useState<MaterialUnit>('UNIDADE');
  const { m, error } = useSend('Material cadastrado.', onClose);
  const n = (t: string) => (t.trim() ? parseDecimal(t) : null);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Novo material de estoque"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            onClick={() =>
              m.mutate(() =>
                api('/api/v1/stock-items', {
                  method: 'POST',
                  body: {
                    kind,
                    description: v.description,
                    foamDensity: kind === 'ESPUMA' ? v.foamDensity : null,
                    thicknessCm: kind === 'ESPUMA' ? n(v.thicknessCm) : null,
                    lengthCm: kind === 'ESPUMA' ? n(v.lengthCm) : null,
                    widthCm: kind === 'ESPUMA' ? n(v.widthCm) : null,
                    unit,
                    minQuantity: n(v.minQuantity),
                    location: v.location,
                  },
                }),
              )
            }
          >
            Cadastrar
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tipo">
          {(p) => (
            <Select
              {...p}
              value={kind}
              onChange={(e) => {
                const k = e.target.value as 'ESPUMA' | 'OUTRO';
                setKind(k);
                setUnit(UNITS_BY_KIND[k][0]!);
              }}
            >
              <option value="OUTRO">{MATERIAL_KIND_LABEL.OUTRO}</option>
              <option value="ESPUMA">{MATERIAL_KIND_LABEL.ESPUMA}</option>
            </Select>
          )}
        </Field>
        <Field label="Unidade">
          {(p) => (
            <Select {...p} value={unit} onChange={(e) => setUnit(e.target.value as MaterialUnit)}>
              {UNITS_BY_KIND[kind].map((u) => (
                <option key={u} value={u}>
                  {MATERIAL_UNIT_LABEL[u]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Descrição" className="sm:col-span-2" required>
          {(p) => (
            <Input
              {...p}
              value={v.description}
              onChange={(e) => setV({ ...v, description: e.target.value })}
            />
          )}
        </Field>
        {kind === 'ESPUMA' && (
          <>
            <Field label="Densidade">
              {(p) => (
                <Input
                  {...p}
                  value={v.foamDensity}
                  onChange={(e) => setV({ ...v, foamDensity: e.target.value })}
                />
              )}
            </Field>
            <Field label="Espessura (cm)">
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  value={v.thicknessCm}
                  onChange={(e) => setV({ ...v, thicknessCm: e.target.value })}
                />
              )}
            </Field>
            <Field label="Comprimento (cm)">
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  value={v.lengthCm}
                  onChange={(e) => setV({ ...v, lengthCm: e.target.value })}
                />
              )}
            </Field>
            <Field label="Largura (cm)">
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  value={v.widthCm}
                  onChange={(e) => setV({ ...v, widthCm: e.target.value })}
                />
              )}
            </Field>
          </>
        )}
        <Field label="Estoque mínimo" hint="Avisa o gestor quando o disponível ficar abaixo.">
          {(p) => (
            <Input
              {...p}
              inputMode="decimal"
              value={v.minQuantity}
              onChange={(e) => setV({ ...v, minQuantity: e.target.value })}
            />
          )}
        </Field>
        <Field label="Localização">
          {(p) => (
            <Input
              {...p}
              value={v.location}
              onChange={(e) => setV({ ...v, location: e.target.value })}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

function AdjustDialog({ item, onClose }: { item: StockItemDto; onClose: () => void }) {
  const [direction, setDirection] = useState<'in' | 'out'>('in');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [key] = useState(newIdempotencyKey);
  const { m, error } = useSend('Ajuste registrado.', onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Ajustar ${item.code}`}
      description={`${specText(item)} · físico ${qtyText(item.onHand, item.unit)} · reservado ${formatQuantity(item.reserved)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            disabled={!(parseDecimal(qty) > 0) || reason.trim().length < 3}
            onClick={() =>
              m.mutate(() =>
                api(`/api/v1/stock-items/${item.id}/adjust`, {
                  method: 'POST',
                  idempotencyKey: key,
                  body: {
                    quantity: direction === 'in' ? parseDecimal(qty) : -parseDecimal(qty),
                    reason,
                  },
                }),
              )
            }
          >
            Registrar
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <div className="grid gap-4">
        <Field label="Tipo">
          {(p) => (
            <Select
              {...p}
              value={direction}
              onChange={(e) => setDirection(e.target.value as 'in' | 'out')}
            >
              <option value="in">Entrada (inventário, devolução…)</option>
              <option value="out">Saída (perda, inventário…)</option>
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
        <Field label="Motivo">
          {(p) => (
            <Textarea {...p} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

function ReserveDialog({ item, onClose }: { item: StockItemDto; onClose: () => void }) {
  const needs = useNeeds(false);
  const key = specKey({ ...item, color: null, reference: null });
  const matching = (needs.data ?? []).filter(
    (n) =>
      n.sourcing === 'ESTOQUE' &&
      specKey({ ...n, color: null, reference: null }) === key &&
      n.covered < n.need,
  );
  const [req, setReq] = useState('');
  const [qty, setQty] = useState('');
  const [idem] = useState(newIdempotencyKey);
  const { m, error } = useSend('Reserva registrada.', onClose);
  const chosen = matching.find((n) => n.requirementId === req);
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Reservar ${item.code} para uma OS`}
      description={`Disponível: ${qtyText(item.available, item.unit)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            disabled={!chosen || !(parseDecimal(qty) > 0)}
            onClick={() =>
              m.mutate(() =>
                api('/api/v1/stock-reservations', {
                  method: 'POST',
                  idempotencyKey: idem,
                  body: {
                    stockItemId: item.id,
                    serviceOrderId: chosen!.serviceOrder.id,
                    materialRequirementId: chosen!.requirementId,
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
      {matching.length === 0 ? (
        <p className="text-sm text-ink-muted">Nenhuma OS precisa deste material agora.</p>
      ) : (
        <div className="grid gap-4">
          <Field label="Necessidade aprovada">
            {(p) => (
              <Select
                {...p}
                value={req}
                onChange={(e) => {
                  setReq(e.target.value);
                  const n = matching.find((x) => x.requirementId === e.target.value);
                  if (n)
                    setQty(
                      String(Math.round((n.need - n.covered) * 1000) / 1000).replace('.', ','),
                    );
                }}
              >
                <option value="">Selecione…</option>
                {matching.map((n) => (
                  <option key={n.requirementId} value={n.requirementId}>
                    {n.serviceOrder.code} — falta {qtyText(n.need - n.covered, n.unit)}
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
      )}
    </Dialog>
  );
}

function MovementsTab() {
  const list = useMovements();
  if (list.isPending) return <Spinner />;
  if (list.isError) return <Alert tone="danger">{list.error.message}</Alert>;
  if (list.data.length === 0)
    return (
      <Card>
        <EmptyState title="Nenhuma movimentação" />
      </Card>
    );
  return (
    <Card className="overflow-x-auto">
      <table className="data-table min-w-[820px]" data-testid="stock-movements">
        <thead>
          <tr>
            <th>Quando</th>
            <th>Material</th>
            <th>Tipo</th>
            <th className="text-right">Quantidade</th>
            <th className="text-right">Saldo após</th>
            <th>Referência</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {list.data.map((mv) => (
            <tr key={mv.id}>
              <td className="whitespace-nowrap">
                {formatDateTime(mv.createdAt)}
                <span className="block text-xs text-ink-muted">{mv.actor}</span>
              </td>
              <td>
                {mv.stockItem.code} · {mv.stockItem.description}
              </td>
              <td>{STOCK_MOVEMENT_LABEL[mv.type]}</td>
              <td
                className={`px-4 py-2.5 text-right font-semibold tabular-nums ${mv.quantity < 0 ? 'text-danger-600' : 'text-ok-600'}`}
              >
                {mv.quantity > 0 ? '+' : ''}
                {formatQuantity(mv.quantity)}
              </td>
              <td className="text-right tabular-nums">
                {formatQuantity(mv.balanceAfter)} (res. {formatQuantity(mv.reservedAfter)})
              </td>
              <td className="text-xs text-ink-muted">
                {[mv.reference, mv.serviceOrder?.code, mv.reason].filter(Boolean).join(' · ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function ReservationsTab() {
  const can = useCan();
  const [status, setStatus] = useState('ATIVA');
  const list = useReservations(status);
  const { m, error } = useSend('Reserva atualizada.', () => undefined);
  return (
    <>
      <div className="mb-4 flex justify-end">
        <Select
          aria-label="Situação"
          className="max-w-60"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="ATIVA">Reservadas</option>
          <option value="">Todas</option>
        </Select>
      </div>
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{list.error.message}</Alert>
      ) : list.data.length === 0 ? (
        <Card>
          <EmptyState title="Nenhuma reserva" />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line" data-testid="reservations">
            {list.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Link
                  href={`/painel/os/${r.serviceOrder.id}`}
                  className="font-mono text-sm font-semibold text-brand-700 hover:underline"
                >
                  {r.serviceOrder.code}
                </Link>
                <span className="min-w-0 flex-1">
                  {r.stockItem.code} · {r.stockItem.description} ·{' '}
                  <strong>{qtyText(r.quantity, r.stockItem.unit)}</strong>
                  <span className="block text-xs text-ink-muted">
                    {formatDateTime(r.createdAt)} · {r.createdBy}
                    {r.closeReason ? ` · ${r.closeReason}` : ''}
                  </span>
                </span>
                <ReservationBadge status={r.status} />
                {r.status === 'ATIVA' && can('estoque.gerenciar') && (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={m.isPending}
                      onClick={() =>
                        m.mutate(() =>
                          api(`/api/v1/stock-reservations/${r.id}/consume`, {
                            method: 'POST',
                            body: {},
                          }),
                        )
                      }
                    >
                      Entregar à OS
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={m.isPending}
                      onClick={() =>
                        m.mutate(() =>
                          api(`/api/v1/stock-reservations/${r.id}/release`, {
                            method: 'POST',
                            body: { reason: 'Liberada pelo gestor' },
                          }),
                        )
                      }
                    >
                      Liberar
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function LeftoversTab() {
  const can = useCan();
  const [all, setAll] = useState(false);
  const list = useLeftovers(all);
  const [dialog, setDialog] = useState<
    { kind: 'new' } | { kind: 'transfer'; l: LeftoverDto } | null
  >(null);
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Checkbox
          label="Mostrar transferidas e descartadas"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
        />
        <span className="flex-1" />
        {can('estoque.gerenciar') && (
          <Button
            icon={<Plus className="size-4" aria-hidden />}
            onClick={() => setDialog({ kind: 'new' })}
          >
            Registrar sobra
          </Button>
        )}
      </div>
      <Alert tone="info" className="mb-4">
        Sobras de tecido continuam da OS de origem. Só o gestor pode transferi-las para outra OS,
        com motivo e histórico.
      </Alert>
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{list.error.message}</Alert>
      ) : list.data.length === 0 ? (
        <Card>
          <EmptyState title="Nenhuma sobra registrada" />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line" data-testid="leftovers">
            {list.data.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className="font-mono text-sm font-semibold">{l.serviceOrder.code}</span>
                <span className="min-w-0 flex-1">
                  {MATERIAL_KIND_LABEL[l.kind]}:{' '}
                  {[l.description, l.color, l.reference && `ref. ${l.reference}`]
                    .filter(Boolean)
                    .join(' ')}{' '}
                  · <strong>{qtyText(l.quantity, l.unit)}</strong>
                  <span className="block text-xs text-ink-muted">
                    {l.location} · {LEFTOVER_CONDITION_LABEL[l.condition]} ·{' '}
                    {l.reusable ? 'reaproveitável' : 'não reaproveitável'} ·{' '}
                    {LEFTOVER_STATUS_LABEL[l.status]}
                    {l.transfers
                      .map(
                        (t) =>
                          ` · ${qtyText(t.quantity, l.unit)} → ${t.toServiceOrder.code} (${t.authorizedBy})`,
                      )
                      .join('')}
                  </span>
                </span>
                {l.status === 'DISPONIVEL' && can('estoque.autorizar') && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setDialog({ kind: 'transfer', l })}
                  >
                    Transferir
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {dialog?.kind === 'new' && <LeftoverDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'transfer' && (
        <TransferDialog l={dialog.l} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

function LeftoverDialog({ onClose }: { onClose: () => void }) {
  const sos = useServiceOrders({ status: 'ABERTA' });
  const [v, setV] = useState({
    serviceOrderId: '',
    kind: 'TECIDO' as MaterialKind,
    description: '',
    color: '',
    reference: '',
    quantity: '',
    location: '',
    condition: 'BOA',
    reusable: true,
  });
  const [unit, setUnit] = useState<MaterialUnit>('METRO');
  const { m, error } = useSend('Sobra registrada.', onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Registrar sobra"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            onClick={() =>
              m.mutate(() =>
                api('/api/v1/material-leftovers', {
                  method: 'POST',
                  body: { ...v, unit, quantity: parseDecimal(v.quantity) },
                }),
              )
            }
          >
            Registrar
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="OS de origem" className="sm:col-span-2">
          {(p) => (
            <Select
              {...p}
              value={v.serviceOrderId}
              onChange={(e) => setV({ ...v, serviceOrderId: e.target.value })}
            >
              <option value="">Selecione…</option>
              {sos.data?.items.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.customer.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Tipo">
          {(p) => (
            <Select
              {...p}
              value={v.kind}
              onChange={(e) => {
                const k = e.target.value as MaterialKind;
                setV({ ...v, kind: k });
                setUnit(UNITS_BY_KIND[k][0]!);
              }}
            >
              {MATERIAL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {MATERIAL_KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Unidade">
          {(p) => (
            <Select {...p} value={unit} onChange={(e) => setUnit(e.target.value as MaterialUnit)}>
              {UNITS_BY_KIND[v.kind].map((u) => (
                <option key={u} value={u}>
                  {MATERIAL_UNIT_LABEL[u]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Descrição / referência">
          {(p) => (
            <Input
              {...p}
              value={v.description}
              onChange={(e) => setV({ ...v, description: e.target.value })}
            />
          )}
        </Field>
        <Field label="Cor">
          {(p) => (
            <Input {...p} value={v.color} onChange={(e) => setV({ ...v, color: e.target.value })} />
          )}
        </Field>
        <Field label="Referência do fornecedor">
          {(p) => (
            <Input
              {...p}
              value={v.reference}
              onChange={(e) => setV({ ...v, reference: e.target.value })}
            />
          )}
        </Field>
        <Field label="Quantidade restante">
          {(p) => (
            <Input
              {...p}
              inputMode="decimal"
              value={v.quantity}
              onChange={(e) => setV({ ...v, quantity: e.target.value })}
            />
          )}
        </Field>
        <Field label="Localização">
          {(p) => (
            <Input
              {...p}
              value={v.location}
              onChange={(e) => setV({ ...v, location: e.target.value })}
            />
          )}
        </Field>
        <Field label="Condição">
          {(p) => (
            <Select
              {...p}
              value={v.condition}
              onChange={(e) => setV({ ...v, condition: e.target.value })}
            >
              {LEFTOVER_CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {LEFTOVER_CONDITION_LABEL[c]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Checkbox
          label="Pode ser reaproveitada"
          checked={v.reusable}
          onChange={(e) => setV({ ...v, reusable: e.target.checked })}
        />
      </div>
    </Dialog>
  );
}

function TransferDialog({ l, onClose }: { l: LeftoverDto; onClose: () => void }) {
  const sos = useServiceOrders({ status: 'ABERTA' });
  const [target, setTarget] = useState('');
  const readiness = useOsReadiness(target, Boolean(target));
  const [req, setReq] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [key] = useState(newIdempotencyKey);
  const { m, error } = useSend('Sobra transferida.', onClose);
  const lines = (readiness.data?.lines ?? []).filter(
    (x) => x.kind === l.kind && x.covered < x.need,
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Transferir sobra (autorização do gestor)"
      description={`${l.description} ${l.color ?? ''} · ${qtyText(l.quantity, l.unit)} na ${l.serviceOrder.code}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            disabled={!target || !(parseDecimal(qty) > 0) || reason.trim().length < 3}
            onClick={() =>
              m.mutate(() =>
                api(`/api/v1/material-leftovers/${l.id}/transfer`, {
                  method: 'POST',
                  idempotencyKey: key,
                  body: {
                    targetServiceOrderId: target,
                    targetRequirementId: req || null,
                    quantity: parseDecimal(qty),
                    reason,
                  },
                }),
              )
            }
          >
            Autorizar transferência
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <div className="grid gap-4">
        <Field label="OS de destino">
          {(p) => (
            <Select
              {...p}
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setReq('');
              }}
            >
              <option value="">Selecione…</option>
              {sos.data?.items
                .filter((s) => s.id !== l.serviceOrder.id)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} — {s.customer.name}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field
          label="Atender a necessidade (opcional)"
          hint="Só materiais com a mesma referência, cor e unidade."
        >
          {(p) => (
            <Select {...p} value={req} onChange={(e) => setReq(e.target.value)}>
              <option value="">Nenhuma (apenas transferir)</option>
              {lines.map((x) => (
                <option key={x.requirementId} value={x.requirementId}>
                  {specText(x)} — falta {qtyText(x.need - x.covered, x.unit)}
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
        <Field label="Motivo">
          {(p) => (
            <Textarea {...p} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
