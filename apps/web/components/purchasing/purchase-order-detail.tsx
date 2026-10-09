'use client';

import type { PurchaseOrderDto } from '@cenario/shared';
import { MATERIAL_SOURCING_LABEL, RECEIPT_ISSUE_LABEL, formatCents } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCircle2, PackageCheck, PlusCircle, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { BackLink, Detail, Section } from '@/components/commercial/section';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Alert, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { formatDay } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import { parseDecimal } from '@/lib/measurements';
import { usePurchaseOrder } from '@/lib/purchasing';
import { PurchaseStatusBadge } from './badges';
import { qtyText, specText } from './format';

const HISTORY_LABEL: Record<string, string> = {
  CRIADO: 'Pedido criado (rascunho)',
  ALTERADO: 'Rascunho alterado',
  CONFIRMADO: 'Pedido confirmado',
  CANCELADO: 'Pedido cancelado',
  RECEBIMENTO: 'Recebimento registrado',
  ESTORNO: 'Estorno de recebimento',
  EXCEDENTE_AUTORIZADO: 'Excedente autorizado',
};

function useAction(id: string, success: string, onDone?: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['purchase-order', id] });
      void qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      void qc.invalidateQueries({ queryKey: ['needs'] });
      setError(null);
      toast('ok', success);
      onDone?.();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT')
        void qc.invalidateQueries({ queryKey: ['purchase-order', id] });
      setError(errorMessage(e));
    },
  });
  return { m, error };
}

export function PurchaseOrderDetail({ id }: { id: string }) {
  const can = useCan();
  const q = usePurchaseOrder(id);
  const [dialog, setDialog] = useState<
    | { kind: 'confirm' | 'cancel' | 'close' }
    | { kind: 'extra'; itemId: string; label: string }
    | { kind: 'reverse'; lineId: string; max: number; label: string }
    | null
  >(null);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const po = q.data;
  const receivable = po.status === 'CONFIRMADO' || po.status === 'PARCIALMENTE_RECEBIDO';

  return (
    <>
      <BackLink href="/painel/compras" label="Compras" />
      <PageHeader
        title={`Pedido de compra ${po.code}`}
        description={`${po.supplier?.name ?? 'Fornecedor a definir'} · criado em ${formatDateTime(po.createdAt)}${po.createdBy ? ` por ${po.createdBy}` : ''}`}
        actions={
          <>
            {po.can.confirm && (
              <Button
                icon={<CheckCircle2 className="size-4" aria-hidden />}
                onClick={() => setDialog({ kind: 'confirm' })}
              >
                Confirmar pedido
              </Button>
            )}
            {receivable && (
              <Link
                href={`/painel/recebimento-materiais?pedido=${po.id}`}
                className="inline-flex h-10 items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-[15px] font-semibold hover:bg-subtle"
              >
                <PackageCheck className="size-4" aria-hidden /> Registrar recebimento
              </Link>
            )}
            {po.can.cancel && (
              <Button
                variant="ghost"
                icon={<Ban className="size-4" aria-hidden />}
                onClick={() => setDialog({ kind: 'cancel' })}
              >
                Cancelar pedido
              </Button>
            )}
            {po.can.closeBalance && (
              <Button
                variant="secondary"
                icon={<Ban className="size-4" aria-hidden />}
                onClick={() => setDialog({ kind: 'close' })}
                data-testid="po-close-balance"
              >
                Encerrar saldo pendente
              </Button>
            )}
          </>
        }
      />
      {po.balanceClosedAt && (
        <Alert tone="info" className="mb-4" title="Saldo pendente encerrado">
          {po.balanceCloseReason} — o recebido foi preservado; o restante não será entregue.
        </Alert>
      )}
      <div className="mb-6 flex flex-wrap items-center gap-3" data-testid="po-status">
        <PurchaseStatusBadge status={po.status} />
        {po.hasIssues && (
          <span className="text-sm font-semibold text-danger-600">
            Recebimento com divergência pendente
          </span>
        )}
        {po.expectedDate && (
          <span className="text-sm text-ink-muted">
            Previsto para {formatDay(po.expectedDate, true)}
          </span>
        )}
      </div>
      {po.status === 'CANCELADO' && (
        <Alert
          tone="warn"
          className="mb-6"
          title={`Cancelado em ${formatDateTime(po.cancelledAt)}`}
        >
          {po.cancelReason}
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Section title="Itens" bodyClassName="p-0">
            <ul className="divide-y divide-line" data-testid="po-items">
              {po.items.map((i) => (
                <li key={i.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        {i.position}. {specText(i)}
                      </p>
                      <p className="text-sm text-ink-muted">
                        {MATERIAL_SOURCING_LABEL[i.sourcing]}
                        {i.stockItem ? ` · ${i.stockItem.code}` : ''} · origem:{' '}
                        {i.allocations
                          .map(
                            (a) =>
                              `${a.itemCode ?? a.serviceOrder.code} ${qtyText(a.quantity, i.unit)}`,
                          )
                          .join(' + ') || 'reposição de estoque'}
                      </p>
                    </div>
                    <div className="text-right text-sm">
                      <p className="font-semibold tabular-nums">{qtyText(i.quantity, i.unit)}</p>
                      {i.unitPriceCents !== null && (
                        <p className="text-ink-muted tabular-nums">
                          {formatCents(i.unitPriceCents)}/un. · {formatCents(i.totalCents)}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                    <span>
                      Recebido conforme:{' '}
                      <strong className="tabular-nums">
                        {qtyText(i.receivedQuantity, i.unit)}
                      </strong>
                    </span>
                    <span>
                      Pendente:{' '}
                      <strong className="tabular-nums">{qtyText(i.pendingQuantity, i.unit)}</strong>
                    </span>
                    {i.closedQuantity > 0 && (
                      <span className="text-ink-muted" data-testid="po-item-closed">
                        Saldo encerrado: {qtyText(i.closedQuantity, i.unit)}
                      </span>
                    )}
                    {i.rejectedQuantity > 0 && (
                      <span className="text-danger-600">
                        Com problema: {qtyText(i.rejectedQuantity, i.unit)}
                      </span>
                    )}
                    {i.extraAuthorized > 0 && (
                      <span className="text-ink-muted">
                        Excedente autorizado: {qtyText(i.extraAuthorized, i.unit)}
                      </span>
                    )}
                    {po.can.authorizeExtra && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<PlusCircle className="size-3.5" aria-hidden />}
                        onClick={() =>
                          setDialog({ kind: 'extra', itemId: i.id, label: specText(i) })
                        }
                      >
                        Autorizar excedente
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {po.totalCents !== null && (
              <p className="border-t border-line px-5 py-3 text-right text-sm">
                Total:{' '}
                <strong className="text-base tabular-nums">{formatCents(po.totalCents)}</strong>
              </p>
            )}
          </Section>

          <Section title="Recebimentos" bodyClassName="p-0">
            {po.receipts.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-muted">Nenhum recebimento registrado.</p>
            ) : (
              <ul className="divide-y divide-line" data-testid="po-receipts">
                {po.receipts.map((r) => (
                  <li key={r.id} className="px-5 py-3.5">
                    <p className="text-sm font-semibold">
                      {r.code} · {formatDateTime(r.receivedAt)} · {r.receivedBy}
                    </p>
                    <ul className="mt-1 space-y-1 text-sm">
                      {r.lines.map((l) => {
                        const reversible =
                          Math.round((l.acceptedQuantity - l.reversedQuantity) * 1000) / 1000;
                        return (
                          <li key={l.id} className="flex flex-wrap items-center gap-2">
                            <span className="min-w-0 flex-1">
                              {specText(l, false)}: conforme {qtyText(l.acceptedQuantity, l.unit)}
                              {l.rejectedQuantity > 0 && (
                                <span className="text-danger-600">
                                  {' '}
                                  · com problema {qtyText(l.rejectedQuantity, l.unit)} (
                                  {l.issue ? RECEIPT_ISSUE_LABEL[l.issue] : ''}: {l.issueNote})
                                </span>
                              )}
                              {l.reversals.map((x) => (
                                <span key={x.id} className="block text-xs text-warn-600">
                                  Estorno de {qtyText(x.quantity, l.unit)} em{' '}
                                  {formatDateTime(x.createdAt)} por {x.authorizedBy}: {x.reason}
                                </span>
                              ))}
                            </span>
                            {can('estoque.autorizar') && reversible > 0 && (
                              <Button
                                size="sm"
                                variant="ghost"
                                icon={<Undo2 className="size-3.5" aria-hidden />}
                                onClick={() =>
                                  setDialog({
                                    kind: 'reverse',
                                    lineId: l.id,
                                    max: reversible,
                                    label: specText(l, false),
                                  })
                                }
                              >
                                Estornar
                              </Button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
        <div className="space-y-6">
          <Section title="Dados">
            <dl className="grid gap-3">
              <Detail label="Fornecedor">{po.supplier?.name}</Detail>
              <Detail label="OS vinculadas">
                {po.serviceOrders.map((s) => (
                  <Link
                    key={s.id}
                    href={`/painel/os/${s.id}`}
                    className="mr-2 text-brand-700 hover:underline"
                  >
                    {s.code}
                  </Link>
                ))}
              </Detail>
              <Detail label="Confirmado">
                {po.confirmedAt ? `${formatDateTime(po.confirmedAt)} · ${po.confirmedBy}` : ''}
              </Detail>
              <Detail label="Observações">{po.notes}</Detail>
            </dl>
          </Section>
          <Section title="Histórico" bodyClassName="p-0">
            <ol className="divide-y divide-line" data-testid="po-history">
              {po.history.map((h) => (
                <li key={h.id} className="px-5 py-3">
                  <p className="text-sm font-medium">{HISTORY_LABEL[h.kind] ?? h.kind}</p>
                  {h.note && <p className="text-sm text-ink-soft">{h.note}</p>}
                  <p className="text-xs text-ink-muted">
                    {formatDateTime(h.createdAt)} · {h.actor ?? 'Sistema'}
                  </p>
                </li>
              ))}
            </ol>
          </Section>
        </div>
      </div>

      {dialog?.kind === 'confirm' && <ConfirmDialog po={po} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'cancel' && <CancelDialog po={po} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'close' && (
        <CancelDialog po={po} onClose={() => setDialog(null)} mode="close" />
      )}
      {dialog?.kind === 'extra' && (
        <QuantityReasonDialog
          title="Autorizar recebimento acima do pedido"
          description={dialog.label}
          button="Autorizar"
          onClose={() => setDialog(null)}
          poId={po.id}
          success="Excedente autorizado."
          send={(quantity, reason) =>
            api(`/api/v1/purchase-orders/${po.id}/items/${dialog.itemId}/authorize-extra`, {
              method: 'POST',
              body: { quantity, reason, version: po.version },
            })
          }
        />
      )}
      {dialog?.kind === 'reverse' && (
        <QuantityReasonDialog
          title="Estornar recebimento"
          description={`${dialog.label} — até ${dialog.max}. O recebimento original é preservado; o estorno gera lançamento compensatório.`}
          button="Estornar"
          onClose={() => setDialog(null)}
          poId={po.id}
          success="Estorno registrado."
          send={(quantity, reason) =>
            api(`/api/v1/material-receipts/lines/${dialog.lineId}/reverse`, {
              method: 'POST',
              idempotencyKey: newIdempotencyKey(),
              body: { quantity, reason },
            })
          }
        />
      )}
    </>
  );
}

function ConfirmDialog({ po, onClose }: { po: PurchaseOrderDto; onClose: () => void }) {
  const { m, error } = useAction(po.id, `Pedido ${po.code} confirmado.`, onClose);
  const [key] = useState(newIdempotencyKey);
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Confirmar ${po.code}?`}
      description="O pedido passa a aguardar o recebimento e aparece para a equipe conferir a chegada. Não há pagamento pelo sistema."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            loading={m.isPending}
            onClick={() =>
              m.mutate(() =>
                api(`/api/v1/purchase-orders/${po.id}/confirm`, {
                  method: 'POST',
                  idempotencyKey: key,
                  body: { version: po.version },
                }),
              )
            }
          >
            Confirmar
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="text-sm">
        {po.supplier?.name ?? 'Sem fornecedor'} · {po.itemCount} item(ns) ·{' '}
        <strong>{formatCents(po.totalCents)}</strong>
      </p>
    </Dialog>
  );
}

/** Cancelar o pedido ou (Fase 12) encerrar o saldo que não será entregue. */
function CancelDialog({
  po,
  onClose,
  mode = 'cancel',
}: {
  po: PurchaseOrderDto;
  onClose: () => void;
  mode?: 'cancel' | 'close';
}) {
  const close = mode === 'close';
  const { m, error } = useAction(
    po.id,
    close ? `Saldo pendente de ${po.code} encerrado.` : `Pedido ${po.code} cancelado.`,
    onClose,
  );
  const [key] = useState(newIdempotencyKey);
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={close ? `Encerrar o saldo pendente de ${po.code}?` : `Cancelar ${po.code}?`}
      description={
        close
          ? 'O que já foi recebido continua valendo (estoque e custos). Só o pendente deixa de ser esperado e volta a aparecer como necessidade de compra.'
          : 'Os materiais voltam a aparecer como pendentes de compra.'
      }
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
                api(`/api/v1/purchase-orders/${po.id}/${close ? 'close-balance' : 'cancel'}`, {
                  method: 'POST',
                  body: { reason, version: po.version },
                  ...(close ? { idempotencyKey: key } : {}),
                }),
              )
            }
          >
            {close ? 'Encerrar saldo' : 'Cancelar pedido'}
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
          <Textarea {...p} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        )}
      </Field>
    </Dialog>
  );
}

function QuantityReasonDialog({
  title,
  description,
  button,
  success,
  poId,
  send,
  onClose,
}: {
  title: string;
  description: string;
  button: string;
  success: string;
  poId: string;
  send: (quantity: number, reason: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const { m, error } = useAction(poId, success, onClose);
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            loading={m.isPending}
            disabled={!(parseDecimal(quantity) > 0) || reason.trim().length < 3}
            onClick={() => m.mutate(() => send(parseDecimal(quantity), reason))}
          >
            {button}
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
        <Field label="Quantidade">
          {(p) => (
            <Input
              {...p}
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
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
