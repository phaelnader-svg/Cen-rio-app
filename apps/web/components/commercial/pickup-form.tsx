'use client';

import type { OrderDto, PickupDto } from '@cenario/shared';
import {
  PICKUP_TEAMS,
  PICKUP_TEAM_LABEL,
  createPickupSchema,
  updatePickupSchema,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, fieldErrors, newIdempotencyKey } from '@/lib/api';
import { useCustomerAddresses } from '@/lib/commercial';
import { addressLines } from './address-form';
import { TripCostFields, type TripCostValue } from '@/components/finance/trip-cost';

/** Solicitar (a partir do pedido) ou editar/reagendar uma retirada. */
export function PickupForm({
  order,
  pickup,
  onClose,
}: {
  order: OrderDto;
  pickup?: PickupDto;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const addresses = useCustomerAddresses(order.customer.id);
  const [addressId, setAddressId] = useState('');
  const [date, setDate] = useState(pickup?.scheduledDate ?? '');
  const [start, setStart] = useState(pickup?.windowStart ?? '');
  const [end, setEnd] = useState(pickup?.windowEnd ?? '');
  const [team, setTeam] = useState<(typeof PICKUP_TEAMS)[number]>(
    pickup?.team ?? 'LOGISTICA_TERCEIRIZADA',
  );
  const [teamNotes, setTeamNotes] = useState(pickup?.teamNotes ?? '');
  const [instructions, setInstructions] = useState(pickup?.instructions ?? '');
  const [externalReference, setExternalReference] = useState(pickup?.externalReference ?? '');
  // Quantidade disponível para retirada por peça (considerando esta retirada, se edição).
  const available = (itemId: string) => {
    const it = order.items.find((i) => i.id === itemId)!;
    const own = pickup?.items.find((x) => x.orderItemId === itemId)?.quantity ?? 0;
    return it.quantity - it.receivedQuantity - (it.inActivePickups - own);
  };
  const [qty, setQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      order.items.map((i) => [
        i.id,
        String(
          pickup
            ? (pickup.items.find((x) => x.orderItemId === i.id)?.quantity ?? 0)
            : Math.max(0, available(i.id)),
        ),
      ]),
    ),
  );
  const [trip, setTrip] = useState<{ v: TripCostValue; ok: boolean }>({ v: undefined, ok: true });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const idem = useRef(newIdempotencyKey());

  const m = useMutation({
    mutationFn: () => {
      const items = Object.entries(qty)
        .map(([orderItemId, q]) => ({ orderItemId, quantity: Number(q) }))
        .filter((i) => i.quantity > 0);
      const base = {
        addressId: addressId || null,
        scheduledDate: date || null,
        windowStart: start || null,
        windowEnd: end || null,
        team,
        teamNotes,
        instructions,
        externalReference,
        items,
      };
      if (pickup) {
        return api<PickupDto>(`/api/v1/pickups/${pickup.id}`, {
          method: 'PUT',
          body: updatePickupSchema.parse({ ...base, version: pickup.version }),
        });
      }
      return api<PickupDto>('/api/v1/pickups', {
        method: 'POST',
        body: createPickupSchema.parse({
          ...base,
          orderId: order.id,
          ...(trip.v && date ? { tripCost: trip.v } : {}),
        }),
        idempotencyKey: idem.current,
      });
    },
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ['pickups'] });
      void qc.invalidateQueries({ queryKey: ['order', order.id] });
      qc.setQueryData(['pickup', p.id], p);
      toast('ok', pickup ? 'Retirada atualizada.' : `Retirada ${p.code} solicitada.`);
      onClose();
    },
    onError: (e) => {
      idem.current = newIdempotencyKey();
      const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
      if (issues) {
        const map: Record<string, string> = {};
        for (const i of issues) map[String(i.path[0])] ??= i.message;
        setErrors(map);
        setError(issues[0]?.message ?? 'Revise os campos.');
        return;
      }
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT')
        void qc.invalidateQueries({ queryKey: ['pickup'] });
      setErrors(fieldErrors(e));
      setError(e instanceof Error ? e.message : 'Erro');
    },
  });

  const currentAddress = pickup?.address ?? order.pickupAddress;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={pickup ? `Retirada ${pickup.code}` : `Solicitar retirada — ${order.code}`}
      description={`${order.customer.name} · ${order.contractedService}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={m.isPending} disabled={!pickup && !trip.ok} onClick={() => m.mutate()}>
            {pickup ? 'Salvar' : date ? 'Solicitar e agendar' : 'Solicitar retirada'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field
          label="Endereço"
          hint={
            currentAddress
              ? `Atual: ${currentAddress.label} — ${addressLines(currentAddress).replace('\n', ' · ')}`
              : 'O pedido não tem endereço definido.'
          }
        >
          {(p) => (
            <Select {...p} value={addressId} onChange={(e) => setAddressId(e.target.value)}>
              <option value="">{currentAddress ? 'Manter o endereço atual' : 'Selecione…'}</option>
              {addresses.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} — {addressLines(a).replace('\n', ' · ')}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Data combinada"
            error={errors.scheduledDate}
            hint="Vazio = aguardando agendamento"
          >
            {(p) => (
              <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            )}
          </Field>
          <Field label="Janela — início" error={errors.windowStart}>
            {(p) => (
              <Input {...p} type="time" value={start} onChange={(e) => setStart(e.target.value)} />
            )}
          </Field>
          <Field label="Janela — fim" error={errors.windowEnd}>
            {(p) => (
              <Input {...p} type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
            )}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Equipe responsável">
            {(p) => (
              <Select {...p} value={team} onChange={(e) => setTeam(e.target.value as typeof team)}>
                {PICKUP_TEAMS.map((t) => (
                  <option key={t} value={t}>
                    {PICKUP_TEAM_LABEL[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Pessoas / observação da equipe">
            {(p) => (
              <Input {...p} value={teamNotes} onChange={(e) => setTeamNotes(e.target.value)} />
            )}
          </Field>
          <Field label="Referência externa (logística)" hint="Protocolo da logística, se houver">
            {(p) => (
              <Input
                {...p}
                value={externalReference}
                onChange={(e) => setExternalReference(e.target.value)}
              />
            )}
          </Field>
        </div>
        <Field label="Instruções">
          {(p) => (
            <Textarea
              {...p}
              rows={2}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Acesso, portaria, cuidados no transporte…"
            />
          )}
        </Field>
        {!pickup && date && (
          <TripCostFields kind="RETIRADA" onChange={(v, ok) => setTrip({ v, ok })} />
        )}
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Peças a retirar</legend>
          {errors.items && <p className="mb-2 text-sm text-danger-600">{errors.items}</p>}
          <ul className="divide-y divide-line rounded-xl border border-line">
            {order.items.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1 text-sm">
                  {i.description}
                  <span className="block text-xs text-ink-muted">
                    até {Math.max(0, available(i.id))} disponível(is)
                  </span>
                </span>
                <input
                  type="number"
                  min={0}
                  max={Math.max(0, available(i.id))}
                  aria-label={`Quantidade a retirar de ${i.description}`}
                  className="input w-24 py-1.5"
                  value={qty[i.id]}
                  onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })}
                />
              </li>
            ))}
          </ul>
        </fieldset>
      </div>
    </Dialog>
  );
}
