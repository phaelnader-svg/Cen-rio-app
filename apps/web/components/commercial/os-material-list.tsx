'use client';

import { formatCents, type FormalCostRecordDto, type OsMaterialDto } from '@cenario/shared';
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
  const {
    materials,
    summary,
    notice,
    canSeeCosts,
    canReconcile,
    formalRecords,
    pendingReconciliation,
  } = q.data;

  const patch = (m: OsMaterialDto, body: Record<string, unknown>, settled?: () => void) =>
    act.mutate(
      { path: `${base}/${m.id}`, method: 'PATCH', body: { ...body, version: m.version } },
      { onSettled: settled },
    );

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
      {pendingReconciliation && pendingReconciliation.lines > 0 && (
        <p
          className="border-b border-line bg-warn-50 px-4 py-2 text-sm text-warn-600"
          data-testid="os-material-reconcile-notice"
        >
          Conciliação pendente: {pendingReconciliation.lines} material(is) com custo informado e a
          OS também tem compra formal ({formatCents(pendingReconciliation.realizedCents)} no
          realizado). O valor continua contando até o financeiro indicar se é o mesmo material.
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
                  canReconcile={canReconcile && open}
                  formalRecords={formalRecords ?? []}
                  onReconcile={(body) =>
                    act.mutate({
                      path: `${base}/${m.id}/reconcile`,
                      body: { ...body, version: m.version },
                    })
                  }
                  busy={act.isPending}
                  onPatch={(body, settled) => patch(m, body, settled)}
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
  canReconcile,
  formalRecords,
  onReconcile,
  busy,
  onPatch,
  onRemove,
}: {
  m: OsMaterialDto;
  manage: boolean;
  canSeeCosts: boolean;
  canReconcile: boolean;
  formalRecords: FormalCostRecordDto[];
  onReconcile: (body: Record<string, unknown>) => void;
  busy: boolean;
  onPatch: (body: Record<string, unknown>, settled?: () => void) => void;
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
          onChange={(v, settled) => onPatch({ purchased: v }, settled)}
          testId="os-material-purchased"
        />
      </td>
      <td className="px-2 py-2 text-center">
        <Toggle
          label={`Na oficina: ${m.description}`}
          checked={m.available}
          disabled={!manage || busy}
          onChange={(v, settled) => onPatch({ available: v }, settled)}
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
          {m.reconciliation && m.reconciliation.status !== 'NAO_SE_APLICA' && (
            <Reconciliation
              m={m}
              records={formalRecords}
              canReconcile={canReconcile}
              busy={busy}
              onReconcile={onReconcile}
            />
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
  onChange: (v: boolean, settled: () => void) => void;
  testId: string;
}) {
  // Marca na hora (otimista); quando a ação termina (lista já recarregada), vale de novo o que o
  // servidor devolveu — se ele recusar, a caixa volta sozinha ao estado anterior.
  const [local, setLocal] = useState<boolean | null>(null);
  return (
    <input
      type="checkbox"
      aria-label={label}
      data-testid={testId}
      className={clsx(
        'size-5 cursor-pointer rounded border-line-strong accent-brand-700',
        disabled && 'cursor-not-allowed opacity-60',
      )}
      checked={local ?? checked}
      disabled={disabled}
      onChange={(e) => {
        setLocal(e.target.checked);
        onChange(e.target.checked, () => setLocal(null));
      }}
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
      // P1 (Fase 1): linha que quebra em vez de espremer os rótulos numa grade de 12 colunas.
      className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="os-material-add"
    >
      <Input
        aria-label="Novo material"
        placeholder="Material (ex.: Tecido linho bege)"
        className="min-w-56 flex-[3_1_14rem]"
        value={d.description}
        onChange={(e) => setD({ ...d, description: e.target.value })}
      />
      <Input
        aria-label="Quantidade"
        placeholder="Qtd."
        inputMode="decimal"
        className="w-24 flex-none"
        value={d.quantity}
        onChange={(e) => setD({ ...d, quantity: e.target.value })}
      />
      <Input
        aria-label="Unidade"
        placeholder="Unid."
        className="w-24 flex-none"
        value={d.unit}
        onChange={(e) => setD({ ...d, unit: e.target.value })}
      />
      <label className="flex flex-none items-center gap-2 text-sm whitespace-nowrap">
        <input
          type="checkbox"
          className="size-5 accent-brand-700"
          checked={d.purchased}
          onChange={(e) => setD({ ...d, purchased: e.target.checked })}
        />
        Comprado
      </label>
      <label className="flex flex-none items-center gap-2 text-sm whitespace-nowrap">
        <input
          type="checkbox"
          className="size-5 accent-brand-700"
          checked={d.available}
          onChange={(e) => setD({ ...d, available: e.target.checked })}
        />
        Na oficina
      </label>
      {canSeeCosts && (
        <div className="w-44 flex-none" key={key}>
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
        className="flex-none"
        disabled={busy || d.description.trim().length < 2 || !cost.valid}
      >
        <Plus className="size-4" /> Adicionar
      </Button>
    </form>
  );
}

const recordLabel = (r: FormalCostRecordDto) =>
  `${r.kind === 'COMPRA' ? 'Compra' : 'Lançamento'} ${r.reference} · ${r.description}${
    r.amountCents === null ? '' : ` · ${formatCents(r.amountCents)}`
  }`;

/**
 * Conciliação com o custo formal (Fase 1): nada é deduzido por valores iguais. Quem gerencia o
 * financeiro escolhe o registro formal (é o mesmo material → o informado deixa de contar) ou
 * marca como outro material (continua contando). Pode desfazer.
 */
function Reconciliation({
  m,
  records,
  canReconcile,
  busy,
  onReconcile,
}: {
  m: OsMaterialDto;
  records: FormalCostRecordDto[];
  canReconcile: boolean;
  busy: boolean;
  onReconcile: (body: Record<string, unknown>) => void;
}) {
  const r = m.reconciliation!;
  const [choice, setChoice] = useState('');
  return (
    <div className="mt-1 space-y-1 text-xs" data-testid="os-material-reconciliation">
      {r.status === 'PENDENTE' && <Badge tone="warn">Conciliar com a compra formal</Badge>}
      {r.status === 'VINCULADO' && (
        <p className="text-ink-muted">
          <Badge tone="ok">Mesmo material da compra formal</Badge>{' '}
          {r.linked ? recordLabel(r.linked) : ''} — não conta de novo.
        </p>
      )}
      {r.status === 'DISTINTO' && <Badge tone="neutral">Outro material (conta à parte)</Badge>}
      {canReconcile && r.status === 'PENDENTE' && (
        <div className="flex flex-wrap items-center gap-1">
          <select
            aria-label={`Registro formal de ${m.description}`}
            className="h-8 max-w-56 rounded-lg border border-line-strong bg-surface px-2"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
          >
            <option value="">É o mesmo de…</option>
            {records.map((f) => (
              <option key={f.id} value={`${f.kind}:${f.id}`}>
                {recordLabel(f)}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="secondary"
            disabled={!choice || busy}
            onClick={() => {
              const [kind, id] = choice.split(':');
              onReconcile({
                mode: 'VINCULADO',
                ...(kind === 'COMPRA' ? { purchaseItemId: id } : { costId: id }),
              });
            }}
          >
            Vincular
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onReconcile({ mode: 'DISTINTO' })}
          >
            É outro material
          </Button>
        </div>
      )}
      {canReconcile && (r.status === 'VINCULADO' || r.status === 'DISTINTO') && (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onReconcile({ mode: null })}
        >
          Desfazer conciliação
        </Button>
      )}
      {r.reconciledBy && r.reconciledAt && (
        <p className="text-ink-muted">
          por {r.reconciledBy.displayName} em {new Date(r.reconciledAt).toLocaleString('pt-BR')}
        </p>
      )}
    </div>
  );
}
