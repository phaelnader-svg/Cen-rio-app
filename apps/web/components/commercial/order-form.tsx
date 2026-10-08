'use client';

import type { CustomerSummaryDto, OrderDto, PieceType } from '@cenario/shared';
import {
  PIECE_TYPES,
  PIECE_TYPE_LABEL,
  createOrderSchema,
  updateOrderSchema,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useDeferredValue, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, Card, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, fieldErrors, newIdempotencyKey } from '@/lib/api';
import { useCustomerAddresses, useCustomerLookup } from '@/lib/commercial';
import { useCan } from '@/lib/hooks';
import { addressLines } from './address-form';
import { MoneyInput } from './money-input';

interface ItemRow {
  key: string;
  id?: string;
  pieceType: PieceType;
  description: string;
  quantity: string;
  notes: string;
  locked?: number;
}

const newRow = (): ItemRow => ({
  key: crypto.randomUUID(),
  pieceType: 'SOFA',
  description: '',
  quantity: '1',
  notes: '',
});

export function OrderForm({
  order,
  initialCustomer,
}: {
  order?: OrderDto;
  initialCustomer?: CustomerSummaryDto | null;
}) {
  const can = useCan();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const canValues = can('pedidos.valores');
  const [customer, setCustomer] = useState<CustomerSummaryDto | null>(
    order?.customer ?? initialCustomer ?? null,
  );
  const [search, setSearch] = useState('');
  const lookup = useCustomerLookup(useDeferredValue(search), !customer && !order);
  const addresses = useCustomerAddresses(customer?.id ?? null);
  const [addressId, setAddressId] = useState<string>(order?.pickupAddressId ?? '');
  const [service, setService] = useState(order?.contractedService ?? '');
  const [description, setDescription] = useState(order?.description ?? '');
  const [value, setValue] = useState<number | null>(order?.agreedValueCents ?? null);
  const [valueValid, setValueValid] = useState(true);
  const [terms, setTerms] = useState(order?.paymentTerms ?? '');
  const [notes, setNotes] = useState(order?.notes ?? '');
  const [items, setItems] = useState<ItemRow[]>(
    order
      ? order.items.map((i) => ({
          key: i.id,
          id: i.id,
          pieceType: i.pieceType,
          description: i.description,
          quantity: String(i.quantity),
          notes: i.notes ?? '',
          locked: Math.max(i.receivedQuantity + i.inActivePickups, i.inServiceOrders),
        }))
      : [newRow()],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const idem = useRef(newIdempotencyKey());

  const effectiveAddress =
    addressId || (!order ? (addresses.data?.find((a) => a.isPrimary)?.id ?? '') : '');

  const m = useMutation({
    mutationFn: async () => {
      if (!valueValid) throw new Error('Valor negociado inválido.');
      const base = {
        pickupAddressId: effectiveAddress || null,
        contractedService: service,
        description,
        agreedValueCents: canValues ? value : null,
        paymentTerms: canValues ? terms : null,
        notes,
        items: items.map((i) => ({
          ...(i.id ? { id: i.id } : {}),
          pieceType: i.pieceType,
          description: i.description,
          quantity: Number(i.quantity),
          notes: i.notes,
        })),
      };
      if (order) {
        const body = updateOrderSchema.parse({ ...base, version: order.version });
        return api<OrderDto>(`/api/v1/orders/${order.id}`, { method: 'PUT', body });
      }
      if (!customer) throw new Error('Selecione o cliente.');
      const body = createOrderSchema.parse({ ...base, customerId: customer.id });
      return api<OrderDto>('/api/v1/orders', {
        method: 'POST',
        body,
        idempotencyKey: idem.current,
      });
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ['orders'] });
      qc.setQueryData(['order', saved.id], saved);
      toast('ok', order ? 'Pedido atualizado.' : `Pedido ${saved.code} criado.`);
      router.push(`/painel/pedidos/${saved.id}`);
    },
    onError: (e) => {
      idem.current = newIdempotencyKey();
      const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
      if (issues) {
        const map: Record<string, string> = {};
        for (const i of issues) map[i.path.map(String).join('.')] ??= i.message;
        setErrors(map);
        setError('Revise os campos destacados.');
        return;
      }
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT')
        void qc.invalidateQueries({ queryKey: ['order', order?.id] });
      setErrors(fieldErrors(e));
      setError(e instanceof Error ? e.message : 'Erro');
    },
  });

  const setItem = (key: string, patch: Partial<ItemRow>) =>
    setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  return (
    <form
      noValidate
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        m.mutate();
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <Card className="p-6">
        <h2 className="mb-4 font-semibold">Cliente e retirada</h2>
        {customer ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="font-medium" data-testid="order-customer">
              {customer.name}
            </p>
            {!order && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCustomer(null);
                  setAddressId('');
                }}
              >
                Trocar cliente
              </Button>
            )}
          </div>
        ) : (
          <div>
            <label className="relative block max-w-lg">
              <span className="label">Buscar cliente</span>
              <Search
                className="pointer-events-none absolute bottom-3 left-3 size-4 text-ink-muted"
                aria-hidden
              />
              <Input
                className="pl-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Nome do cliente"
                autoFocus
              />
            </label>
            {lookup.isFetching && <Spinner className="mt-2" />}
            <ul
              className="mt-2 max-w-lg divide-y divide-line rounded-xl border border-line"
              aria-label="Clientes encontrados"
            >
              {lookup.data?.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="w-full px-4 py-2.5 text-left hover:bg-subtle"
                    onClick={() => setCustomer(c)}
                  >
                    {c.name}
                    {c.tradeName ? <span className="text-ink-muted"> · {c.tradeName}</span> : null}
                  </button>
                </li>
              ))}
              {lookup.data?.length === 0 && (
                <li className="px-4 py-2.5 text-sm text-ink-muted">Nenhum cliente encontrado.</li>
              )}
            </ul>
          </div>
        )}
        {customer && (
          <Field
            label="Endereço da retirada"
            className="mt-4 max-w-2xl"
            error={errors.pickupAddressId}
          >
            {(p) => (
              <Select
                {...p}
                value={effectiveAddress}
                onChange={(e) => setAddressId(e.target.value)}
              >
                <option value="">
                  {order?.pickupAddress ? `Manter: ${order.pickupAddress.label}` : 'Definir depois'}
                </option>
                {addresses.data?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label} — {addressLines(a).replace('\n', ' · ')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 font-semibold">Serviço contratado</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <Field
            label="Serviço contratado"
            error={errors.contractedService}
            required
            className="lg:col-span-2"
          >
            {(p) => (
              <Input
                {...p}
                value={service}
                onChange={(e) => setService(e.target.value)}
                placeholder="Ex.: Reforma completa com troca de tecido e espuma"
              />
            )}
          </Field>
          <Field label="Descrição preliminar" error={errors.description} className="lg:col-span-2">
            {(p) => (
              <Textarea
                {...p}
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            )}
          </Field>
          {canValues ? (
            <>
              <Field
                label="Valor negociado"
                error={!valueValid ? 'Valor inválido.' : errors.agreedValueCents}
              >
                {(p) => (
                  <MoneyInput
                    {...p}
                    cents={value}
                    onCents={(v, ok) => {
                      setValue(v);
                      setValueValid(ok);
                    }}
                  />
                )}
              </Field>
              <Field label="Condições comerciais" error={errors.paymentTerms}>
                {(p) => (
                  <Input
                    {...p}
                    value={terms}
                    onChange={(e) => setTerms(e.target.value)}
                    placeholder="Ex.: 50% na retirada, 50% na entrega"
                  />
                )}
              </Field>
            </>
          ) : (
            <Alert tone="info" className="lg:col-span-2">
              Valores e condições comerciais são visíveis apenas para quem tem permissão.
            </Alert>
          )}
          <Field label="Observações" error={errors.notes} className="lg:col-span-2">
            {(p) => (
              <Textarea {...p} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            )}
          </Field>
        </div>
      </Card>

      <Card className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Peças</h2>
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus className="size-3.5" aria-hidden />}
            onClick={() => setItems([...items, newRow()])}
          >
            Adicionar peça
          </Button>
        </div>
        {errors.items && <p className="mb-2 text-sm text-danger-600">{errors.items}</p>}
        <ol className="space-y-3">
          {items.map((it, idx) => (
            <li
              key={it.key}
              className="grid gap-3 rounded-xl border border-line p-4 sm:grid-cols-[180px_1fr_110px_auto] sm:items-end"
              data-testid={`order-item-${idx}`}
            >
              <Field label={`Tipo da peça ${idx + 1}`}>
                {(p) => (
                  <Select
                    {...p}
                    value={it.pieceType}
                    onChange={(e) => setItem(it.key, { pieceType: e.target.value as PieceType })}
                  >
                    {PIECE_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {PIECE_TYPE_LABEL[t]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Descrição" error={errors[`items.${idx}.description`]}>
                {(p) => (
                  <Input
                    {...p}
                    value={it.description}
                    onChange={(e) => setItem(it.key, { description: e.target.value })}
                    placeholder="Ex.: Sofá 3 lugares retrátil"
                  />
                )}
              </Field>
              <Field
                label="Quantidade"
                error={errors[`items.${idx}.quantity`]}
                hint={it.locked ? `mín. ${it.locked}` : undefined}
              >
                {(p) => (
                  <Input
                    {...p}
                    type="number"
                    min={Math.max(1, it.locked ?? 1)}
                    value={it.quantity}
                    onChange={(e) => setItem(it.key, { quantity: e.target.value })}
                  />
                )}
              </Field>
              <Button
                variant="ghost"
                aria-label={`Remover peça ${idx + 1}`}
                disabled={items.length === 1 || Boolean(it.locked)}
                title={it.locked ? 'Peça já em retirada ou recebida' : undefined}
                onClick={() => setItems(items.filter((x) => x.key !== it.key))}
                icon={<Trash2 className="size-4" aria-hidden />}
              />
              <Field label="Observações da peça" className="sm:col-span-4">
                {(p) => (
                  <Input
                    {...p}
                    value={it.notes}
                    onChange={(e) => setItem(it.key, { notes: e.target.value })}
                  />
                )}
              </Field>
            </li>
          ))}
        </ol>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => router.back()}>
          Cancelar
        </Button>
        <Button type="submit" size="lg" loading={m.isPending} disabled={!customer}>
          {order ? 'Salvar alterações' : 'Criar pedido'}
        </Button>
      </div>
    </form>
  );
}
