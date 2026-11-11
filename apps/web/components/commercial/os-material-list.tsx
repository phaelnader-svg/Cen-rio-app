'use client';

import { formatCents, type OsMaterialDto } from '@cenario/shared';
import clsx from 'clsx';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { MoneyInput } from '@/components/commercial/money-input';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Alert, Badge, EmptyState, Spinner } from '@/components/ui/misc';
import { useCan } from '@/lib/hooks';
import { osMaterialListKey, useAction, useOsMaterialList } from '@/lib/simple-materials';

/**
 * Reformulação, Fase 1 — "Materiais necessários" da OS.
 *
 * Tudo na própria lista, sem telas extras: "Comprado" e "Na oficina" são marcados com um clique e
 * são independentes; o custo é opcional (em branco = não informado, nunca zero) e só aparece para
 * quem vê o financeiro. Nada aqui trava a produção, cria compra formal ou mexe no estoque.
 */
export function OsMaterialList({
  serviceOrderId,
  open,
}: {
  serviceOrderId: string;
  open: boolean;
}) {
  const can = useCan();
  const q = useOsMaterialList(serviceOrderId);
  const manage = open && can('os.gerenciar');
  const base = `/api/v1/service-orders/${serviceOrderId}/material-list`;
  const act = useAction([osMaterialListKey(serviceOrderId), ['fin']]);

  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const { materials, summary, notice, canSeeCosts } = q.data;

  const patch = (m: OsMaterialDto, body: Record<string, unknown>) =>
    act.mutate({ path: `${base}/${m.id}`, method: 'PATCH', body: { ...body, version: m.version } });

  return (
    <section className="rounded-xl border border-line" data-testid="os-material-list">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h3 className="text-base font-semibold">Materiais necessários</h3>
        <div className="flex flex-wrap gap-2 text-xs" data-testid="os-material-summary">
          <Badge tone="neutral">{summary.total} material(is)</Badge>
          <Badge tone={summary.purchased === summary.total ? 'ok' : 'neutral'}>
            {summary.purchased} comprado(s)
          </Badge>
          <Badge tone={summary.available === summary.total ? 'ok' : 'neutral'}>
            {summary.available} na oficina
          </Badge>
        </div>
      </header>
      {notice && (
        <p
          className="border-b border-line bg-warn-50 px-4 py-2 text-sm text-warn-600"
          data-testid="os-material-notice"
        >
          {notice} A produção pode começar mesmo assim.
        </p>
      )}
      {act.error && (
        <Alert tone="danger" className="m-3">
          {act.error}
        </Alert>
      )}
      {materials.length === 0 ? (
        <EmptyState
          title="Nenhum material listado"
          description="Liste aqui o que a OS precisa. Não é obrigatório para iniciar a produção."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium">Material</th>
                <th className="px-2 py-2 text-center font-medium">Comprado</th>
                <th className="px-2 py-2 text-center font-medium">Na oficina</th>
                {canSeeCosts && <th className="px-2 py-2 font-medium">Custo</th>}
                {manage && <th className="w-24 px-2 py-2" />}
              </tr>
            </thead>
            <tbody>
              {materials.map((m) => (
                <MaterialRow
                  key={m.id}
                  m={m}
                  manage={manage}
                  canSeeCosts={canSeeCosts}
                  busy={act.isPending}
                  onPatch={(body) => patch(m, body)}
                  onRemove={() =>
                    act.mutate({ path: `${base}/${m.id}/remove`, body: { version: m.version } })
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {manage && (
        <AddMaterial
          canSeeCosts={canSeeCosts}
          busy={act.isPending}
          onAdd={(body, done) => act.mutate({ path: base, body }, { onSuccess: done })}
        />
      )}
    </section>
  );
}

function qtyLabel(m: Pick<OsMaterialDto, 'quantity' | 'unit'>) {
  if (m.quantity === null) return m.unit ?? '';
  return `${m.quantity.toLocaleString('pt-BR', { maximumFractionDigits: 3 })}${m.unit ? ` ${m.unit}` : ''}`;
}

function MaterialRow({
  m,
  manage,
  canSeeCosts,
  busy,
  onPatch,
  onRemove,
}: {
  m: OsMaterialDto;
  manage: boolean;
  canSeeCosts: boolean;
  busy: boolean;
  onPatch: (body: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [draft, setDraft] = useState({
    description: m.description,
    quantity: m.quantity === null ? '' : String(m.quantity),
    unit: m.unit ?? '',
    notes: m.notes ?? '',
  });
  const [cost, setCost] = useState<{ cents: number | null; valid: boolean }>({
    cents: m.costCents ?? null,
    valid: true,
  });

  const saveCost = () => {
    if (!cost.valid || cost.cents === (m.costCents ?? null)) return;
    onPatch({ costCents: cost.cents });
  };

  return (
    <tr className="border-b border-line last:border-0" data-testid="os-material-row">
      <td className="px-4 py-2">
        {editing ? (
          <div className="grid gap-2 sm:grid-cols-6">
            <Input
              aria-label="Material"
              className="sm:col-span-3"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
            <Input
              aria-label="Quantidade"
              inputMode="decimal"
              value={draft.quantity}
              onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
            />
            <Input
              aria-label="Unidade"
              value={draft.unit}
              onChange={(e) => setDraft({ ...draft, unit: e.target.value })}
            />
            <div className="flex gap-1">
              <Button
                size="sm"
                aria-label="Salvar"
                disabled={busy}
                onClick={() => {
                  const quantity = draft.quantity.trim()
                    ? Number(draft.quantity.replace(',', '.'))
                    : null;
                  onPatch({
                    description: draft.description,
                    quantity,
                    unit: draft.unit,
                    notes: draft.notes,
                  });
                  setEditing(false);
                }}
              >
                <Check className="size-4" />
              </Button>
              <Button
                size="sm"
                variant="secondary"
                aria-label="Cancelar"
                onClick={() => setEditing(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
            <Input
              aria-label="Observações"
              placeholder="Observações (opcional)"
              className="sm:col-span-6"
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </div>
        ) : (
          <>
            <p className="font-medium">
              {m.description}
              {(m.quantity !== null || m.unit) && (
                <span className="font-normal text-ink-soft"> — {qtyLabel(m)}</span>
              )}
            </p>
            {(m.categoryName || m.inventoryItemName || m.notes) && (
              <p className="text-xs text-ink-muted">
                {[m.categoryName, m.inventoryItemName && `estoque: ${m.inventoryItemName}`, m.notes]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
          </>
        )}
      </td>
      <td className="px-2 py-2 text-center">
        <Toggle
          label={`Comprado: ${m.description}`}
          checked={m.purchased}
          disabled={!manage || busy}
          onChange={(v) => onPatch({ purchased: v })}
          testId="os-material-purchased"
        />
      </td>
      <td className="px-2 py-2 text-center">
        <Toggle
          label={`Na oficina: ${m.description}`}
          checked={m.available}
          disabled={!manage || busy}
          onChange={(v) => onPatch({ available: v })}
          testId="os-material-available"
        />
      </td>
      {canSeeCosts && (
        <td className="w-40 px-2 py-2">
          {manage ? (
            <MoneyInput
              aria-label={`Custo: ${m.description}`}
              placeholder="não informado"
              cents={m.costCents ?? null}
              onCents={(cents, valid) => setCost({ cents, valid })}
              onKeyDown={(e) => e.key === 'Enter' && saveCost()}
              onBlurCapture={saveCost}
              data-testid="os-material-cost"
            />
          ) : (
            <span className="tabular-nums">
              {m.costCents === null || m.costCents === undefined ? (
                <span className="text-ink-muted">não informado</span>
              ) : (
                formatCents(m.costCents)
              )}
            </span>
          )}
        </td>
      )}
      {manage && (
        <td className="px-2 py-2 text-right whitespace-nowrap">
          {confirmRemove ? (
            <span className="inline-flex gap-1">
              <Button size="sm" variant="danger" disabled={busy} onClick={onRemove}>
                Remover
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirmRemove(false)}>
                Manter
              </Button>
            </span>
          ) : (
            <span className="inline-flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                aria-label="Editar"
                onClick={() => setEditing(true)}
              >
                <Pencil className="size-4" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Remover"
                onClick={() => setConfirmRemove(true)}
              >
                <Trash2 className="size-4" />
              </Button>
            </span>
          )}
        </td>
      )}
    </tr>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
  testId,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
  testId: string;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      data-testid={testId}
      className={clsx(
        'size-5 cursor-pointer rounded border-line-strong accent-brand-700',
        disabled && 'cursor-not-allowed opacity-60',
      )}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function AddMaterial({
  canSeeCosts,
  busy,
  onAdd,
}: {
  canSeeCosts: boolean;
  busy: boolean;
  onAdd: (body: Record<string, unknown>, done: () => void) => void;
}) {
  const empty = { description: '', quantity: '', unit: '', purchased: false, available: false };
  const [d, setD] = useState(empty);
  const [cost, setCost] = useState<{ cents: number | null; valid: boolean }>({
    cents: null,
    valid: true,
  });
  const [key, setKey] = useState(0);
  const submit = () => {
    if (d.description.trim().length < 2 || !cost.valid) return;
    onAdd(
      {
        description: d.description,
        quantity: d.quantity.trim() ? Number(d.quantity.replace(',', '.')) : null,
        unit: d.unit,
        purchased: d.purchased,
        available: d.available,
        ...(canSeeCosts && cost.cents !== null ? { costCents: cost.cents } : {}),
      },
      () => {
        setD(empty);
        setCost({ cents: null, valid: true });
        setKey((k) => k + 1);
      },
    );
  };
  return (
    <form
      className="grid items-end gap-2 border-t border-line px-4 py-3 sm:grid-cols-12"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="os-material-add"
    >
      <Input
        aria-label="Novo material"
        placeholder="Material (ex.: Tecido linho bege)"
        className="sm:col-span-4"
        value={d.description}
        onChange={(e) => setD({ ...d, description: e.target.value })}
      />
      <Input
        aria-label="Quantidade"
        placeholder="Qtd."
        inputMode="decimal"
        className="sm:col-span-1"
        value={d.quantity}
        onChange={(e) => setD({ ...d, quantity: e.target.value })}
      />
      <Input
        aria-label="Unidade"
        placeholder="Unid."
        className="sm:col-span-1"
        value={d.unit}
        onChange={(e) => setD({ ...d, unit: e.target.value })}
      />
      <label className="flex items-center gap-2 text-sm sm:col-span-1">
        <input
          type="checkbox"
          className="size-5 accent-brand-700"
          checked={d.purchased}
          onChange={(e) => setD({ ...d, purchased: e.target.checked })}
        />
        Comprado
      </label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input
          type="checkbox"
          className="size-5 accent-brand-700"
          checked={d.available}
          onChange={(e) => setD({ ...d, available: e.target.checked })}
        />
        Na oficina
      </label>
      {canSeeCosts && (
        <div className="sm:col-span-2" key={key}>
          <MoneyInput
            aria-label="Custo (opcional)"
            placeholder="custo (opcional)"
            cents={null}
            onCents={(cents, valid) => setCost({ cents, valid })}
          />
        </div>
      )}
      <Button
        type="submit"
        className={canSeeCosts ? 'sm:col-span-1' : 'sm:col-span-3'}
        disabled={busy || d.description.trim().length < 2 || !cost.valid}
      >
        <Plus className="size-4" /> Adicionar
      </Button>
    </form>
  );
}
