'use client';

import type { PieceCondition, ReceiptDto } from '@cenario/shared';
import {
  PIECE_CONDITIONS,
  PIECE_CONDITION_LABEL,
  PICKUP_STATUS_LABEL,
  createReceiptSchema,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardPlus } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { formatDay, usePendingReceipts, type PendingReceiptOrder } from '@/lib/commercial';
import { useCan, useMe } from '@/lib/hooks';
import { useEmployees } from '@/lib/queries';
import { PhotoGallery } from './photo-gallery';
import { BackLink } from './section';

function nowLocal(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function NewReceiptPage() {
  const params = useSearchParams();
  const can = useCan();
  const pending = usePendingReceipts(can('recebimentos.registrar'));
  const [orderId, setOrderId] = useState(params.get('pedido') ?? '');
  const [done, setDone] = useState<ReceiptDto | null>(null);
  const order = pending.data?.find((o) => o.id === orderId);

  if (!can('recebimentos.registrar'))
    return <Alert tone="warn">Você não tem permissão para registrar recebimentos.</Alert>;
  if (done) return <ReceiptDone receipt={done} />;
  return (
    <>
      <BackLink href="/painel/recebimentos" label="Recebimentos" />
      <PageHeader
        title="Registrar recebimento"
        description="Confira as peças que chegaram à oficina. Pode ser parcial: o restante continua pendente."
      />
      {pending.isPending ? (
        <Spinner />
      ) : !order ? (
        <Card className="p-6">
          {pending.data?.length ? (
            <Field label="Pedido">
              {(p) => (
                <Select {...p} value={orderId} onChange={(e) => setOrderId(e.target.value)}>
                  <option value="">Selecione o pedido…</option>
                  {pending.data.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.code} — {o.customer.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : (
            <EmptyState title="Nenhum pedido com peças pendentes de recebimento" />
          )}
          {orderId && !order && (
            <Alert tone="warn" className="mt-3">
              Este pedido não tem peças pendentes de recebimento.
            </Alert>
          )}
        </Card>
      ) : (
        <ReceiptForm
          key={order.id}
          order={order}
          initialPickup={params.get('retirada')}
          onDone={setDone}
        />
      )}
    </>
  );
}

interface Line {
  quantity: string;
  condition: PieceCondition;
  conditionNotes: string;
  location: string;
}

function ReceiptForm({
  order,
  initialPickup,
  onDone,
}: {
  order: PendingReceiptOrder;
  initialPickup: string | null;
  onDone: (r: ReceiptDto) => void;
}) {
  const qc = useQueryClient();
  const can = useCan();
  const me = useMe();
  const employees = useEmployees(can('funcionarios.ver'));
  const validPickup = order.pickups.find((p) => p.id === initialPickup) ?? order.pickups[0];
  const [origin, setOrigin] = useState<'RETIRADA' | 'ENTREGUE_PELO_CLIENTE'>(
    validPickup ? 'RETIRADA' : 'ENTREGUE_PELO_CLIENTE',
  );
  const [pickupId, setPickupId] = useState(validPickup?.id ?? '');
  const [receivedAt, setReceivedAt] = useState(nowLocal());
  const [receivedBy, setReceivedBy] = useState('');
  const [divergences, setDivergences] = useState('');
  const [notes, setNotes] = useState('');
  const pickup = order.pickups.find((p) => p.id === pickupId);
  const defaultQty = (itemId: string, pendingQty: number) => {
    if (origin === 'RETIRADA' && pickup)
      return Math.min(
        pendingQty,
        pickup.items.find((i) => i.orderItemId === itemId)?.quantity ?? 0,
      );
    return pendingQty;
  };
  const [lines, setLines] = useState<Record<string, Line>>(() =>
    Object.fromEntries(
      order.items.map((i) => [
        i.id,
        {
          quantity: String(defaultQty(i.id, i.pending)),
          condition: 'BOA' as PieceCondition,
          conditionNotes: '',
          location: 'Área de recebimento',
        },
      ]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const idem = useRef(newIdempotencyKey());
  const setLine = (id: string, patch: Partial<Line>) =>
    setLines((l) => ({ ...l, [id]: { ...l[id]!, ...patch } }));

  const m = useMutation({
    mutationFn: () => {
      const body = createReceiptSchema.parse({
        orderId: order.id,
        origin,
        pickupId: origin === 'RETIRADA' ? pickupId || null : null,
        receivedAt: new Date(receivedAt).toISOString(),
        ...(receivedBy ? { receivedByEmployeeId: receivedBy } : {}),
        divergences,
        notes,
        lines: order.items
          .map((i) => ({
            orderItemId: i.id,
            ...lines[i.id]!,
            quantity: Number(lines[i.id]!.quantity),
          }))
          .filter((l) => l.quantity > 0),
      });
      return api<ReceiptDto>('/api/v1/receipts', {
        method: 'POST',
        body,
        idempotencyKey: idem.current,
      });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['receipts-pending'] });
      void qc.invalidateQueries({ queryKey: ['receipts'] });
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
      onDone(r);
    },
    onError: (e) => {
      // Erro de regra/validação: nova tentativa é uma nova intenção.
      if (e instanceof ApiError && e.status !== 0) idem.current = newIdempotencyKey();
      setError(
        e instanceof ApiError
          ? e.message
          : ((e as { issues?: { message: string }[] }).issues?.[0]?.message ?? 'Revise os dados.'),
      );
    },
  });

  return (
    <form
      className="space-y-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        m.mutate();
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <Card className="p-6">
        <p className="mb-4 text-lg font-semibold">
          {order.code} · {order.customer.name}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Origem">
            {(p) => (
              <Select
                {...p}
                value={origin}
                onChange={(e) => setOrigin(e.target.value as typeof origin)}
              >
                <option value="RETIRADA" disabled={order.pickups.length === 0}>
                  Retirada pela logística
                </option>
                <option value="ENTREGUE_PELO_CLIENTE">Entregue pelo cliente</option>
              </Select>
            )}
          </Field>
          {origin === 'RETIRADA' && (
            <Field label="Retirada">
              {(p) => (
                <Select {...p} value={pickupId} onChange={(e) => setPickupId(e.target.value)}>
                  {order.pickups.map((pk) => (
                    <option key={pk.id} value={pk.id}>
                      {pk.code} — {PICKUP_STATUS_LABEL[pk.status as 'AGENDADA']}
                      {pk.scheduledDate ? ` (${formatDay(pk.scheduledDate)})` : ''}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="Data e hora da chegada">
            {(p) => (
              <Input
                {...p}
                type="datetime-local"
                value={receivedAt}
                max={nowLocal()}
                onChange={(e) => setReceivedAt(e.target.value)}
              />
            )}
          </Field>
          <Field label="Responsável pelo recebimento">
            {(p) => (
              <Select {...p} value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)}>
                <option value="">
                  {me.data?.employee?.displayName ?? 'Eu'} (quem está registrando)
                </option>
                {employees.data
                  ?.filter((e) => e.active && e.id !== me.data?.employee?.id)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.displayName}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="mb-1 font-semibold">Conferência das peças</h2>
        <p className="mb-4 text-sm text-ink-muted">Informe 0 para peças que não chegaram.</p>
        <ul className="space-y-3">
          {order.items.map((i) => {
            const l = lines[i.id]!;
            return (
              <li
                key={i.id}
                className="grid gap-3 rounded-xl border border-line p-4 sm:grid-cols-[1fr_110px_200px]"
                data-testid={`receipt-line-${i.description}`}
              >
                <div>
                  <p className="font-medium">{i.description}</p>
                  <p className="text-sm text-ink-muted">
                    {i.receivedQuantity} de {i.quantity} já recebida(s) · {i.pending} pendente(s)
                  </p>
                </div>
                <Field label="Recebidas agora">
                  {(p) => (
                    <Input
                      {...p}
                      type="number"
                      min={0}
                      max={i.pending}
                      value={l.quantity}
                      onChange={(e) => setLine(i.id, { quantity: e.target.value })}
                    />
                  )}
                </Field>
                <Field label="Condição física">
                  {(p) => (
                    <Select
                      {...p}
                      value={l.condition}
                      onChange={(e) =>
                        setLine(i.id, { condition: e.target.value as PieceCondition })
                      }
                    >
                      {PIECE_CONDITIONS.map((c) => (
                        <option key={c} value={c}>
                          {PIECE_CONDITION_LABEL[c]}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Localização inicial na oficina" className="sm:col-span-1">
                  {(p) => (
                    <Input
                      {...p}
                      value={l.location}
                      onChange={(e) => setLine(i.id, { location: e.target.value })}
                    />
                  )}
                </Field>
                <Field label="Observações da condição" className="sm:col-span-2">
                  {(p) => (
                    <Input
                      {...p}
                      value={l.conditionNotes}
                      onChange={(e) => setLine(i.id, { conditionNotes: e.target.value })}
                      placeholder="Avarias, manchas, peças faltando…"
                    />
                  )}
                </Field>
              </li>
            );
          })}
        </ul>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Divergências em relação ao pedido">
            {(p) => (
              <Textarea
                {...p}
                rows={2}
                value={divergences}
                onChange={(e) => setDivergences(e.target.value)}
              />
            )}
          </Field>
          <Field label="Observações">
            {(p) => (
              <Textarea {...p} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            )}
          </Field>
        </div>
      </Card>
      <div className="flex justify-end">
        <Button type="submit" size="lg" loading={m.isPending}>
          Confirmar recebimento
        </Button>
      </div>
    </form>
  );
}

function ReceiptDone({ receipt }: { receipt: ReceiptDto }) {
  const can = useCan();
  return (
    <>
      <BackLink href="/painel/recebimentos" label="Recebimentos" />
      <Card className="p-6">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 size-6 text-ok-600" aria-hidden />
          <div>
            <h1 className="text-xl font-semibold" data-testid="receipt-done">
              Recebimento {receipt.code} registrado
            </h1>
            <p className="text-ink-muted">
              {receipt.lines.map((l) => `${l.quantity}× ${l.description}`).join(' · ')} — pedido{' '}
              {receipt.order.code}
            </p>
          </div>
        </div>
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold">Fotografias da chegada</h2>
          <PhotoGallery entityType="RECEIPT" entityId={receipt.id} canManage />
        </div>
        <div className="mt-6 flex flex-wrap gap-2">
          {can('os.gerenciar') && (
            <Link
              href={`/painel/os/nova?pedido=${receipt.order.id}`}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-700 px-4 font-semibold text-white hover:bg-brand-800"
            >
              <ClipboardPlus className="size-4" aria-hidden /> Criar OS técnica
            </Link>
          )}
          {can('pedidos.ver') && (
            <Link
              href={`/painel/pedidos/${receipt.order.id}`}
              className="inline-flex h-10 items-center rounded-xl border border-line-strong px-4 font-semibold hover:bg-subtle"
            >
              Ver pedido
            </Link>
          )}
        </div>
      </Card>
    </>
  );
}
