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
import { Checkbox, Field, Input, Textarea } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { api, newIdempotencyKey } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
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
  return (
    <>
      <PageHeader
        title="Devoluções"
        description="Peças devolvidas ao cliente sem serviço (desistência, cancelamento). O registro é confirmado quando o cliente recebe as peças."
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
  const [search, setSearch] = useState('');
  const pieces = usePieces({ q: search.trim().length >= 2 ? search.trim() : '__nenhum__' });
  const [ids, setIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(today());
  const [key] = useState(newIdempotencyKey);
  const { m, error, setError } = useSend(onClose);
  const list = (pieces.data ?? []).filter((p) => !FINAL.includes(p.stage));
  const chosen = list.filter((p) => ids.includes(p.id));
  const orders = [...new Set(chosen.map((p) => p.orderId))];
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title="Registrar devolução"
      description="Escolha as peças de OS que voltam ao cliente (do mesmo pedido). O recebimento original é preservado."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!chosen.length || reason.trim().length < 3}
            loading={m.isPending}
            onClick={() => {
              if (orders.length !== 1) return setError('Escolha peças de um único pedido.');
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
              m.mutate({
                run: () =>
                  api('/api/v1/returns', {
                    method: 'POST',
                    body: {
                      orderId: orders[0],
                      reason: reason.trim(),
                      returnDate: date,
                      lines: [...lines.values()],
                    },
                    idempotencyKey: key,
                  }),
                ok: 'Devolução registrada.',
              });
            }}
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
        <Field label="Cliente">
          {(f) => (
            <Input
              {...f}
              placeholder="Nome do cliente"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          )}
        </Field>
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
        </div>
        <Field label="Motivo" required>
          {(f) => <Textarea {...f} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <Field label="Data da devolução">
          {(f) => (
            <Input {...f} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          )}
        </Field>
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
