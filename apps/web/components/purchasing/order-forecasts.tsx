'use client';

import {
  REQUIREMENT_STATUS_LABEL,
  type MaterialKind,
  type OrderForecastsDto,
  type RequirementOrphanDto,
  type SpecDto,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link2, Pencil, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Section } from '@/components/commercial/section';
import { type ItemDraft, MaterialForm } from '@/components/measurements/material-form';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select, Textarea } from '@/components/ui/field';
import { Alert, Badge, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { useCan } from '@/lib/hooks';
import { useOrderForecasts } from '@/lib/purchasing';
import { StageBadge } from './badges';
import { qtyText, specText } from './format';
import { LeftoverDialog, type LeftoverPrefill } from './stock-page';

type Forecast = OrderForecastsDto['forecasts'][number];
type Piece = OrderForecastsDto['pieces'][number];
type Orphan = OrderForecastsDto['orphans'][number];

const KINDS: { kind: MaterialKind; label: string }[] = [
  { kind: 'TECIDO', label: 'Tecido' },
  { kind: 'ESPUMA', label: 'Espuma' },
  { kind: 'OUTRO', label: 'Outro material' },
];

function useForecastAction(orderId: string, success: string, onDone: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      for (const k of ['order-forecasts', 'needs', 'readiness', 'os-readiness'])
        void qc.invalidateQueries({ queryKey: k === 'order-forecasts' ? [k, orderId] : [k] });
      toast('ok', success);
      setError(null);
      onDone();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return { m, error };
}

const draftOf = (f: Forecast): ItemDraft => ({
  key: f.requirementId,
  serviceOrderItemId: null,
  kind: f.kind,
  sourcing: f.sourcing,
  description: f.description,
  color: f.color,
  reference: f.reference,
  foamDensity: f.foamDensity,
  thicknessCm: f.thicknessCm,
  lengthCm: f.lengthCm,
  widthCm: f.widthCm,
  quantity: f.need,
  unit: f.unit,
});

const bodyOf = ({ key: _key, serviceOrderItemId: _si, ...item }: ItemDraft) => item;

/**
 * Etapa 3 — "Compra antes da chegada": previsão de material por peça do pedido. É previsão, não
 * medição: entra em Compras → A comprar como "Pré-chegada" e nunca libera a produção sozinha;
 * a medição real da OS a substitui.
 */
export function OrderForecasts({ orderId }: { orderId: string }) {
  const can = useCan();
  const q = useOrderForecasts(orderId);
  const manage = can('materiais.aprovar');
  const canLeftover = can('estoque.gerenciar');
  const [adding, setAdding] = useState<{ piece: string; kind: MaterialKind } | null>(null);
  const [editing, setEditing] = useState<Forecast | null>(null);
  const [cancelling, setCancelling] = useState<Forecast | null>(null);
  const [linking, setLinking] = useState<Forecast | null>(null);
  const [leftover, setLeftover] = useState<LeftoverPrefill | null>(null);
  const [key, setKey] = useState(newIdempotencyKey);
  const done = () => {
    setAdding(null);
    setEditing(null);
    setKey(newIdempotencyKey());
  };
  const save = useForecastAction(orderId, 'Previsão de material salva.', done);

  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const d = q.data;
  const active = d.order.status !== 'CANCELADO';
  const prefill = (
    x: SpecDto & { requirementId: string },
    pieceName: string,
    quantity: number,
    purchaseOrders: string[],
  ): LeftoverPrefill => ({
    serviceOrderId: null,
    sourceRequirementId: x.requirementId,
    serviceOrderLabel: `Pré-chegada ${d.order.code} · ${pieceName}`,
    kind: x.kind,
    description: x.description,
    color: x.color,
    reference: x.reference,
    foamDensity: x.foamDensity,
    thicknessCm: x.thicknessCm,
    quantity,
    unit: x.unit,
    notes: purchaseOrders.length ? `Origem: ${purchaseOrders.join(', ')}` : null,
  });

  return (
    <Section title="Previsão de material" className="lg:col-span-5" bodyClassName="p-0">
      {leftover && <LeftoverDialog prefill={leftover} onClose={() => setLeftover(null)} />}
      {cancelling && (
        <CancelForecastDialog
          orderId={orderId}
          forecast={cancelling}
          onClose={() => setCancelling(null)}
        />
      )}
      {linking && (
        <LinkForecastDialog
          orderId={orderId}
          forecast={linking}
          piece={d.pieces.find((p) => p.orderItemId === linking.orderItemId)!}
          onClose={() => setLinking(null)}
        />
      )}
      <p
        className="border-b border-line px-5 py-3 text-sm text-ink-muted"
        data-testid="order-forecast-hint"
      >
        Previsão — não medido. Permite comprar antes da chegada da peça (aparece em Compras → A
        comprar como “Pré-chegada”). Não libera a produção: a medição real da OS substitui a
        previsão.
      </p>
      {save.error && (
        <Alert tone="danger" className="m-4">
          {save.error}
        </Alert>
      )}
      <ul className="divide-y divide-line" data-testid="order-forecasts">
        {d.pieces.map((p) => {
          const lines = d.forecasts.filter((f) => f.orderItemId === p.orderItemId);
          const orphans = d.orphans.filter((o) => o.orderItemId === p.orderItemId);
          return (
            <li
              key={p.orderItemId}
              className="px-5 py-4"
              data-testid={`forecast-piece-${p.position}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">
                  {p.position}. {p.description}{' '}
                  <span className="text-sm text-ink-muted">({p.quantity})</span>
                </p>
                {manage && active && p.canForecast && (
                  <span className="flex flex-wrap gap-2">
                    {KINDS.map((k) => (
                      <Button
                        key={k.kind}
                        size="sm"
                        variant="secondary"
                        icon={<Plus className="size-4" aria-hidden />}
                        onClick={() => {
                          setEditing(null);
                          setAdding({ piece: p.orderItemId, kind: k.kind });
                        }}
                      >
                        Prever {k.label.toLowerCase()}
                      </Button>
                    ))}
                  </span>
                )}
              </div>
              {lines.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {lines.map((f) => (
                    <ForecastLine
                      key={f.requirementId}
                      f={f}
                      manage={manage && active}
                      onEdit={() => {
                        setAdding(null);
                        setEditing(f);
                      }}
                      onCancel={() => setCancelling(f)}
                      onLink={() => setLinking(f)}
                      onLeftover={
                        canLeftover && !f.serviceOrder && f.leftoverDraft
                          ? () =>
                              setLeftover(
                                prefill(
                                  f,
                                  p.description,
                                  f.leftoverDraft!.quantity,
                                  f.leftoverDraft!.purchaseOrders,
                                ),
                              )
                          : null
                      }
                    />
                  ))}
                </ul>
              )}
              {orphans.length > 0 && (
                <ul className="mt-3 space-y-2">
                  {orphans.map((o) => (
                    <OrphanLine
                      key={o.requirementId}
                      o={o}
                      onLeftover={
                        canLeftover && o.receivedExclusive > 0
                          ? () =>
                              setLeftover(
                                prefill(
                                  o,
                                  p.description,
                                  o.receivedExclusive,
                                  o.purchaseOrders.map((x) => x.code),
                                ),
                              )
                          : null
                      }
                    />
                  ))}
                </ul>
              )}
              {adding?.piece === p.orderItemId && (
                <div className="mt-3">
                  <MaterialForm
                    kind={adding.kind}
                    pieces={[]}
                    onCancel={() => setAdding(null)}
                    onSave={(item) =>
                      save.m.mutate(() =>
                        api(`/api/v1/orders/${orderId}/items/${p.orderItemId}/material-forecasts`, {
                          method: 'POST',
                          idempotencyKey: key,
                          body: bodyOf(item),
                        }),
                      )
                    }
                  />
                </div>
              )}
              {editing && editing.orderItemId === p.orderItemId && (
                <div className="mt-3">
                  {!editing.virgin && (
                    <Alert tone="warn" className="mb-2">
                      Esta previsão já tem compra ou outro vínculo: a alteração cria uma nova
                      previsão que substitui a anterior. As compras feitas continuam valendo; nada é
                      cancelado no fornecedor.
                    </Alert>
                  )}
                  <MaterialForm
                    key={editing.requirementId}
                    kind={editing.kind}
                    pieces={[]}
                    initial={draftOf(editing)}
                    onCancel={() => setEditing(null)}
                    onSave={(item) =>
                      save.m.mutate(() =>
                        api(`/api/v1/material-forecasts/${editing.requirementId}`, {
                          method: 'PUT',
                          idempotencyKey: key,
                          body: bodyOf(item),
                        }),
                      )
                    }
                  />
                </div>
              )}
              {lines.length === 0 && orphans.length === 0 && !adding && (
                <p className="mt-1 text-sm text-ink-muted">
                  {p.canForecast
                    ? 'Sem previsão de material.'
                    : 'Peça já em OS: o material vem da medição real.'}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function ForecastLine({
  f,
  manage,
  onEdit,
  onCancel,
  onLink,
  onLeftover,
}: {
  f: Forecast;
  manage: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onLink: () => void;
  onLeftover: (() => void) | null;
}) {
  const preOs = !f.serviceOrder;
  return (
    <li
      className="rounded-xl border border-line px-4 py-3 text-sm"
      data-testid={`forecast-${f.requirementId}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{specText(f)}</span>
        <span className="tabular-nums">· {qtyText(f.need, f.unit)}</span>
        <Badge tone="warn">Previsão — não medido</Badge>
        {preOs ? (
          <Badge tone="info">Pré-chegada</Badge>
        ) : (
          <Link
            href={`/painel/os/${f.serviceOrder!.id}`}
            className="font-mono text-xs font-semibold text-brand-700 hover:underline"
          >
            {f.serviceOrder!.code}
          </Link>
        )}
        {f.pendingLink && <Badge tone="danger">Chegada parcial: vincular à OS</Badge>}
        <StageBadge stage={f.stage} />
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        Comprado {qtyText(f.purchased, f.unit)} · recebido {qtyText(f.received, f.unit)} ·
        aguardando {qtyText(f.awaiting, f.unit)} · falta comprar {qtyText(f.shortfall, f.unit)}
        {f.replaces[0] ? ` · alterada de ${qtyText(f.replaces[0].quantity, f.unit)}` : ''}
      </p>
      {(manage || onLeftover) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {manage && preOs && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Pencil className="size-4" aria-hidden />}
              onClick={onEdit}
            >
              Alterar previsão
            </Button>
          )}
          {manage && f.pendingLink && (
            <Button
              size="sm"
              variant="secondary"
              icon={<Link2 className="size-4" aria-hidden />}
              onClick={onLink}
            >
              Vincular
            </Button>
          )}
          {manage && (
            <Button
              size="sm"
              variant="ghost"
              icon={<X className="size-4" aria-hidden />}
              onClick={onCancel}
            >
              Cancelar previsão
            </Button>
          )}
          {onLeftover && (
            <Button size="sm" variant="secondary" onClick={onLeftover}>
              Registrar sobra
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function OrphanLine({ o, onLeftover }: { o: Orphan; onLeftover: (() => void) | null }) {
  return (
    <li
      className="rounded-xl border border-dashed border-line px-4 py-3 text-sm text-ink-soft"
      data-testid={`forecast-orphan-${o.requirementId}`}
    >
      <span className="font-medium">{specText(o)}</span> · previsão{' '}
      {REQUIREMENT_STATUS_LABEL[o.status].toLowerCase()}
      {o.closeReason ? ` (${o.closeReason})` : ''} — sem necessidade ativa: {orphanFacts(o)}
      {onLeftover && (
        <Button size="sm" variant="secondary" className="ml-2" onClick={onLeftover}>
          Registrar sobra
        </Button>
      )}
    </li>
  );
}

function orphanFacts(o: RequirementOrphanDto) {
  const parts = [
    o.draft > 0 ? `${qtyText(o.draft, o.unit)} em rascunho` : null,
    o.awaiting > 0 ? `${qtyText(o.awaiting, o.unit)} a caminho` : null,
    o.receivedExclusive > 0 ? `${qtyText(o.receivedExclusive, o.unit)} recebido` : null,
  ].filter(Boolean);
  const pos = o.purchaseOrders.map((p) => p.code).join(', ');
  return `${parts.join(' · ') || 'sem saldo'}${pos ? ` (${pos})` : ''}`;
}

function CancelForecastDialog({
  orderId,
  forecast,
  onClose,
}: {
  orderId: string;
  forecast: Forecast;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [key] = useState(newIdempotencyKey);
  const { m, error } = useForecastAction(orderId, 'Previsão cancelada.', onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Cancelar previsão de material?"
      description={`${specText(forecast)} · ${qtyText(forecast.need, forecast.unit)}. Compras já feitas não são canceladas no fornecedor: ficam sem destino para decisão.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            variant="danger"
            loading={m.isPending}
            disabled={reason.trim().length < 3}
            onClick={() =>
              m.mutate(() =>
                api(`/api/v1/material-requirements/${forecast.requirementId}/cancel`, {
                  method: 'POST',
                  idempotencyKey: key,
                  body: { reason },
                }),
              )
            }
          >
            Cancelar previsão
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <Field label="Motivo">
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

/** AB-3: a peça chegou em parte; o gestor escolhe a peça de OS que recebe a previsão. */
function LinkForecastDialog({
  orderId,
  forecast,
  piece,
  onClose,
}: {
  orderId: string;
  forecast: Forecast;
  piece: Piece;
  onClose: () => void;
}) {
  const [si, setSi] = useState(piece.serviceOrderItems[0]?.id ?? '');
  const [key] = useState(newIdempotencyKey);
  const { m, error } = useForecastAction(orderId, 'Previsão vinculada à OS.', onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Vincular previsão à OS"
      description={`${specText(forecast)} · ${qtyText(forecast.need, forecast.unit)}. A peça chegou em parte: escolha a OS que recebe a previsão, as compras e o custo (nada é dividido).`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            loading={m.isPending}
            disabled={!si}
            onClick={() =>
              m.mutate(() =>
                api(`/api/v1/material-forecasts/${forecast.requirementId}/link`, {
                  method: 'POST',
                  idempotencyKey: key,
                  body: { serviceOrderItemId: si },
                }),
              )
            }
          >
            Vincular
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <Field label="Peça da OS">
        {(p) => (
          <Select {...p} value={si} onChange={(e) => setSi(e.target.value)}>
            {piece.serviceOrderItems.map((x) => (
              <option key={x.id} value={x.id}>
                {x.code} · {x.serviceOrder.code} · {x.quantity} un.
              </option>
            ))}
          </Select>
        )}
      </Field>
    </Dialog>
  );
}
