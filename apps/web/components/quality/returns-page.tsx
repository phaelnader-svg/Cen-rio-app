'use client';

import type { PieceReturnDto, ReceiptLineDto } from '@cenario/shared';
import {
  FULFILLMENT_STAGE_LABEL,
  RETURN_STATUS_LABEL,
  type FulfillmentStage,
} from '@cenario/shared';
import { Plus, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { useSend } from '@/components/production/use-send';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { api, newIdempotencyKey } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useOrder, useOrders } from '@/lib/commercial';
import { useEmployees } from '@/lib/queries';
import { usePieces, useReturns } from '@/lib/quality';

const FINAL: FulfillmentStage[] = ['ENTREGUE', 'DEVOLVIDA'];
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

/**
 * Fase 10 — devolução de peças ao cliente (motivo, responsável, data e confirmação). O
 * recebimento original nunca é apagado; tarefas, inspeções, embalagens e entregas da peça são
 * encerradas na confirmação; OS sem nenhuma peça restante é cancelada com a proteção da Fase 5.
 */
export function ReturnsPage() {
  const q = useReturns();
  const [create, setCreate] = useState(false);
  const [confirm, setConfirm] = useState<PieceReturnDto | null>(null);
  const [cancel, setCancel] = useState<PieceReturnDto | null>(null);
  const [detail, setDetail] = useState<PieceReturnDto | null>(null);
  return (
    <>
      <PageHeader
        title="Devoluções"
        description="Peças devolvidas ao cliente sem serviço (desistência, cancelamento) — de OS ou avulsas. O registro é confirmado quando o cliente recebe as peças."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setCreate(true)}>
            Registrar devolução
          </Button>
        }
      />
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : !q.data.length ? (
        <Card>
          <EmptyState icon={<Undo2 className="size-6" />} title="Nenhuma devolução registrada" />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line" data-testid="returns-list">
            {q.data.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5 text-sm"
                data-testid={`return-${r.code}`}
              >
                <span className="w-24 font-mono font-semibold">{r.code}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {r.order.code} · {r.order.customer} — {r.reason}
                  </p>
                  <p className="text-ink-muted">
                    {r.lines
                      .map(
                        (l) =>
                          `${l.quantity}× ${l.description}${l.serviceOrderItems.length ? ` (${l.serviceOrderItems.map((s) => s.code).join(', ')})` : ''}`,
                      )
                      .join(' · ')}
                    {' · '}
                    {r.returnDate.split('-').reverse().join('/')} ·{' '}
                    {r.responsible?.displayName ?? '—'}
                    {r.confirmedAt
                      ? ` · confirmada ${formatDateTime(r.confirmedAt)} por ${r.confirmedBy}: ${r.confirmationNote}`
                      : ''}
                    {r.cancelReason ? ` · cancelada: ${r.cancelReason}` : ''}
                    {r.destination ? ` · destino: ${r.destination}` : ''}
                  </p>
                </div>
                <Badge
                  tone={
                    r.status === 'CONFIRMADA'
                      ? 'ok'
                      : r.status === 'REGISTRADA'
                        ? 'warn'
                        : 'neutral'
                  }
                >
                  {RETURN_STATUS_LABEL[r.status]}
                </Badge>
                <Button size="sm" variant="secondary" onClick={() => setDetail(r)}>
                  Detalhes
                </Button>
                {r.status === 'REGISTRADA' && (
                  <>
                    <Button size="sm" onClick={() => setConfirm(r)}>
                      Confirmar entrega ao cliente
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setCancel(r)}>
                      Cancelar
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {create && <CreateReturnDialog onClose={() => setCreate(false)} />}
      {detail && (
        <ReturnDetailDialog
          r={q.data?.find((x) => x.id === detail.id) ?? detail}
          onClose={() => setDetail(null)}
        />
      )}
      {confirm && (
        <TextDialog
          title={`Confirmar ${confirm.code}`}
          label="Confirmação (quem recebeu, como)"
          onClose={() => setConfirm(null)}
          run={(note) =>
            api(`/api/v1/returns/${confirm.id}/confirm`, {
              method: 'POST',
              body: { note, version: confirm.version },
              idempotencyKey: newIdempotencyKey(),
            })
          }
        />
      )}
      {cancel && (
        <TextDialog
          title={`Cancelar ${cancel.code}`}
          label="Motivo"
          onClose={() => setCancel(null)}
          run={(reason) =>
            api(`/api/v1/returns/${cancel.id}/cancel`, {
              method: 'POST',
              body: { reason, version: cancel.version },
            })
          }
        />
      )}
    </>
  );
}

function TextDialog({
  title,
  label,
  run,
  onClose,
}: {
  title: string;
  label: string;
  run: (t: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const { m, error } = useSend(onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <Button
          disabled={text.trim().length < 3}
          loading={m.isPending}
          onClick={() => m.mutate({ run: () => run(text.trim()), ok: 'Registrado.' })}
        >
          Confirmar
        </Button>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <Field label={label} required>
        {(f) => <Textarea {...f} value={text} onChange={(e) => setText(e.target.value)} />}
      </Field>
    </Dialog>
  );
}

function CreateReturnDialog({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<'os' | 'avulsa'>('os');
  const [search, setSearch] = useState('');
  const term = search.trim().length >= 2 ? search.trim() : '__nenhum__';
  const pieces = usePieces({ q: mode === 'os' ? term : '__nenhum__' });
  const orders = useOrders({ q: term }, mode === 'avulsa');
  const [orderId, setOrderId] = useState<string | null>(null);
  const order = useOrder(mode === 'avulsa' ? orderId : null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [ids, setIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [destination, setDestination] = useState('');
  const [responsible, setResponsible] = useState('');
  const employees = useEmployees();
  const [date, setDate] = useState(today());
  const [key] = useState(newIdempotencyKey);
  const { m, error, setError } = useSend(onClose);
  const list = (pieces.data ?? []).filter((p) => !FINAL.includes(p.stage));
  const chosen = list.filter((p) => ids.includes(p.id));
  const chosenOrders = [...new Set(chosen.map((p) => p.orderId))];
  // Peças avulsas: recebidas, fora de OS ativa e ainda não devolvidas.
  const loose = (order.data?.items ?? []).map((i) => ({
    ...i,
    available: Math.max(0, i.receivedQuantity - i.inServiceOrders - i.returnedQuantity),
  }));
  const looseLines = loose
    .map((i) => ({ orderItemId: i.id, quantity: Number(qty[i.id] || 0), max: i.available }))
    .filter((l) => l.quantity > 0);

  function submit() {
    let body: Record<string, unknown>;
    if (mode === 'os') {
      if (chosenOrders.length !== 1) return setError('Escolha peças de um único pedido.');
      const lines = new Map<
        string,
        { orderItemId: string; quantity: number; serviceOrderItemIds: string[] }
      >();
      for (const p of chosen) {
        const l = lines.get(p.orderItemId) ?? {
          orderItemId: p.orderItemId,
          quantity: 0,
          serviceOrderItemIds: [],
        };
        l.quantity += p.quantity;
        l.serviceOrderItemIds.push(p.id);
        lines.set(p.orderItemId, l);
      }
      body = { orderId: chosenOrders[0], lines: [...lines.values()] };
    } else {
      if (!orderId || !looseLines.length) return setError('Escolha o pedido e as quantidades.');
      const over = looseLines.find((l) => l.quantity > l.max || !Number.isInteger(l.quantity));
      if (over) return setError('Quantidade acima do disponível para devolução.');
      body = {
        orderId,
        lines: looseLines.map((l) => ({ orderItemId: l.orderItemId, quantity: l.quantity })),
      };
    }
    m.mutate({
      run: () =>
        api('/api/v1/returns', {
          method: 'POST',
          body: {
            ...body,
            reason: reason.trim(),
            returnDate: date,
            destination: destination.trim() || null,
            responsibleUserId: responsible || null,
          },
          idempotencyKey: key,
        }),
      ok: 'Devolução registrada.',
    });
  }

  const ready = mode === 'os' ? chosen.length > 0 : looseLines.length > 0;
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title="Registrar devolução"
      description="Peças que voltam ao cliente sem serviço. O recebimento original é preservado; a confirmação libera reservas e valores das peças devolvidas (o que já foi executado vai para revisão do gestor)."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!ready || reason.trim().length < 3}
            loading={m.isPending}
            onClick={submit}
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
      <div className="grid gap-3">
        <div className="flex gap-2" role="radiogroup" aria-label="Tipo de devolução">
          <Button
            size="sm"
            variant={mode === 'os' ? 'primary' : 'secondary'}
            aria-pressed={mode === 'os'}
            onClick={() => setMode('os')}
          >
            Peças de OS
          </Button>
          <Button
            size="sm"
            variant={mode === 'avulsa' ? 'primary' : 'secondary'}
            aria-pressed={mode === 'avulsa'}
            onClick={() => setMode('avulsa')}
            data-testid="return-mode-loose"
          >
            Peças avulsas (sem OS)
          </Button>
        </div>
        <Field label={mode === 'os' ? 'Cliente' : 'Cliente ou pedido'}>
          {(f) => (
            <Input
              {...f}
              placeholder="Digite ao menos 2 letras"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          )}
        </Field>
        {mode === 'os' ? (
          <div className="grid gap-1">
            {list.map((p) => (
              <Checkbox
                key={p.id}
                label={`${p.code} · ${p.description} (${p.quantity}) — ${FULFILLMENT_STAGE_LABEL[p.stage]} · ${p.customer}`}
                checked={ids.includes(p.id)}
                onChange={(e) =>
                  setIds((x) => (e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id)))
                }
              />
            ))}
            {term !== '__nenhum__' && !list.length && (
              <p className="text-sm text-ink-muted">Nenhuma peça de OS encontrada.</p>
            )}
          </div>
        ) : (
          <>
            <Field label="Pedido">
              {(f) => (
                <Select
                  {...f}
                  value={orderId ?? ''}
                  onChange={(e) => {
                    setOrderId(e.target.value || null);
                    setQty({});
                  }}
                  data-testid="return-order"
                >
                  <option value="">Escolha o pedido…</option>
                  {(orders.data?.items ?? []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.code} — {o.customer.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {orderId && (
              <div className="grid gap-2">
                {loose.map((i) => (
                  <div key={i.id} className="flex items-center gap-3 text-sm">
                    <span className="flex-1">
                      {i.description} — disponível para devolução: <strong>{i.available}</strong>
                    </span>
                    <Input
                      className="w-24"
                      type="number"
                      min={0}
                      max={i.available}
                      aria-label={`Quantidade de ${i.description}`}
                      disabled={i.available === 0}
                      value={qty[i.id] ?? ''}
                      onChange={(e) => setQty((q) => ({ ...q, [i.id]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        <Field label="Motivo" required>
          {(f) => <Textarea {...f} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Destino">
            {(f) => (
              <Input
                {...f}
                placeholder="Ex.: entregue no endereço do cliente"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
              />
            )}
          </Field>
          <Field label="Responsável">
            {(f) => (
              <Select {...f} value={responsible} onChange={(e) => setResponsible(e.target.value)}>
                <option value="">Eu</option>
                {(employees.data ?? [])
                  .filter((e) => e.userId && e.active)
                  .map((e) => (
                    <option key={e.userId!} value={e.userId!}>
                      {e.displayName}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label="Data da devolução">
            {(f) => (
              <Input {...f} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            )}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

/** Detalhe da devolução: destino, histórico e o que ficou para o gestor revisar. */
function ReturnDetailDialog({ r, onClose }: { r: PieceReturnDto; onClose: () => void }) {
  return (
    <Dialog open size="lg" onClose={onClose} title={`${r.code} — ${r.order.customer}`}>
      <div className="space-y-4 text-sm" data-testid="return-detail">
        <p>
          {r.order.code} · {r.reason} · {r.returnDate.split('-').reverse().join('/')} · responsável:{' '}
          {r.responsible?.displayName ?? '—'}
        </p>
        <p>
          <strong>Destino:</strong> {r.destination ?? 'não informado'}
        </p>
        {(r.review.reservations.length > 0 || r.review.laborToReview > 0) && (
          <Alert tone="warn" title="Revisão do gestor">
            <ul className="list-disc space-y-0.5 pl-4">
              {r.review.reservations.map((x) => (
                <li key={x.id}>
                  {x.serviceOrder}: reserva de {x.quantity} × {x.material} sem peça definida —
                  libere em Estoque se não for mais necessária.
                </li>
              ))}
              {r.review.laborToReview > 0 && (
                <li>
                  {r.review.laborToReview} valor(es) de produção com trabalho executado ou valor
                  devido — revise em Financeiro → Produção e equipe.
                </li>
              )}
            </ul>
          </Alert>
        )}
        <div>
          <h3 className="mb-1 font-semibold">Histórico</h3>
          <ul className="space-y-1 text-xs text-ink-muted">
            {r.history.map((h) => (
              <li key={h.id}>
                {formatDateTime(h.createdAt)} · {h.summary}
                {h.actor ? ` (${h.actor})` : ''}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Dialog>
  );
}

/** Correção auditável de uma linha de recebimento (o registro original não muda). */
export function ReceiptCorrectionButton({ line }: { line: ReceiptLineDto }) {
  const [open, setOpen] = useState(false);
  const [quantity, setQuantity] = useState(String(line.correctedQuantity ?? line.quantity));
  const [reason, setReason] = useState('');
  const [key] = useState(newIdempotencyKey);
  const { m, error } = useSend(() => setOpen(false));
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Corrigir
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Corrigir recebimento — ${line.description}`}
        description={`Recebido originalmente: ${line.quantity}. A correção fica no histórico; peças em OS ativa ou devolvidas não podem ficar sem cobertura.`}
        footer={
          <Button
            disabled={reason.trim().length < 5}
            loading={m.isPending}
            onClick={() =>
              m.mutate({
                run: () =>
                  api(`/api/v1/receipt-lines/${line.id}/corrections`, {
                    method: 'POST',
                    body: { newQuantity: Number(quantity), reason: reason.trim() },
                    idempotencyKey: key,
                  }),
                ok: 'Recebimento corrigido.',
              })
            }
          >
            Salvar correção
          </Button>
        }
      >
        {error && (
          <Alert tone="danger" className="mb-3">
            {error}
          </Alert>
        )}
        <div className="grid gap-3">
          <Field label="Quantidade correta">
            {(f) => (
              <Input
                {...f}
                type="number"
                min={0}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            )}
          </Field>
          <Field label="Justificativa" required>
            {(f) => <Textarea {...f} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        </div>
      </Dialog>
    </>
  );
}
