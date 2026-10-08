'use client';

import type { MaterialReceiptDto, PendingMaterialReceiptDto, ReceiptIssue } from '@cenario/shared';
import { MATERIAL_SOURCING_LABEL, RECEIPT_ISSUES, RECEIPT_ISSUE_LABEL } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, ChevronRight, PackageCheck, Truck } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert, Card, EmptyState, Spinner } from '@/components/ui/misc';
import { api, errorMessage, fieldErrors, newIdempotencyKey } from '@/lib/api';
import { formatDay } from '@/lib/commercial';
import { parseDecimal } from '@/lib/measurements';
import { usePendingReceipts } from '@/lib/purchasing';
import { qtyText, specText } from './format';

interface LineState {
  accepted: string;
  rejected: string;
  issue: ReceiptIssue | '';
  issueNote: string;
  checked: boolean;
}

/**
 * Recebimento de materiais: qualquer funcionário confere e registra o que chegou.
 * Sem preços. Só o recebido conforme fica disponível; problemas viram divergência.
 */
export function MaterialReceiving({
  large,
  initialId,
}: {
  large?: boolean;
  initialId?: string | null;
}) {
  const pending = usePendingReceipts();
  const [selected, setSelected] = useState<string | null>(initialId ?? null);
  const [done, setDone] = useState<MaterialReceiptDto | null>(null);
  if (pending.isPending) return <Spinner />;
  if (pending.isError) return <Alert tone="danger">{pending.error.message}</Alert>;

  if (done) {
    return (
      <div
        className="rounded-2xl border border-ok-600/20 bg-ok-50 p-8 text-center"
        data-testid="material-receipt-done"
      >
        <CheckCircle2 className="mx-auto size-12 text-ok-600" aria-hidden />
        <p className={clsx('mt-3 font-semibold', large ? 'text-2xl' : 'text-xl')}>
          Recebimento {done.code} registrado
        </p>
        <p className="mt-1 text-ink-soft">
          {done.lines.filter((l) => l.issue).length
            ? 'As divergências foram enviadas ao gestor.'
            : 'O gestor já vê o material recebido.'}
        </p>
        <Button
          size={large ? 'xl' : 'lg'}
          className="mt-6"
          onClick={() => {
            setDone(null);
            setSelected(null);
          }}
        >
          Voltar aos pedidos
        </Button>
      </div>
    );
  }

  const po = pending.data.find((p) => p.id === selected);
  if (po) {
    return (
      <ReceiveForm
        key={po.id}
        po={po}
        large={large}
        onDone={setDone}
        onBack={() => setSelected(null)}
      />
    );
  }
  if (pending.data.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Truck className="size-6" aria-hidden />}
          title="Nenhum material aguardando chegada"
          description="Pedidos de compra confirmados pelo gestor aparecem aqui."
        />
      </Card>
    );
  }
  return (
    <ul className={clsx('grid gap-4', large && 'lg:grid-cols-2')} data-testid="pending-receipts">
      {pending.data.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            onClick={() => setSelected(p.id)}
            data-testid={`pending-${p.code}`}
            className="flex w-full items-center gap-4 rounded-2xl border border-line bg-surface p-5 text-left shadow-[var(--shadow-card)] transition hover:border-brand-200 active:scale-[0.99]"
          >
            <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-brand-50 text-brand-700">
              <PackageCheck className="size-7" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className={clsx('block font-semibold', large ? 'text-xl' : 'text-lg')}>
                {p.code} · {p.supplierName ?? 'Fornecedor'}
              </span>
              <span className="mt-0.5 block text-ink-muted">
                {p.items.filter((i) => i.remaining > 0).length} item(ns) a receber
                {p.expectedDate ? ` · previsto ${formatDay(p.expectedDate)}` : ''}
              </span>
              <span className="mt-1 block truncate text-sm text-ink-soft">
                {p.items.map((i) => i.description).join(', ')}
              </span>
            </span>
            <ChevronRight className="size-6 text-ink-muted" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

function ReceiveForm({
  po,
  large,
  onDone,
  onBack,
}: {
  po: PendingMaterialReceiptDto;
  large?: boolean;
  onDone: (r: MaterialReceiptDto) => void;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const open = po.items.filter((i) => i.remaining > 0);
  const [state, setState] = useState<Record<string, LineState>>(() =>
    Object.fromEntries(
      open.map((i) => [
        i.id,
        { accepted: '', rejected: '', issue: '', issueNote: '', checked: false },
      ]),
    ),
  );
  const [key] = useState(newIdempotencyKey);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (id: string, patch: Partial<LineState>) =>
    setState((s) => ({ ...s, [id]: { ...s[id]!, ...patch } }));
  const inputCls = large ? 'h-14 text-lg' : undefined;

  const lines = open
    .map((i) => {
      const s = state[i.id]!;
      const accepted = s.accepted.trim() ? parseDecimal(s.accepted) : 0;
      const rejected = s.rejected.trim() ? parseDecimal(s.rejected) : 0;
      return { i, s, accepted, rejected };
    })
    .filter(
      (l) =>
        l.accepted > 0 || l.rejected > 0 || Number.isNaN(l.accepted) || Number.isNaN(l.rejected),
    );

  const save = useMutation({
    mutationFn: () => {
      if (lines.length === 0)
        throw new Error('Informe a quantidade recebida de ao menos um material.');
      for (const l of lines) {
        if (Number.isNaN(l.accepted) || Number.isNaN(l.rejected))
          throw new Error(`Quantidade inválida em ${l.i.description}.`);
        if (l.accepted > 0 && !l.s.checked)
          throw new Error(`Confirme a conferência de ${l.i.description}.`);
      }
      return api<MaterialReceiptDto>('/api/v1/material-receipts', {
        method: 'POST',
        idempotencyKey: key,
        body: {
          purchaseOrderId: po.id,
          lines: lines.map((l) => ({
            purchaseOrderItemId: l.i.id,
            acceptedQuantity: l.accepted,
            rejectedQuantity: l.rejected,
            specConfirmed: l.s.checked,
            issue: l.s.issue || null,
            issueNote: l.s.issueNote,
          })),
        },
      });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['pending-receipts'] });
      onDone(r);
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      setError(e instanceof Error ? e.message : errorMessage(e));
    },
  });

  return (
    <div data-testid="receive-form">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className={clsx('flex-1 font-semibold', large ? 'text-2xl' : 'text-xl')}>
          {po.code} · {po.supplierName}
        </h2>
        <Button variant="ghost" size={large ? 'lg' : 'md'} onClick={onBack}>
          Escolher outro pedido
        </Button>
      </div>
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
          {Object.values(errors)[0] ? ` ${Object.values(errors)[0]}` : ''}
        </Alert>
      )}
      <ul className="space-y-4">
        {open.map((i) => {
          const s = state[i.id]!;
          const problem = s.rejected.trim() !== '' && parseDecimal(s.rejected) > 0;
          return (
            <li
              key={i.id}
              className="rounded-2xl border border-line bg-surface p-5"
              data-testid={`receive-item-${i.description}`}
            >
              <p className={clsx('font-semibold', large ? 'text-xl' : 'text-lg')}>{specText(i)}</p>
              <p className="mt-0.5 text-ink-muted">
                {MATERIAL_SOURCING_LABEL[i.sourcing]}
                {i.serviceOrder
                  ? ` · ${i.serviceOrder.code}`
                  : i.destinations.length
                    ? ` · para ${i.destinations.join(', ')}`
                    : ''}
                {' · '}pedido {qtyText(i.quantity, i.unit)} · já recebido{' '}
                {qtyText(i.receivedQuantity, i.unit)} ·{' '}
                <strong className="text-ink">falta {qtyText(i.remaining, i.unit)}</strong>
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <Field label="Recebido em ordem">
                  {(p) => (
                    <Input
                      {...p}
                      className={inputCls}
                      inputMode="decimal"
                      value={s.accepted}
                      onChange={(e) => set(i.id, { accepted: e.target.value })}
                      placeholder={String(i.remaining).replace('.', ',')}
                    />
                  )}
                </Field>
                <Field label="Com problema (não usar)">
                  {(p) => (
                    <Input
                      {...p}
                      className={inputCls}
                      inputMode="decimal"
                      value={s.rejected}
                      onChange={(e) => set(i.id, { rejected: e.target.value })}
                      placeholder="0"
                    />
                  )}
                </Field>
                {problem && (
                  <>
                    <Field label="Tipo de problema">
                      {(p) => (
                        <Select
                          {...p}
                          className={inputCls}
                          value={s.issue}
                          onChange={(e) => set(i.id, { issue: e.target.value as ReceiptIssue })}
                        >
                          <option value="">Selecione…</option>
                          {RECEIPT_ISSUES.map((x) => (
                            <option key={x} value={x}>
                              {RECEIPT_ISSUE_LABEL[x]}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label="O que aconteceu">
                      {(p) => (
                        <Input
                          {...p}
                          className={inputCls}
                          value={s.issueNote}
                          onChange={(e) => set(i.id, { issueNote: e.target.value })}
                        />
                      )}
                    </Field>
                  </>
                )}
              </div>
              <label
                className={clsx(
                  'mt-4 flex cursor-pointer items-center gap-3 rounded-xl bg-subtle px-4',
                  large ? 'py-4 text-lg' : 'py-3',
                )}
              >
                <input
                  type="checkbox"
                  className={clsx('accent-brand-700', large ? 'size-7' : 'size-5')}
                  checked={s.checked}
                  onChange={(e) => set(i.id, { checked: e.target.checked })}
                />
                Conferi referência, cor e especificação
              </label>
            </li>
          );
        })}
      </ul>
      <div
        className={clsx(
          'mt-6 flex justify-end',
          large && 'sticky bottom-0 bg-canvas/95 py-4 backdrop-blur',
        )}
      >
        <Button
          size={large ? 'xl' : 'lg'}
          loading={save.isPending}
          icon={<PackageCheck className="size-5" aria-hidden />}
          onClick={() => save.mutate()}
        >
          Confirmar recebimento
        </Button>
      </div>
    </div>
  );
}
