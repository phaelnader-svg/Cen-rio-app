'use client';

import type { DeliveryDto, PickupTeam, PieceStatusDto } from '@cenario/shared';
import {
  DELIVERY_ITEM_STATUS_LABEL,
  DELIVERY_STATUS_LABEL,
  FULFILLMENT_STAGE_LABEL,
  LOGISTICS_KINDS,
  LOGISTICS_KIND_LABEL,
  LOGISTICS_STATUS_LABEL,
  PICKUP_TEAM_LABEL,
  READINESS_CHECK_LABEL,
  type DeliveryStatus,
  type FulfillmentStage,
  type LogisticsKind,
} from '@cenario/shared';
import { CalendarDays, Truck } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { BackLink, Detail, Section } from '@/components/commercial/section';
import { PhotoGallery } from '@/components/commercial/photo-gallery';
import { useSend } from '@/components/production/use-send';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { api, newIdempotencyKey } from '@/lib/api';
import { useCustomer, arrivalText } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import { useWorkers } from '@/lib/production';
import {
  useDeliveries,
  useDelivery,
  useLocations,
  useLogisticsOccurrence,
  useLogisticsOccurrences,
  useLogisticsPeople,
  usePieces,
} from '@/lib/quality';
import { TripCostCard, TripCostFields, type TripCostValue } from '@/components/finance/trip-cost';
import {
  DateField,
  FormGrid,
  SelectField,
  TextAreaField,
  TextField,
  TimeField,
} from '@/components/ui/form';

const day = (iso: string) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(d);
};
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const plusDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const FINAL: FulfillmentStage[] = ['ENTREGUE', 'DEVOLVIDA', 'CANCELADA'];
const DELIVERY_TONE: Record<
  DeliveryStatus,
  'warn' | 'info' | 'ok' | 'danger' | 'neutral' | 'brand'
> = {
  PROVISORIA: 'warn',
  AGENDADA: 'brand',
  EM_TRANSPORTE: 'info',
  NO_DESTINO: 'info',
  CONCLUIDA: 'ok',
  FRUSTRADA: 'danger',
  CANCELADA: 'neutral',
};

export function DeliveryBadge({ status }: { status: DeliveryStatus }) {
  return <Badge tone={DELIVERY_TONE[status]}>{DELIVERY_STATUS_LABEL[status]}</Badge>;
}

// ─────────────────────────── Página Expedição e entregas ───────────────────────────

export function DeliveriesPage() {
  const [tab, setTab] = useState('agenda');
  const ready = usePieces({ stage: 'PRONTA_ENTREGA' });
  const occurrences = useLogisticsOccurrences({ status: 'ABERTA' });
  return (
    <>
      <PageHeader
        title="Expedição e entregas"
        description="Peças prontas (inspeção aprovada, correções encerradas, embalagem concluída e sem bloqueio), agenda de entregas e ocorrências. Só o gestor agenda e confirma; nada é agendado sozinho."
      />
      <Tabs
        tabs={[
          { key: 'agenda', label: 'Agenda' },
          { key: 'ready', label: 'Prontas para entrega', count: ready.data?.length },
          { key: 'shipping', label: 'Expedição' },
          { key: 'occurrences', label: 'Ocorrências logísticas', count: occurrences.data?.length },
        ]}
        active={tab}
        onChange={setTab}
      >
        {tab === 'agenda' && <Agenda />}
        {tab === 'ready' && <ReadyPieces />}
        {tab === 'shipping' && <Shipping />}
        {tab === 'occurrences' && <Occurrences />}
      </Tabs>
    </>
  );
}

/** Agenda agrupada por data e região (cidade/bairro) — sem inventar rota nem horário. */
function Agenda() {
  const [from, setFrom] = useState(plusDays(today(), -7));
  const [to, setTo] = useState(plusDays(today(), 30));
  const q = useDeliveries({ from, to });
  const groups = useMemo(() => {
    const byDate = new Map<string, Map<string, DeliveryDto[]>>();
    for (const d of q.data ?? []) {
      if (!byDate.has(d.scheduledDate)) byDate.set(d.scheduledDate, new Map());
      const r = byDate.get(d.scheduledDate)!;
      if (!r.has(d.region)) r.set(d.region, []);
      r.get(d.region)!.push(d);
    }
    return [...byDate.entries()];
  }, [q.data]);
  return (
    <>
      <Card className="mb-4 flex flex-wrap items-end gap-3 p-4">
        <label className="field">
          <span className="label">De</span>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Até</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </Card>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : !groups.length ? (
        <Card>
          <EmptyState
            icon={<CalendarDays className="size-6" />}
            title="Nenhuma entrega no período"
          />
        </Card>
      ) : (
        <div className="space-y-5" data-testid="delivery-agenda">
          {groups.map(([date, regions]) => (
            <section key={date}>
              <h2 className="mb-2 text-lg font-semibold first-letter:uppercase">{day(date)}</h2>
              {[...regions.entries()].map(([region, list]) => (
                <Card key={region} className="mb-3 overflow-hidden">
                  <p className="border-b border-line bg-subtle px-5 py-2 text-sm font-semibold">
                    {region}
                  </p>
                  <ul className="divide-y divide-line">
                    {list.map((d) => (
                      <li
                        key={d.id}
                        className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm"
                        data-testid={`delivery-${d.code}`}
                      >
                        <span className="w-24 font-mono font-semibold">{d.code}</span>
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">
                            {d.customer.name} · {d.items.length} peça(s)
                            {d.requiresInstallation ? ' · com instalação' : ''}
                          </p>
                          <p className="text-ink-muted">
                            {d.windowStart
                              ? arrivalText(d.windowStart, d.windowEnd)
                              : 'Horário a combinar'}{' '}
                            · {d.responsible?.displayName ?? 'sem responsável'} (
                            {PICKUP_TEAM_LABEL[d.team]})
                          </p>
                        </div>
                        {d.openOccurrences > 0 && (
                          <Badge tone="danger">{d.openOccurrences} ocorrência(s)</Badge>
                        )}
                        <DeliveryBadge status={d.status} />
                        <Link
                          href={`/painel/entregas/${d.id}`}
                          className="font-semibold text-brand-700 hover:underline"
                        >
                          Abrir
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              ))}
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function ReadyPieces() {
  const q = usePieces({ stage: 'PRONTA_ENTREGA' });
  const can = useCan();
  const [schedule, setSchedule] = useState<{
    customerId: string;
    customer: string;
    ids: string[];
  } | null>(null);
  const byCustomer = useMemo(() => {
    const m = new Map<string, PieceStatusDto[]>();
    for (const p of q.data ?? []) {
      if (!m.has(p.customerId)) m.set(p.customerId, []);
      m.get(p.customerId)!.push(p);
    }
    return [...m.values()];
  }, [q.data]);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  if (!byCustomer.length)
    return (
      <Card>
        <EmptyState icon={<Truck className="size-6" />} title="Nenhuma peça pronta para entrega" />
      </Card>
    );
  return (
    <div className="space-y-4" data-testid="ready-pieces">
      {byCustomer.map((list) => (
        <Section
          key={list[0]!.customerId}
          title={list[0]!.customer}
          actions={
            can('entregas.gerenciar') && (
              <Button
                size="sm"
                onClick={() =>
                  setSchedule({
                    customerId: list[0]!.customerId,
                    customer: list[0]!.customer,
                    ids: list.map((p) => p.id),
                  })
                }
              >
                Agendar entrega
              </Button>
            )
          }
        >
          <ul className="space-y-1 text-sm">
            {list.map((p) => (
              <li key={p.id} data-testid={`ready-${p.code}`}>
                <span className="font-mono font-semibold">{p.code}</span> · {p.description} ·{' '}
                {p.location?.label ?? 'sem local'}
                {p.serviceOrder.promisedDate
                  ? ` · prometida ${p.serviceOrder.promisedDate.split('-').reverse().join('/')}`
                  : ''}
              </li>
            ))}
          </ul>
        </Section>
      ))}
      {schedule && (
        <ScheduleDialog
          customerId={schedule.customerId}
          customerName={schedule.customer}
          initialIds={schedule.ids}
          onClose={() => setSchedule(null)}
        />
      )}
    </div>
  );
}

function Shipping() {
  const [stage, setStage] = useState('');
  const q = usePieces({ stage: stage || undefined });
  const can = useCan();
  const [occurrence, setOccurrence] = useState<PieceStatusDto | null>(null);
  const [move, setMove] = useState<PieceStatusDto | null>(null);
  const [preschedule, setPreschedule] = useState<PieceStatusDto | null>(null);
  const list = (q.data ?? []).filter((p) => stage || !FINAL.includes(p.stage));
  return (
    <>
      <Card className="mb-4 p-4">
        <label className="field">
          <span className="label">Etapa</span>
          <Select value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">Em andamento (todas)</option>
            {Object.entries(FULFILLMENT_STAGE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </label>
      </Card>
      {q.isPending ? (
        <Spinner />
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line" data-testid="shipping-pieces">
            {list.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm"
                data-testid={`piece-${p.code}`}
              >
                <span className="w-28 font-mono font-semibold">{p.code}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {p.description} · {p.customer}
                  </p>
                  <p className="text-ink-muted">
                    {p.location?.label ?? 'Sem local registrado'}
                    {!p.readiness.ready &&
                      ` · falta: ${p.readiness.missing.map((m) => READINESS_CHECK_LABEL[m].toLowerCase()).join(', ')}`}
                    {p.delivery
                      ? ` · ${p.delivery.code} (${DELIVERY_STATUS_LABEL[p.delivery.status]})`
                      : ''}
                  </p>
                </div>
                <Badge tone={p.readiness.ready ? 'ok' : 'neutral'}>
                  {FULFILLMENT_STAGE_LABEL[p.stage]}
                </Badge>
                <Button size="sm" variant="ghost" onClick={() => setMove(p)}>
                  Mover
                </Button>
                {can('entregas.gerenciar') && (
                  <>
                    {!p.delivery && !FINAL.includes(p.stage) && (
                      <Button size="sm" variant="ghost" onClick={() => setPreschedule(p)}>
                        Pré-agendar
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setOccurrence(p)}>
                      Ocorrência
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {occurrence && <NewOccurrenceDialog piece={occurrence} onClose={() => setOccurrence(null)} />}
      {move && <MoveDialog piece={move} onClose={() => setMove(null)} />}
      {preschedule && (
        <ScheduleDialog
          customerId={preschedule.customerId}
          customerName={preschedule.customer}
          initialIds={[preschedule.id]}
          onClose={() => setPreschedule(null)}
        />
      )}
    </>
  );
}

function MoveDialog({ piece, onClose }: { piece: PieceStatusDto; onClose: () => void }) {
  const locations = useLocations();
  const [locationId, setLocationId] = useState(piece.location?.id ?? '');
  const [note, setNote] = useState('');
  const { m, error } = useSend(onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Localização de ${piece.code}`}
      description="Registre só as movimentações relevantes (não é preciso cada pequeno deslocamento)."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!locationId}
            loading={m.isPending}
            onClick={() =>
              m.mutate({
                run: () =>
                  api(`/api/v1/pieces/${piece.id}/move`, {
                    method: 'POST',
                    body: { locationId, note: note || null },
                  }),
                ok: 'Localização registrada.',
              })
            }
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
        <Field label="Local">
          {(f) => (
            <Select {...f} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Escolha</option>
              {locations.data
                ?.filter((l) => l.active)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label="Observação">
          {(f) => <Input {...f} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <p className="text-xs text-ink-muted">Etiqueta: {piece.labelPayload}</p>
      </div>
    </Dialog>
  );
}

function NewOccurrenceDialog({ piece, onClose }: { piece: PieceStatusDto; onClose: () => void }) {
  const [kind, setKind] = useState<LogisticsKind>('PECA_DANIFICADA');
  const [description, setDescription] = useState('');
  const [key] = useState(newIdempotencyKey);
  const { m, error } = useSend(onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Ocorrência — ${piece.code}`}
      description="Peça danificada e divergência bloqueiam a expedição até a resolução."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={description.trim().length < 3}
            loading={m.isPending}
            onClick={() =>
              m.mutate({
                run: () =>
                  api('/api/v1/logistics-occurrences', {
                    method: 'POST',
                    body: {
                      kind,
                      description: description.trim(),
                      serviceOrderItemId: piece.id,
                      deliveryId: piece.delivery?.id ?? null,
                    },
                    idempotencyKey: key,
                  }),
                ok: 'Ocorrência registrada.',
              })
            }
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
        <Field label="Tipo">
          {(f) => (
            <Select {...f} value={kind} onChange={(e) => setKind(e.target.value as LogisticsKind)}>
              {LOGISTICS_KINDS.map((k) => (
                <option key={k} value={k}>
                  {LOGISTICS_KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Descrição">
          {(f) => (
            <Textarea {...f} value={description} onChange={(e) => setDescription(e.target.value)} />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

// ─────────────────────────── Agendamento (gestor) ───────────────────────────

export function ScheduleDialog({
  customerId,
  customerName,
  initialIds,
  delivery,
  onClose,
}: {
  customerId: string;
  customerName: string;
  initialIds: string[];
  delivery?: DeliveryDto;
  onClose: () => void;
}) {
  const customer = useCustomer(customerId);
  const pieces = usePieces({ q: customerName });
  const people = useLogisticsPeople();
  const [ids, setIds] = useState<string[]>(initialIds);
  const [addressId, setAddressId] = useState('');
  const [date, setDate] = useState(delivery?.scheduledDate ?? plusDays(today(), 1));
  const [windowStart, setWindowStart] = useState(delivery?.windowStart ?? '');
  const [team, setTeam] = useState<PickupTeam>(delivery?.team ?? 'LOGISTICA_TERCEIRIZADA');
  const [responsibleUserId, setResponsible] = useState(delivery?.responsible?.userId ?? '');
  const [requiresInstallation, setInstall] = useState(delivery?.requiresInstallation ?? false);
  const [contactName, setContactName] = useState(delivery?.contactName ?? '');
  const [contactPhone, setContactPhone] = useState(delivery?.contactPhone ?? '');
  const [instructions, setInstructions] = useState(delivery?.instructions ?? '');
  const [notes, setNotes] = useState(delivery?.notes ?? '');
  const [reason, setReason] = useState('');
  const [trip, setTrip] = useState<{ v: TripCostValue; ok: boolean }>({ v: undefined, ok: true });
  const [key] = useState(newIdempotencyKey);
  const { m, error } = useSend(onClose);
  const candidates = (pieces.data ?? []).filter(
    (p) =>
      p.customerId === customerId &&
      !FINAL.includes(p.stage) &&
      (!p.delivery || p.delivery.id === delivery?.id || ids.includes(p.id)),
  );
  const unready = candidates.filter((p) => ids.includes(p.id) && !p.readiness.ready);
  const provisional = unready.length > 0 || delivery?.status === 'PROVISORIA';
  const body = {
    addressId: addressId || null,
    contactName: contactName || null,
    contactPhone: contactPhone || null,
    scheduledDate: date,
    windowStart: windowStart || null,
    // Registro antigo com janela: o fim só é mantido enquanto a chegada não mudar (sem conversão).
    windowEnd:
      delivery?.windowEnd && windowStart === delivery.windowStart ? delivery.windowEnd : null,
    team,
    responsibleUserId: responsibleUserId || null,
    requiresInstallation,
    instructions: instructions || null,
    notes: notes || null,
    itemIds: ids,
  };
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={delivery ? `Reagendar ${delivery.code}` : `Agendar entrega — ${customerName}`}
      description="Data e horário de chegada combinados com o cliente, equipe e peças. Peças ainda não liberadas só entram em pré-agendamento provisório (sem confirmação ao cliente)."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={
              !ids.length ||
              !date ||
              (!provisional && !windowStart) ||
              (Boolean(delivery) && reason.trim().length < 3) ||
              (!delivery && !trip.ok)
            }
            loading={m.isPending}
            onClick={() =>
              m.mutate({
                run: () =>
                  delivery
                    ? api(`/api/v1/deliveries/${delivery.id}`, {
                        method: 'PUT',
                        body: {
                          ...body,
                          provisional,
                          reason: reason.trim(),
                          version: delivery.version,
                        },
                      })
                    : api('/api/v1/deliveries', {
                        method: 'POST',
                        body: {
                          ...body,
                          customerId,
                          provisional,
                          ...(trip.v ? { tripCost: trip.v } : {}),
                        },
                        idempotencyKey: key,
                      }),
                ok: provisional ? 'Pré-agendamento provisório registrado.' : 'Entrega agendada.',
              })
            }
          >
            {provisional ? 'Pré-agendar (provisório)' : delivery ? 'Salvar' : 'Agendar'}
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      {provisional && (
        <Alert tone="warn" className="mb-3" title="Provisório">
          {unready.length
            ? `${unready.map((p) => p.code).join(', ')} ainda não está(ão) pronta(s) para entrega.`
            : 'Pré-agendamento ainda não confirmado.'}{' '}
          A confirmação definitiva só é possível com todas as peças liberadas.
        </Alert>
      )}
      <div className="space-y-5" data-testid="delivery-form">
        <FormGrid>
          <DateField
            label="Data do compromisso"
            required
            cols={4}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <TimeField
            label="Horário de chegada ao cliente"
            required={!provisional}
            cols={4}
            hint={
              provisional
                ? 'Opcional no pré-agendamento; obrigatório para confirmar.'
                : 'Compromisso com o cliente. Sem horário de término.'
            }
            value={windowStart}
            onChange={(e) => setWindowStart(e.target.value)}
          />
          <SelectField
            label="Endereço"
            cols={4}
            value={addressId}
            onChange={(e) => setAddressId(e.target.value)}
          >
            <option value="">
              {delivery ? 'Manter / principal do cliente' : 'Principal do cliente'}
            </option>
            {customer.data?.addresses.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}: {a.street}, {a.number} — {a.city}
              </option>
            ))}
          </SelectField>
          {delivery?.windowEnd && (
            <p className="text-xs text-ink-muted sm:col-span-12">
              Registro antigo com janela {delivery.windowStart}–{delivery.windowEnd}: mantida
              enquanto o horário de chegada não for alterado.
            </p>
          )}
          <SelectField
            label="Equipe responsável"
            cols={4}
            value={team}
            onChange={(e) => setTeam(e.target.value as PickupTeam)}
          >
            <option value="LOGISTICA_TERCEIRIZADA">
              {PICKUP_TEAM_LABEL.LOGISTICA_TERCEIRIZADA}
            </option>
            <option value="EQUIPE_PROPRIA">{PICKUP_TEAM_LABEL.EQUIPE_PROPRIA}</option>
          </SelectField>
          <SelectField
            label="Responsável pela execução"
            cols={4}
            value={responsibleUserId}
            onChange={(e) => setResponsible(e.target.value)}
          >
            <option value="">A definir</option>
            {people.data
              ?.filter((p) => p.team === team)
              .map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.displayName}
                </option>
              ))}
          </SelectField>
          <TextField
            label="Contato no local"
            cols={4}
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
          />
          <TextField
            label="Telefone do contato"
            cols={4}
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
          />
        </FormGrid>
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Peças</legend>
          <div className="grid gap-1 rounded-xl border border-line p-3">
            {candidates.map((p) => (
              <Checkbox
                key={p.id}
                label={`${p.code} · ${p.description} — ${FULFILLMENT_STAGE_LABEL[p.stage]}`}
                checked={ids.includes(p.id)}
                onChange={(e) =>
                  setIds((x) => (e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id)))
                }
              />
            ))}
          </div>
        </fieldset>
        <Checkbox
          label="Com instalação"
          checked={requiresInstallation}
          onChange={(e) => setInstall(e.target.checked)}
        />
        <FormGrid>
          <TextAreaField
            label="Instruções para a equipe"
            cols={12}
            rows={2}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
          <TextAreaField
            label="Observações internas"
            cols={12}
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          {delivery && (
            <TextField
              label="Motivo da alteração"
              required
              cols={12}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </FormGrid>
        {!delivery && <TripCostFields kind="ENTREGA" onChange={(v, ok) => setTrip({ v, ok })} />}
      </div>
    </Dialog>
  );
}

// ─────────────────────────── Detalhe da entrega ───────────────────────────

export function DeliveryDetailPage({ id }: { id: string }) {
  const q = useDelivery(id);
  const can = useCan();
  const occurrences = useLogisticsOccurrences();
  const [edit, setEdit] = useState(false);
  const [cancel, setCancel] = useState(false);
  const { m, error } = useSend();
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const d = q.data;
  const manage = can('entregas.gerenciar');
  const a = d.address;
  return (
    <>
      <BackLink href="/painel/entregas" label="Expedição e entregas" />
      <PageHeader
        title={`Entrega ${d.code}`}
        description={`${d.customer.name} · ${day(d.scheduledDate)}${d.windowStart ? ` · ${arrivalText(d.windowStart, d.windowEnd)}` : ''}`}
        actions={
          manage && (
            <>
              {d.status === 'PROVISORIA' && (
                <Button
                  loading={m.isPending}
                  onClick={() =>
                    m.mutate({
                      run: () =>
                        api(`/api/v1/deliveries/${d.id}/confirm`, {
                          method: 'POST',
                          body: { version: d.version },
                        }),
                      ok: 'Entrega confirmada.',
                    })
                  }
                >
                  Confirmar agendamento
                </Button>
              )}
              {['PROVISORIA', 'AGENDADA', 'FRUSTRADA'].includes(d.status) && (
                <Button variant="secondary" onClick={() => setEdit(true)}>
                  {d.status === 'FRUSTRADA' ? 'Reagendar' : 'Alterar'}
                </Button>
              )}
              {['PROVISORIA', 'AGENDADA', 'FRUSTRADA'].includes(d.status) && (
                <Button variant="danger" onClick={() => setCancel(true)}>
                  Cancelar
                </Button>
              )}
            </>
          )
        }
      />
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm" data-testid="delivery-header">
        <DeliveryBadge status={d.status} />
        {d.provisional && <Badge tone="warn">Não confirmada ao cliente</Badge>}
        <span>
          {PICKUP_TEAM_LABEL[d.team]} · {d.responsible?.displayName ?? 'sem responsável'}
        </span>
        {d.attempts > 0 && <Badge tone="danger">{d.attempts} tentativa(s) frustrada(s)</Badge>}
      </div>
      <div className="mb-6">
        <TripCostCard deliveryId={d.id} />
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <Section title="Local e contato">
            <dl className="grid gap-3 sm:grid-cols-2">
              <Detail label="Endereço">
                {a.street}, {a.number}
                {a.complement ? ` — ${a.complement}` : ''} · {a.district ? `${a.district}, ` : ''}
                {a.city}/{a.state}
              </Detail>
              <Detail label="Região">{d.region}</Detail>
              <Detail label="Contato">
                {d.contactName} {d.contactPhone ? `· ${d.contactPhone}` : ''}
              </Detail>
              <Detail label="Instalação">
                {d.requiresInstallation
                  ? d.installedAt
                    ? `Instalada (${formatDateTime(d.installedAt)})`
                    : 'Prevista'
                  : 'Não'}
              </Detail>
              <Detail label="Instruções">{d.instructions}</Detail>
              <Detail label="Observações">{d.notes}</Detail>
            </dl>
          </Section>
          <Section title="Peças">
            <ul className="divide-y divide-line text-sm" data-testid="delivery-items">
              {d.items.map((i) => (
                <li key={i.serviceOrderItemId} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="font-mono font-semibold">{i.code}</span>
                  <span className="flex-1">{i.description}</span>
                  <Badge tone={i.ready ? 'ok' : 'warn'}>{FULFILLMENT_STAGE_LABEL[i.stage]}</Badge>
                  <span className="text-ink-muted">{DELIVERY_ITEM_STATUS_LABEL[i.status]}</span>
                  {i.note && <span className="w-full text-ink-muted">{i.note}</span>}
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Histórico">
            <ol className="space-y-2 text-sm" data-testid="delivery-history">
              {d.events.map((e) => (
                <li key={e.id}>
                  <span className="text-ink-muted">{formatDateTime(e.createdAt)}</span> ·{' '}
                  <strong>{e.kind}</strong>
                  {e.actor ? ` · ${e.actor}` : ''}
                  {e.note ? ` — ${e.note}` : ''}
                </li>
              ))}
            </ol>
          </Section>
          <Section title="Ocorrências">
            <ul className="space-y-1 text-sm">
              {(occurrences.data ?? [])
                .filter((o) => o.delivery?.id === d.id)
                .map((o) => (
                  <li key={o.id}>
                    <Link
                      href={`/painel/entregas/ocorrencias/${o.id}`}
                      className="font-semibold text-brand-700 hover:underline"
                    >
                      {o.code}
                    </Link>{' '}
                    · {LOGISTICS_KIND_LABEL[o.kind]} · {LOGISTICS_STATUS_LABEL[o.status]} —{' '}
                    {o.description}
                  </li>
                ))}
            </ul>
          </Section>
        </div>
        <Section title="Fotos">
          <PhotoGallery entityType="DELIVERY" entityId={d.id} canManage={manage} />
        </Section>
      </div>
      {edit && (
        <ScheduleDialog
          customerId={d.customer.id}
          customerName={d.customer.name}
          initialIds={d.items.map((i) => i.serviceOrderItemId)}
          delivery={d}
          onClose={() => setEdit(false)}
        />
      )}
      {cancel && (
        <ReasonDialog
          title={`Cancelar ${d.code}`}
          label="Motivo do cancelamento"
          onClose={() => setCancel(false)}
          run={(reason) =>
            api(`/api/v1/deliveries/${d.id}/cancel`, {
              method: 'POST',
              body: { reason, version: d.version },
            })
          }
        />
      )}
    </>
  );
}

function ReasonDialog({
  title,
  label,
  run,
  onClose,
}: {
  title: string;
  label: string;
  run: (text: string) => Promise<unknown>;
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
        <>
          <Button variant="ghost" onClick={onClose}>
            Voltar
          </Button>
          <Button
            disabled={text.trim().length < 3}
            loading={m.isPending}
            onClick={() => m.mutate({ run: () => run(text.trim()), ok: 'Registrado.' })}
          >
            Confirmar
          </Button>
        </>
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

// ─────────────────────────── Ocorrências logísticas ───────────────────────────

function Occurrences() {
  const [status, setStatus] = useState('');
  const q = useLogisticsOccurrences({ status: status || undefined });
  return (
    <>
      <Card className="mb-4 p-4">
        <label className="field">
          <span className="label">Situação</span>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todas</option>
            {Object.entries(LOGISTICS_STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </label>
      </Card>
      {q.isPending ? (
        <Spinner />
      ) : !q.data?.length ? (
        <Card>
          <EmptyState title="Nenhuma ocorrência logística" />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line" data-testid="logistics-occurrences">
            {q.data.map((o) => (
              <li
                key={o.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm"
              >
                <span className="w-24 font-mono font-semibold">{o.code}</span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {LOGISTICS_KIND_LABEL[o.kind]} — {o.description}
                  </p>
                  <p className="text-ink-muted">
                    {o.delivery?.code ?? o.pickup?.code ?? o.piece?.code} · {o.reportedBy ?? '—'} ·{' '}
                    {formatDateTime(o.createdAt)}
                    {o.responsible ? ` · com ${o.responsible.displayName}` : ''}
                  </p>
                </div>
                {o.blocksShipping && o.status !== 'RESOLVIDA' && o.status !== 'CANCELADA' && (
                  <Badge tone="danger">Bloqueia expedição</Badge>
                )}
                <Badge
                  tone={
                    o.status === 'RESOLVIDA' ? 'ok' : o.status === 'CANCELADA' ? 'neutral' : 'warn'
                  }
                >
                  {LOGISTICS_STATUS_LABEL[o.status]}
                </Badge>
                <Link
                  href={`/painel/entregas/ocorrencias/${o.id}`}
                  className="font-semibold text-brand-700 hover:underline"
                >
                  Abrir
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

export function OccurrenceDetailPage({ id }: { id: string }) {
  const q = useLogisticsOccurrence(id);
  const can = useCan();
  const workers = useWorkers();
  const people = useLogisticsPeople();
  const [dialog, setDialog] = useState<'assign' | 'resolve' | 'cancel' | null>(null);
  const [userId, setUserId] = useState('');
  const { m, error } = useSend(() => setDialog(null));
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const o = q.data;
  const open = o.status === 'ABERTA' || o.status === 'EM_TRATAMENTO';
  const manage = can('entregas.gerenciar');
  const options = [
    ...(people.data ?? []).filter((p) => p.team === 'LOGISTICA_TERCEIRIZADA'),
    ...(workers.data ?? []),
  ];
  return (
    <>
      <BackLink href="/painel/entregas" label="Expedição e entregas" />
      <PageHeader
        title={`Ocorrência ${o.code}`}
        description={`${LOGISTICS_KIND_LABEL[o.kind]} — ${o.description}`}
        actions={
          manage &&
          open && (
            <>
              <Button variant="secondary" onClick={() => setDialog('assign')}>
                Definir responsável
              </Button>
              <Button onClick={() => setDialog('resolve')}>Resolver</Button>
              <Button variant="danger" onClick={() => setDialog('cancel')}>
                Cancelar
              </Button>
            </>
          )
        }
      />
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <div
        className="mb-4 flex flex-wrap items-center gap-3 text-sm"
        data-testid="occurrence-header"
      >
        <Badge
          tone={o.status === 'RESOLVIDA' ? 'ok' : o.status === 'CANCELADA' ? 'neutral' : 'warn'}
        >
          {LOGISTICS_STATUS_LABEL[o.status]}
        </Badge>
        {o.blocksShipping && <Badge tone="danger">Bloqueia a expedição</Badge>}
        {o.delivery && (
          <Link
            href={`/painel/entregas/${o.delivery.id}`}
            className="text-brand-700 hover:underline"
          >
            {o.delivery.code}
          </Link>
        )}
        {o.piece && (
          <span>
            {o.piece.code} · {o.piece.description}
          </span>
        )}
        <span>Responsável: {o.responsible?.displayName ?? '—'}</span>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Section title="Histórico">
          <ol className="space-y-2 text-sm" data-testid="occurrence-history">
            {o.events.map((e) => (
              <li key={e.id}>
                <span className="text-ink-muted">{formatDateTime(e.createdAt)}</span> ·{' '}
                <strong>{e.kind}</strong>
                {e.actor ? ` · ${e.actor}` : ''}
                {e.note ? ` — ${e.note}` : ''}
              </li>
            ))}
          </ol>
          {o.resolution && <p className="mt-3 text-sm">Solução: {o.resolution}</p>}
        </Section>
        <Section title="Fotos">
          <PhotoGallery entityType="LOGISTICS_OCCURRENCE" entityId={o.id} canManage={manage} />
        </Section>
      </div>
      {dialog === 'assign' && (
        <Dialog
          open
          onClose={() => setDialog(null)}
          title="Responsável pelo tratamento"
          footer={
            <Button
              disabled={!userId}
              loading={m.isPending}
              onClick={() =>
                m.mutate({
                  run: () =>
                    api(`/api/v1/logistics-occurrences/${o.id}/assign`, {
                      method: 'POST',
                      body: { responsibleUserId: userId, version: o.version },
                    }),
                  ok: 'Responsável definido.',
                })
              }
            >
              Definir
            </Button>
          }
        >
          <Field label="Responsável">
            {(f) => (
              <Select {...f} value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Escolha</option>
                {options.map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.displayName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </Dialog>
      )}
      {dialog === 'resolve' && (
        <ReasonDialog
          title={`Resolver ${o.code}`}
          label="Solução"
          onClose={() => setDialog(null)}
          run={(resolution) =>
            api(`/api/v1/logistics-occurrences/${o.id}/resolve`, {
              method: 'POST',
              body: { resolution, version: o.version },
            })
          }
        />
      )}
      {dialog === 'cancel' && (
        <ReasonDialog
          title={`Cancelar ${o.code}`}
          label="Motivo"
          onClose={() => setDialog(null)}
          run={(reason) =>
            api(`/api/v1/logistics-occurrences/${o.id}/cancel`, {
              method: 'POST',
              body: { reason, version: o.version },
            })
          }
        />
      )}
    </>
  );
}
