'use client';

import type {
  MaterialKind,
  MaterialSourcing,
  MaterialUnit,
  Priority,
  ReadinessState,
  ServiceOrderDto,
  ServiceOrderItemDto,
  ServiceType,
} from '@cenario/shared';
import {
  MATERIAL_KINDS,
  MATERIAL_KIND_LABEL,
  MATERIAL_SOURCINGS,
  MATERIAL_SOURCING_LABEL,
  MATERIAL_UNIT_LABEL,
  MEASUREMENT_KIND_LABEL,
  PIECE_TYPE_LABEL,
  PRIORITIES,
  PRIORITY_LABEL,
  SERVICE_TYPES,
  SERVICE_TYPE_LABEL,
  materialRequirementSchema,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Ban, CheckCircle2, Circle, Clock3, Pencil, Plus, Ruler, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, Avatar, Badge, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatDay, useServiceOrder, useServiceOrderRevisions } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import { useEmployees } from '@/lib/queries';
import { CreateMeasurementDialog } from '@/components/measurements/create-dialog';
import { MeasurementList } from '@/components/measurements/measurements-page';
import { useMeasurements } from '@/lib/measurements';
import { PriorityBadge, ServiceOrderStatusBadge } from './badges';
import { PhotoGallery } from './photo-gallery';
import { BackLink, Detail, Section } from './section';

const FUTURE = 'Disponível em fase futura';

function useSoMutation(id: string, onDone: () => void, success: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (fn: () => Promise<ServiceOrderDto>) => fn(),
    onSuccess: (so) => {
      qc.setQueryData(['service-order', id], so);
      void qc.invalidateQueries({ queryKey: ['service-order', id, 'revisions'] });
      void qc.invalidateQueries({ queryKey: ['service-orders'] });
      toast('ok', success);
      onDone();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT')
        void qc.invalidateQueries({ queryKey: ['service-order', id] });
      setError(
        e instanceof ApiError
          ? e.message
          : ((e as { issues?: { message: string }[] }).issues?.[0]?.message ?? errorMessage(e)),
      );
    },
  });
  return { m, error, setError };
}

const READY_LABEL: Record<ReadinessState, string> = {
  OK: 'Concluído',
  PENDENTE: 'Pendente',
  FASE_FUTURA: 'Fase futura',
};

function ReadinessRow({
  label,
  state,
  hint,
}: {
  label: string;
  state: ReadinessState;
  hint: string;
}) {
  const Icon = state === 'OK' ? CheckCircle2 : state === 'PENDENTE' ? Circle : Clock3;
  return (
    <li className="flex items-start gap-3 py-2">
      <Icon
        className={clsx(
          'mt-0.5 size-4 shrink-0',
          state === 'OK'
            ? 'text-ok-600'
            : state === 'PENDENTE'
              ? 'text-warn-600'
              : 'text-ink-muted',
        )}
        aria-hidden
      />
      <div>
        <p className="text-sm font-medium">
          {label} <span className="font-normal text-ink-muted">· {READY_LABEL[state]}</span>
        </p>
        <p className="text-xs text-ink-muted">{hint}</p>
      </div>
    </li>
  );
}

export function ServiceOrderDetail({ id }: { id: string }) {
  const can = useCan();
  const so = useServiceOrder(id);
  const revisions = useServiceOrderRevisions(id);
  const [tab, setTab] = useState('resumo');
  const [editing, setEditing] = useState(false);
  const [editItem, setEditItem] = useState<ServiceOrderItemDto | null>(null);
  const [measureItem, setMeasureItem] = useState<ServiceOrderItemDto | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [requestMeasurement, setRequestMeasurement] = useState(false);

  if (so.isPending) return <Spinner />;
  if (so.isError) return <Alert tone="danger">{so.error.message}</Alert>;
  const s = so.data;
  const open = s.status === 'ABERTA';
  const manage = can('os.gerenciar') && open;
  // Registro direto de medidas: somente gestão (o fluxo normal é a medição atribuída).
  const canMeasure = can('os.gerenciar') && open;
  const canRequestMeasurement = can('medicoes.gerenciar') && open;

  return (
    <>
      <BackLink href="/painel/os" label="Ordens de serviço" />
      <PageHeader
        title={s.code}
        description={`${s.customer.name} · pedido ${s.order.code} · criada em ${formatDateTime(s.createdAt)}${s.createdBy ? ` por ${s.createdBy}` : ''}`}
        actions={
          (manage || canRequestMeasurement) && (
            <>
              {canRequestMeasurement && (
                <Button
                  icon={<Ruler className="size-4" aria-hidden />}
                  onClick={() => setRequestMeasurement(true)}
                >
                  Solicitar medição
                </Button>
              )}
              {manage && (
                <>
                  <Button
                    variant="secondary"
                    icon={<Pencil className="size-4" aria-hidden />}
                    onClick={() => setEditing(true)}
                  >
                    Editar dados gerais
                  </Button>
                  <Button
                    variant="ghost"
                    icon={<Ban className="size-4" aria-hidden />}
                    onClick={() => setCancelling(true)}
                  >
                    Cancelar OS
                  </Button>
                </>
              )}
            </>
          )
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <ServiceOrderStatusBadge status={s.status} />
        <PriorityBadge priority={s.priority} />
        {s.promisedDate && (
          <span className="text-sm text-ink-muted">
            Prazo prometido: {formatDay(s.promisedDate, true)}
          </span>
        )}
      </div>
      {!open && (
        <Alert tone="warn" className="mb-6" title={`Cancelada em ${formatDateTime(s.cancelledAt)}`}>
          {s.cancelReason}
        </Alert>
      )}

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'resumo', label: 'Resumo' },
          { key: 'pecas', label: 'Peças e especificações', count: s.items.length },
          { key: 'materiais', label: 'Materiais', count: s.materials.length },
          { key: 'fotos', label: 'Fotografias' },
          { key: 'historico', label: 'Histórico', count: revisions.data?.length },
          { key: 'programacao', label: 'Programação', disabledNote: FUTURE },
          { key: 'producao', label: 'Produção', disabledNote: FUTURE },
          { key: 'qualidade', label: 'Qualidade', disabledNote: FUTURE },
          { key: 'entrega', label: 'Entrega', disabledNote: FUTURE },
        ]}
      >
        {tab === 'resumo' && (
          <div className="grid gap-6 lg:grid-cols-5">
            <Section title="Dados gerais" className="lg:col-span-3">
              <dl className="grid gap-4 sm:grid-cols-2">
                <Detail label="Cliente">{s.customer.name}</Detail>
                <Detail label="Pedido de origem">
                  {can('pedidos.ver') ? (
                    <Link
                      href={`/painel/pedidos/${s.order.id}`}
                      className="text-brand-700 hover:underline"
                    >
                      {s.order.code}
                    </Link>
                  ) : (
                    s.order.code
                  )}
                </Detail>
                <Detail label="Responsável técnico principal">
                  {s.technicalLead ? (
                    <span className="inline-flex items-center gap-2">
                      <Avatar
                        name={s.technicalLead.displayName}
                        color={s.technicalLead.color}
                        photoUrl={s.technicalLead.photoUrl}
                        size={22}
                      />
                      {s.technicalLead.displayName}
                    </span>
                  ) : (
                    'A definir'
                  )}
                </Detail>
                <Detail label="Peças">{`${s.pieceCount} peça(s) em ${s.itemCount} item(ns)`}</Detail>
                <div className="sm:col-span-2">
                  <Detail label="Instruções técnicas">{s.technicalInstructions}</Detail>
                </div>
                <div className="sm:col-span-2">
                  <Detail label="Observações">{s.notes}</Detail>
                </div>
              </dl>
            </Section>
            <Section title="Prontidão para produção" className="lg:col-span-2">
              <ul className="divide-y divide-line" data-testid="readiness">
                <ReadinessRow
                  label="Medições"
                  state={s.readiness.measurements}
                  hint="Gestor às sextas; extraordinárias por tapeceiro autorizado."
                />
                <ReadinessRow
                  label="Responsável técnico"
                  state={s.readiness.technicalLead}
                  hint="Tapeceiro principal da peça."
                />
                <ReadinessRow
                  label="Materiais"
                  state={s.readiness.materials}
                  hint="Compras e estoque — próxima fase. A chegada de material não antecipa a produção."
                />
                <ReadinessRow
                  label="Programação"
                  state={s.readiness.scheduling}
                  hint="Programação semanal (sextas) — fase futura."
                />
              </ul>
              <p className="mt-3 rounded-lg bg-subtle px-3 py-2 text-xs text-ink-soft">
                A produção só começa quando programação, materiais, responsável e dependências
                permitirem.
              </p>
            </Section>
          </div>
        )}

        {tab === 'pecas' && (
          <ul className="space-y-4">
            {s.items.map((i) => (
              <li key={i.id}>
                <Section
                  title={`${i.code} · ${i.description}`}
                  actions={
                    <>
                      {canMeasure && (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<Ruler className="size-3.5" aria-hidden />}
                          onClick={() => setMeasureItem(i)}
                        >
                          Registrar medidas
                        </Button>
                      )}
                      {manage && (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<Pencil className="size-3.5" aria-hidden />}
                          onClick={() => setEditItem(i)}
                        >
                          Editar especificações
                        </Button>
                      )}
                    </>
                  }
                >
                  <dl className="grid gap-4 sm:grid-cols-3" data-testid={`so-item-${i.code}`}>
                    <Detail label="Peça">{`${i.quantity}× ${PIECE_TYPE_LABEL[i.pieceType]}`}</Detail>
                    <Detail label="Tipo de serviço">{SERVICE_TYPE_LABEL[i.serviceType]}</Detail>
                    <Detail label="Localização na oficina">{i.locations.join(', ')}</Detail>
                    <Detail label="Tecido">{i.fabricName}</Detail>
                    <Detail label="Cor / referência">
                      {[i.fabricColor, i.fabricReference].filter(Boolean).join(' · ')}
                    </Detail>
                    <Detail label="Espumas / especificações">{i.foamSpecs}</Detail>
                    <div className="sm:col-span-3">
                      <Detail label="Observações técnicas">{i.technicalNotes}</Detail>
                    </div>
                    <div className="sm:col-span-3">
                      <dt className="text-sm text-ink-muted">Medidas</dt>
                      {i.measurements.length ? (
                        <dd className="mt-1">
                          <ul className="flex flex-wrap gap-2">
                            {i.measurements.map((mm, k) => (
                              <li key={k} className="rounded-lg bg-subtle px-2.5 py-1 text-sm">
                                {mm.label}: <strong>{mm.valueCm} cm</strong>
                              </li>
                            ))}
                          </ul>
                          <p className="mt-1 text-xs text-ink-muted">
                            {i.measurementKind ? MEASUREMENT_KIND_LABEL[i.measurementKind] : ''} ·{' '}
                            {i.measuredBy} · {formatDateTime(i.measuredAt)}
                            {i.measurementNotes ? ` · ${i.measurementNotes}` : ''}
                          </p>
                        </dd>
                      ) : (
                        <dd className="mt-0.5 text-[15px] text-warn-600">Medição pendente</dd>
                      )}
                    </div>
                  </dl>
                  <div className="mt-4 border-t border-line pt-4">
                    <p className="mb-2 text-sm font-medium">Fotos desta peça</p>
                    <PhotoGallery
                      entityType="SERVICE_ORDER_ITEM"
                      entityId={i.id}
                      canManage={manage}
                    />
                  </div>
                </Section>
              </li>
            ))}
          </ul>
        )}

        {tab === 'materiais' && <MaterialsTab so={s} manage={manage} />}

        {tab === 'fotos' && (
          <Section title="Fotografias da OS">
            <PhotoGallery entityType="SERVICE_ORDER" entityId={s.id} canManage={manage} />
          </Section>
        )}

        {tab === 'historico' && (
          <Section title="Histórico técnico" bodyClassName="p-0">
            {revisions.isPending ? (
              <Spinner className="p-5" />
            ) : (
              <ol className="divide-y divide-line" data-testid="revisions">
                {revisions.data?.map((r) => (
                  <li key={r.id} className="px-5 py-3.5">
                    <p className="text-sm font-medium">
                      Revisão {r.revision} ·{' '}
                      {
                        {
                          CRIACAO: 'Criação',
                          OS: 'Dados gerais',
                          ITEM: 'Especificações',
                          MEDICAO: 'Medição',
                          MATERIAL: 'Materiais',
                          CANCELAMENTO: 'Cancelamento',
                        }[r.scope]
                      }
                      {r.itemCode ? ` · ${r.itemCode}` : ''}
                    </p>
                    {r.reason && <p className="text-sm text-ink-soft">Motivo: {r.reason}</p>}
                    <ChangeList changes={r.changes} />
                    <p className="text-xs text-ink-muted">
                      {formatDateTime(r.createdAt)} · {r.changedBy ?? 'Sistema'}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        )}
      </Tabs>

      {editing && <EditServiceOrderDialog so={s} onClose={() => setEditing(false)} />}
      {editItem && <EditItemDialog so={s} item={editItem} onClose={() => setEditItem(null)} />}
      {measureItem && (
        <MeasureDialog so={s} item={measureItem} onClose={() => setMeasureItem(null)} />
      )}
      {cancelling && <CancelDialog so={s} onClose={() => setCancelling(false)} />}
      {requestMeasurement && (
        <CreateMeasurementDialog
          target={{
            serviceOrder: { id: s.id, code: s.code },
            items: s.items.map((i) => ({ id: i.id, code: i.code, description: i.description })),
          }}
          onClose={() => setRequestMeasurement(false)}
        />
      )}
    </>
  );
}

const FIELD_LABEL: Record<string, string> = {
  fabricName: 'Tecido',
  fabricColor: 'Cor',
  fabricReference: 'Referência',
  foamSpecs: 'Espumas',
  technicalNotes: 'Obs. técnicas',
  serviceType: 'Tipo de serviço',
  description: 'Descrição',
  technicalInstructions: 'Instruções técnicas',
  notes: 'Observações',
  promisedDate: 'Prazo prometido',
  priority: 'Prioridade',
  technicalLeadId: 'Responsável técnico',
};

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v))
    return v
      .map((x) =>
        typeof x === 'object' && x && 'label' in x
          ? `${(x as { label: string }).label} ${(x as { valueCm: number }).valueCm} cm`
          : String(x),
      )
      .join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function ChangeList({ changes }: { changes: unknown }) {
  if (!changes || typeof changes !== 'object') return null;
  const entries = Object.entries(changes as Record<string, unknown>);
  return (
    <ul className="my-1 space-y-0.5 text-sm text-ink-soft">
      {entries.map(([k, v]) => (
        <li key={k}>
          <span className="text-ink-muted">{FIELD_LABEL[k] ?? k}:</span>{' '}
          {v && typeof v === 'object' && 'from' in v && 'to' in v
            ? `${show((v as { from: unknown }).from)} → ${show((v as { to: unknown }).to)}`
            : show(v)}
        </li>
      ))}
    </ul>
  );
}

function EditServiceOrderDialog({ so, onClose }: { so: ServiceOrderDto; onClose: () => void }) {
  const can = useCan();
  const employees = useEmployees(can('funcionarios.ver'));
  const [priority, setPriority] = useState<Priority>(so.priority);
  const [promisedDate, setPromisedDate] = useState(so.promisedDate ?? '');
  const [lead, setLead] = useState(so.technicalLead?.id ?? '');
  const [instructions, setInstructions] = useState(so.technicalInstructions ?? '');
  const [notes, setNotes] = useState(so.notes ?? '');
  const [reason, setReason] = useState('');
  const { m, error } = useSoMutation(so.id, onClose, 'OS atualizada.');
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Editar OS ${so.code}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            onClick={() =>
              m.mutate(() =>
                api<ServiceOrderDto>(`/api/v1/service-orders/${so.id}`, {
                  method: 'PUT',
                  body: {
                    priority,
                    promisedDate: promisedDate || null,
                    technicalLeadId: lead || null,
                    technicalInstructions: instructions,
                    notes,
                    reason,
                    version: so.version,
                  },
                }),
              )
            }
          >
            Salvar
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Prioridade">
          {(p) => (
            <Select
              {...p}
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
            >
              {PRIORITIES.map((x) => (
                <option key={x} value={x}>
                  {PRIORITY_LABEL[x]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Prazo prometido">
          {(p) => (
            <Input
              {...p}
              type="date"
              value={promisedDate}
              onChange={(e) => setPromisedDate(e.target.value)}
            />
          )}
        </Field>
        <Field label="Responsável técnico">
          {(p) => (
            <Select {...p} value={lead} onChange={(e) => setLead(e.target.value)}>
              <option value="">A definir</option>
              {so.technicalLead && !employees.data && (
                <option value={so.technicalLead.id}>{so.technicalLead.displayName}</option>
              )}
              {employees.data
                ?.filter((e) => e.active)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.displayName} — {e.jobTitle}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label="Instruções técnicas" className="sm:col-span-3">
          {(p) => (
            <Textarea
              {...p}
              rows={3}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          )}
        </Field>
        <Field label="Observações" className="sm:col-span-3">
          {(p) => (
            <Textarea {...p} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          )}
        </Field>
        <Field label="Motivo da alteração (histórico)" className="sm:col-span-3">
          {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

function EditItemDialog({
  so,
  item,
  onClose,
}: {
  so: ServiceOrderDto;
  item: ServiceOrderItemDto;
  onClose: () => void;
}) {
  const [v, setV] = useState({
    serviceType: item.serviceType,
    description: item.description,
    fabricName: item.fabricName ?? '',
    fabricColor: item.fabricColor ?? '',
    fabricReference: item.fabricReference ?? '',
    foamSpecs: item.foamSpecs ?? '',
    technicalNotes: item.technicalNotes ?? '',
    reason: '',
  });
  const set = (k: keyof typeof v, value: string) => setV({ ...v, [k]: value });
  const { m, error } = useSoMutation(so.id, onClose, 'Especificações atualizadas.');
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Especificações de ${item.code}`}
      description="Toda alteração fica registrada no histórico técnico da OS."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            onClick={() =>
              m.mutate(() =>
                api<ServiceOrderDto>(`/api/v1/service-orders/${so.id}/items/${item.id}`, {
                  method: 'PUT',
                  body: { ...v, version: item.version },
                }),
              )
            }
          >
            Salvar especificações
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tipo de serviço">
          {(p) => (
            <Select
              {...p}
              value={v.serviceType}
              onChange={(e) => set('serviceType', e.target.value as ServiceType)}
            >
              {SERVICE_TYPES.map((s) => (
                <option key={s} value={s}>
                  {SERVICE_TYPE_LABEL[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Descrição">
          {(p) => (
            <Input
              {...p}
              value={v.description}
              onChange={(e) => set('description', e.target.value)}
            />
          )}
        </Field>
        <Field label="Tecido escolhido">
          {(p) => (
            <Input
              {...p}
              value={v.fabricName}
              onChange={(e) => set('fabricName', e.target.value)}
            />
          )}
        </Field>
        <Field label="Cor">
          {(p) => (
            <Input
              {...p}
              value={v.fabricColor}
              onChange={(e) => set('fabricColor', e.target.value)}
            />
          )}
        </Field>
        <Field label="Referência">
          {(p) => (
            <Input
              {...p}
              value={v.fabricReference}
              onChange={(e) => set('fabricReference', e.target.value)}
            />
          )}
        </Field>
        <Field label="Espumas / especificações">
          {(p) => (
            <Input {...p} value={v.foamSpecs} onChange={(e) => set('foamSpecs', e.target.value)} />
          )}
        </Field>
        <Field label="Observações técnicas" className="sm:col-span-2">
          {(p) => (
            <Textarea
              {...p}
              rows={2}
              value={v.technicalNotes}
              onChange={(e) => set('technicalNotes', e.target.value)}
            />
          )}
        </Field>
        <Field label="Motivo da alteração" className="sm:col-span-2">
          {(p) => (
            <Input
              {...p}
              value={v.reason}
              onChange={(e) => set('reason', e.target.value)}
              placeholder="Ex.: cliente trocou o tecido"
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

function MeasureDialog({
  so,
  item,
  onClose,
}: {
  so: ServiceOrderDto;
  item: ServiceOrderItemDto;
  onClose: () => void;
}) {
  const [rows, setRows] = useState(
    item.measurements.length
      ? item.measurements.map((x) => ({
          label: x.label,
          value: String(x.valueCm).replace('.', ','),
        }))
      : [
          { label: 'Largura', value: '' },
          { label: 'Profundidade', value: '' },
          { label: 'Altura', value: '' },
        ],
  );
  const [notes, setNotes] = useState(item.measurementNotes ?? '');
  const { m, error, setError } = useSoMutation(so.id, onClose, 'Medidas registradas.');
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Medidas de ${item.code}`}
      description="Medição de rotina às sextas pelo gestor; nos demais casos é registrada como extraordinária."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            onClick={() => {
              const measurements = rows
                .filter((r) => r.label.trim() || r.value.trim())
                .map((r) => ({
                  label: r.label.trim(),
                  valueCm: Number(r.value.replace(',', '.')),
                }));
              if (measurements.some((x) => !x.label || !(x.valueCm > 0))) {
                setError('Preencha nome e valor (em cm) de cada medida.');
                return;
              }
              m.mutate(() =>
                api<ServiceOrderDto>(
                  `/api/v1/service-orders/${so.id}/items/${item.id}/measurements`,
                  {
                    method: 'PUT',
                    body: { measurements, notes, version: item.version },
                  },
                ),
              );
            }}
          >
            Salvar medidas
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <ul className="space-y-2">
        {rows.map((r, idx) => (
          <li key={idx} className="grid grid-cols-[1fr_120px_auto] items-end gap-2">
            <Field label={idx === 0 ? 'Medida' : ' '}>
              {(p) => (
                <Input
                  {...p}
                  aria-label={`Nome da medida ${idx + 1}`}
                  value={r.label}
                  onChange={(e) =>
                    setRows(rows.map((x, i) => (i === idx ? { ...x, label: e.target.value } : x)))
                  }
                />
              )}
            </Field>
            <Field label={idx === 0 ? 'cm' : ' '}>
              {(p) => (
                <Input
                  {...p}
                  aria-label={`Valor em cm da medida ${idx + 1}`}
                  inputMode="decimal"
                  value={r.value}
                  onChange={(e) =>
                    setRows(rows.map((x, i) => (i === idx ? { ...x, value: e.target.value } : x)))
                  }
                />
              )}
            </Field>
            <Button
              variant="ghost"
              aria-label={`Remover medida ${idx + 1}`}
              icon={<Trash2 className="size-4" aria-hidden />}
              onClick={() => setRows(rows.filter((_, i) => i !== idx))}
            />
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        variant="secondary"
        className="mt-3"
        icon={<Plus className="size-3.5" aria-hidden />}
        onClick={() => setRows([...rows, { label: '', value: '' }])}
      >
        Adicionar medida
      </Button>
      <Field label="Observações da medição" className="mt-4">
        {(p) => (
          <Textarea {...p} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        )}
      </Field>
    </Dialog>
  );
}

function MaterialsTab({ so, manage }: { so: ServiceOrderDto; manage: boolean }) {
  const can = useCan();
  const canSeeMeasurements =
    can('medicoes.gerenciar') || can('materiais.ver') || can('materiais.aprovar');
  const measurements = useMeasurements({ serviceOrderId: so.id }, canSeeMeasurements);
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<MaterialKind>('TECIDO');
  const [sourcing, setSourcing] = useState<MaterialSourcing>('EXCLUSIVO_OS');
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState('m');
  const [itemId, setItemId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const done = (data: ServiceOrderDto) => {
    qc.setQueryData(['service-order', so.id], data);
    void qc.invalidateQueries({ queryKey: ['service-order', so.id, 'revisions'] });
  };
  const add = useMutation({
    mutationFn: () =>
      api<ServiceOrderDto>(`/api/v1/service-orders/${so.id}/materials`, {
        method: 'POST',
        body: materialRequirementSchema.parse({
          kind,
          sourcing: kind === 'TECIDO' ? 'EXCLUSIVO_OS' : sourcing,
          description,
          quantity: quantity ? Number(quantity.replace(',', '.')) : null,
          unit,
          serviceOrderItemId: itemId || null,
        }),
      }),
    onSuccess: (d) => {
      done(d);
      setDescription('');
      setQuantity('');
      setError(null);
      toast('ok', 'Material previsto.');
    },
    onError: (e) =>
      setError(
        e instanceof ApiError
          ? e.message
          : ((e as { issues?: { message: string }[] }).issues?.[0]?.message ?? 'Revise os dados.'),
      ),
  });
  const remove = useMutation({
    mutationFn: (mid: string) =>
      api<ServiceOrderDto>(`/api/v1/service-orders/${so.id}/materials/${mid}`, {
        method: 'DELETE',
      }),
    onSuccess: done,
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <div className="space-y-6">
      <Alert tone="info" title="Materiais da OS">
        Materiais aprovados vêm das medições conferidas pelo gestor (aprovado para compra não
        significa comprado nem recebido). Compras, estoque e conferência de chegada serão liberados
        na próxima fase. Tecidos são sempre comprados especificamente para a OS; a chegada de
        materiais não antecipa a programação.
      </Alert>
      {canSeeMeasurements && (
        <div>
          <h2 className="mb-2 font-semibold">Medições desta OS</h2>
          {measurements.data ? (
            <MeasurementList rows={measurements.data} empty="Nenhuma medição solicitada." />
          ) : (
            <Spinner />
          )}
        </div>
      )}
      <Section title="Materiais previstos" bodyClassName="p-0">
        {so.materials.length === 0 ? (
          <EmptyState title="Nenhum material previsto" />
        ) : (
          <ul className="divide-y divide-line" data-testid="materials">
            {so.materials.map((mt) => (
              <li key={mt.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <span className="font-medium">{MATERIAL_KIND_LABEL[mt.kind]}</span>
                <span className="flex-1">
                  {[
                    mt.description,
                    mt.foamDensity,
                    mt.thicknessCm ? `${String(mt.thicknessCm).replace('.', ',')} cm` : null,
                    mt.color,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  {mt.quantity
                    ? ` · ${String(mt.quantity).replace('.', ',')} ${(mt.unit && MATERIAL_UNIT_LABEL[mt.unit as MaterialUnit]) ?? mt.unit ?? ''}`
                    : ''}
                  {mt.serviceOrderItemId
                    ? ` · ${so.items.find((i) => i.id === mt.serviceOrderItemId)?.code ?? ''}`
                    : ''}
                </span>
                <span className="text-ink-muted">{MATERIAL_SOURCING_LABEL[mt.sourcing]}</span>
                {mt.origin === 'SOLICITACAO_APROVADA' ? (
                  <Badge tone="ok">Aprovado para compra</Badge>
                ) : (
                  <Badge>Previsão manual</Badge>
                )}
                {manage && mt.origin !== 'SOLICITACAO_APROVADA' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remover ${mt.description}`}
                    icon={<Trash2 className="size-3.5" aria-hidden />}
                    onClick={() => remove.mutate(mt.id)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      {manage && (
        <Section title="Prever material">
          {error && (
            <Alert tone="danger" className="mb-4">
              {error}
            </Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-6">
            <Field label="Tipo" className="sm:col-span-2">
              {(p) => (
                <Select
                  {...p}
                  value={kind}
                  onChange={(e) => setKind(e.target.value as MaterialKind)}
                >
                  {MATERIAL_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {MATERIAL_KIND_LABEL[k]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Origem"
              className="sm:col-span-4"
              hint={kind === 'TECIDO' ? 'Tecido: sempre compra exclusiva para a OS.' : undefined}
            >
              {(p) => (
                <Select
                  {...p}
                  value={kind === 'TECIDO' ? 'EXCLUSIVO_OS' : sourcing}
                  disabled={kind === 'TECIDO'}
                  onChange={(e) => setSourcing(e.target.value as MaterialSourcing)}
                >
                  {MATERIAL_SOURCINGS.map((s) => (
                    <option key={s} value={s}>
                      {MATERIAL_SOURCING_LABEL[s]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Descrição" className="sm:col-span-3">
              {(p) => (
                <Input
                  {...p}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              )}
            </Field>
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
            <Field label="Unidade">
              {(p) => <Input {...p} value={unit} onChange={(e) => setUnit(e.target.value)} />}
            </Field>
            <Field label="Peça">
              {(p) => (
                <Select {...p} value={itemId} onChange={(e) => setItemId(e.target.value)}>
                  <option value="">Toda a OS</option>
                  {so.items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.code}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Button
            className="mt-4"
            loading={add.isPending}
            icon={<Plus className="size-4" aria-hidden />}
            onClick={() => add.mutate()}
          >
            Adicionar material
          </Button>
        </Section>
      )}
    </div>
  );
}

function CancelDialog({ so, onClose }: { so: ServiceOrderDto; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const { m, error } = useSoMutation(so.id, onClose, 'OS cancelada.');
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Cancelar a OS ${so.code}?`}
      description="As peças voltam a ficar disponíveis para uma nova OS. O histórico é preservado."
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
                api<ServiceOrderDto>(`/api/v1/service-orders/${so.id}/cancel`, {
                  method: 'POST',
                  body: { reason, version: so.version },
                }),
              )
            }
          >
            Cancelar OS
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
          <Textarea
            {...p}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            autoFocus
          />
        )}
      </Field>
    </Dialog>
  );
}
