'use client';

import type { PurchaseNeedDto, PurchaseOrderDto, PurchaseShortageDto } from '@cenario/shared';
import { MATERIAL_SOURCING_LABEL, formatCents, lineTotalCents, specKey } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShoppingCart } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { MoneyInput } from '@/components/commercial/money-input';
import { BackLink, Section } from '@/components/commercial/section';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { decimalText, parseDecimal } from '@/lib/measurements';
import { useNeeds, useShortages, useSuppliers } from '@/lib/purchasing';
import { qtyText, specText } from './format';

interface Line {
  key: string;
  sourcing: PurchaseNeedDto['sourcing'];
  spec: PurchaseNeedDto;
  allocations: { requirementId: string; label: string; quantity: number }[];
  quantity: string;
  priceCents: number | null;
  /** Estoque: quanto da falta já é atendido por estoque livre / compra de estoque pendente. */
  offset?: { free: number; pending: number };
  /** Estoque com desconto: faltas de origem (as alocações saem delas, por prazo, até a quantidade). */
  pending?: { requirementId: string; label: string; quantity: number }[];
  stockItemId?: string | null;
}

/** Distribui a quantidade comprada entre as origens, na ordem (prazo), sem passar de cada falta. */
function distribute(pending: NonNullable<Line['pending']>, quantity: number) {
  let left = quantity;
  const out: Line['allocations'] = [];
  for (const p of pending) {
    const q = Math.round(Math.min(p.quantity, Math.max(0, left)) * 1000) / 1000;
    if (q <= 0) break;
    out.push({ ...p, quantity: q });
    left -= q;
  }
  return out;
}

const stockKey = (n: PurchaseNeedDto) => `E|${specKey({ ...n, color: null, reference: null })}`;

/**
 * Tecidos e exclusivos: uma linha por OS. Comuns iguais: uma linha consolidada com as origens e a
 * quantidade SUGERIDA (falta − estoque livre − compra de estoque pendente), editável.
 */
function buildLines(needs: PurchaseNeedDto[], shortages: PurchaseShortageDto[] = []): Line[] {
  const lines = new Map<string, Line>();
  for (const n of needs) {
    if (n.pendingToBuy <= 0) continue;
    const alloc = {
      requirementId: n.requirementId,
      label: `${n.serviceOrder.code}${n.itemCode ? ` (${n.itemCode})` : ''}`,
      quantity: n.pendingToBuy,
    };
    const key =
      n.sourcing === 'EXCLUSIVO_OS'
        ? n.requirementId
        : specKey({ ...n, color: null, reference: null });
    const cur = lines.get(key);
    if (cur) {
      cur.allocations.push(alloc);
      cur.quantity = decimalText(
        Math.round((parseDecimal(cur.quantity) + n.pendingToBuy) * 1000) / 1000,
      );
    } else {
      lines.set(key, {
        key,
        sourcing: n.sourcing,
        spec: n,
        allocations: [alloc],
        quantity: decimalText(n.pendingToBuy),
        priceCents: null,
      });
    }
  }
  for (const l of lines.values()) {
    if (l.sourcing !== 'ESTOQUE') continue;
    const g = shortages.find((x) => x.key === stockKey(l.spec));
    if (!g) continue;
    const free = Math.max(0, g.freeStock ?? 0);
    const pending = Math.max(0, g.freePending);
    if (free + pending <= 0) continue;
    const wanted = parseDecimal(l.quantity);
    const qty = Math.max(0, Math.round((wanted - free - pending) * 1000) / 1000);
    l.offset = { free, pending };
    l.pending = l.allocations;
    l.stockItemId = g.stockItem?.id ?? null;
    l.allocations = distribute(l.pending, qty);
    l.quantity = decimalText(qty);
  }
  return [...lines.values()];
}

export function NewPurchaseOrderPage() {
  const params = useSearchParams();
  const ids = useMemo(
    () => new Set((params.get('req') ?? '').split(',').filter(Boolean)),
    [params],
  );
  const needs = useNeeds(false);
  const shortages = useShortages();
  if (needs.isPending || shortages.isPending) return <Spinner />;
  if (needs.isError) return <Alert tone="danger">{needs.error.message}</Alert>;
  const chosen = needs.data.filter((n) => ids.has(n.requirementId));
  return (
    <>
      <BackLink href="/painel/compras" label="Compras" />
      <PageHeader
        title="Novo pedido de compra"
        description="O pedido nasce como rascunho. Somente o gestor confirma e envia ao fornecedor."
      />
      {chosen.length === 0 ? (
        <EmptyState
          icon={<ShoppingCart className="size-6" aria-hidden />}
          title="Nenhum material selecionado"
          description="Selecione os materiais na central de compras."
          action={
            <Link href="/painel/compras" className="text-brand-700 hover:underline">
              Ir para Compras
            </Link>
          }
        />
      ) : (
        <PurchaseForm initial={buildLines(chosen, shortages.data ?? [])} />
      )}
    </>
  );
}

function PurchaseForm({ initial }: { initial: Line[] }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const suppliers = useSuppliers();
  const [lines, setLines] = useState(initial);
  const [supplierId, setSupplierId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [key] = useState(newIdempotencyKey);
  const [error, setError] = useState<string | null>(null);

  const total = lines.reduce(
    (s, l) => s + (lineTotalCents(parseDecimal(l.quantity) || 0, l.priceCents) ?? 0),
    0,
  );
  const set = (k: string, patch: Partial<Line>) =>
    setLines((ls) =>
      ls.map((l) => {
        if (l.key !== k) return l;
        const next = { ...l, ...patch };
        // Estoque com desconto: a quantidade comprada define quanto vai para cada OS.
        if (patch.quantity !== undefined && l.pending)
          next.allocations = distribute(l.pending, parseDecimal(patch.quantity) || 0);
        return next;
      }),
    );

  const save = useMutation({
    mutationFn: () =>
      api<PurchaseOrderDto>('/api/v1/purchase-orders', {
        method: 'POST',
        idempotencyKey: key,
        body: {
          supplierId: supplierId || null,
          expectedDate: expectedDate || null,
          notes,
          items: lines.map((l) => ({
            sourcing: l.sourcing,
            ...(l.stockItemId ? { stockItemId: l.stockItemId } : {}),
            allocations: l.allocations.map((a) => ({
              materialRequirementId: a.requirementId,
              quantity: a.quantity,
            })),
            quantity: parseDecimal(l.quantity),
            unitPriceCents: l.priceCents,
          })),
        },
      }),
    onSuccess: (po) => {
      void qc.invalidateQueries({ queryKey: ['needs'] });
      void qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      toast('ok', `Pedido ${po.code} criado (rascunho).`);
      router.push(`/painel/compras/${po.id}`);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <div className="space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}
      <Section title="Fornecedor e entrega">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Fornecedor" hint="Obrigatório para confirmar o pedido.">
            {(p) => (
              <Select {...p} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">A definir</option>
                {suppliers.data
                  ?.filter((s) => s.active)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label="Recebimento previsto">
            {(p) => (
              <Input
                {...p}
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
              />
            )}
          </Field>
          <Field label="Observações" className="sm:col-span-3">
            {(p) => (
              <Textarea {...p} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            )}
          </Field>
        </div>
      </Section>
      <Section title="Itens" bodyClassName="p-0">
        <ul className="divide-y divide-line" data-testid="po-lines">
          {lines.map((l, i) => (
            <li
              key={l.key}
              className="grid gap-3 px-5 py-4 lg:grid-cols-[1fr_9rem_11rem_8rem]"
              data-testid={`po-line-${i + 1}`}
            >
              <div>
                <p className="font-medium">{specText(l.spec)}</p>
                <p className="text-sm text-ink-muted">
                  {MATERIAL_SOURCING_LABEL[l.sourcing]} · origem:{' '}
                  {l.allocations
                    .map((a) => `${a.label} ${qtyText(a.quantity, l.spec.unit)}`)
                    .join(' + ') || 'estoque (sem OS de destino)'}
                </p>
                {l.offset && (
                  <p className="text-sm text-ink-muted" data-testid={`po-line-offset-${i + 1}`}>
                    Quantidade sugerida já desconta{' '}
                    {l.offset.free > 0
                      ? `estoque livre ${qtyText(l.offset.free, l.spec.unit)}`
                      : ''}
                    {l.offset.free > 0 && l.offset.pending > 0 ? ' e ' : ''}
                    {l.offset.pending > 0
                      ? `compra de estoque pendente ${qtyText(l.offset.pending, l.spec.unit)}`
                      : ''}
                    . O estoque livre não fica reservado: use “Reservar” em A comprar.
                  </p>
                )}
              </div>
              <Field label={`Quantidade (${qtyText(0, l.spec.unit).replace(/^0 /, '')})`}>
                {(p) => (
                  <Input
                    {...p}
                    inputMode="decimal"
                    value={l.quantity}
                    onChange={(e) => set(l.key, { quantity: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Preço unitário">
                {(p) => (
                  <MoneyInput
                    {...p}
                    cents={l.priceCents}
                    onCents={(v) => set(l.key, { priceCents: v })}
                  />
                )}
              </Field>
              <div className="self-end pb-2 text-right">
                <span className="block text-xs text-ink-muted">Total</span>
                <span className="font-semibold tabular-nums">
                  {formatCents(lineTotalCents(parseDecimal(l.quantity) || 0, l.priceCents))}
                </span>
              </div>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center justify-end gap-4 border-t border-line px-5 py-4">
          <span className="text-sm text-ink-muted">
            Total do pedido:{' '}
            <strong className="text-lg text-ink tabular-nums" data-testid="po-total">
              {formatCents(total)}
            </strong>
          </span>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Salvar rascunho
          </Button>
        </div>
      </Section>
    </div>
  );
}
