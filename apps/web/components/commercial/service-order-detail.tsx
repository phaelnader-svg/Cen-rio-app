'use client';

import { nextStepOf, plural } from '@cenario/shared';
import type {
  Permission,
  Priority,
  ReadinessState,
  ServiceOrderDto,
  ServiceOrderItemDto,
  ServiceType,
} from '@cenario/shared';
import {
  FULFILLMENT_STAGE_LABEL,
  MEASUREMENT_KIND_LABEL,
  PIECE_TYPE_LABEL,
  PRIORITIES,
  PRIORITY_LABEL,
  SERVICE_TYPES,
  SERVICE_TYPE_LABEL,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Ban,
  CheckCircle2,
  Circle,
  Clock3,
  FileText,
  Info,
  Pencil,
  Plus,
  Ruler,
  Trash2,
  Undo2,
} from 'lucide-react';
import Link from 'next/link';
import { buttonClass } from '@/components/ui/button-styles';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, Avatar, Badge, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { OsDirectDelivery } from '@/components/commercial/os-direct-delivery';
import { OsMaterialList } from '@/components/commercial/os-material-list';
import { CustomerWhatsApp } from '@/components/commercial/customer-whatsapp';
import { OsStateHeader, useOperationalState } from '@/components/commercial/os-state';
import { useOsMaterialList } from '@/lib/simple-materials';
import { OsAlbumPanel, QrLabelButton } from '@/components/improvements/os-extras';
import { useTabParam } from '@/lib/tab-param';
import { ApiError, api, errorMessage } from '@/lib/api';
import { formatDay, useServiceOrder, useServiceOrderRevisions } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import { useEmployees, useServiceTimeline } from '@/lib/queries';
import { usePieces } from '@/lib/quality';
import { OsProduction } from '@/components/production/os-production';
import { DeadlineBadge, PriorityBadge, ReworkBanner, ServiceOrderStatusBadge } from './badges';
import { MaterialPurchasedButton } from './material-purchased';
import { NextStepButton } from '@/components/production/next-step';
import { ReworkFromOrder } from '@/components/quality/reworks-page';
import { PhotoGallery } from './photo-gallery';
import { BackLink, Detail, Section } from './section';
import { OsLabor } from '@/components/finance/service-order-labor';

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
  INFORMATIVO: 'Não impede o início',
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
  const Icon =
    state === 'OK'
      ? CheckCircle2
      : state === 'PENDENTE'
        ? Circle
        : state === 'INFORMATIVO'
          ? Info
          : Clock3;
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

/**
 * Reformulação, Fase 2 — OS unificada: de 10 para 6 abas. Abas antigas viram seções de outras
 * (nada some) e os links antigos continuam funcionando pelos apelidos abaixo.
 */
const OS_TABS = [
  'resumo',
  'pecas',
  'materiais',
  'producao',
  'qualidade',
  'album',
  'historico',
] as const;
const OS_TAB_ALIASES = {
  fotos: 'pecas',
  'linha-do-tempo': 'historico',
  entrega: 'qualidade',
  'mao-de-obra': 'resumo',
} as const;

export function ServiceOrderDetail({ id }: { id: string }) {
  const can = useCan();
  const so = useServiceOrder(id);
  const revisions = useServiceOrderRevisions(id);
  const [tab, setTab] = useTabParam('resumo', OS_TABS, OS_TAB_ALIASES);
  // Contador da aba: lista simples de materiais da OS.
  const simpleMaterials = useOsMaterialList(id);
  const [editing, setEditing] = useState(false);
  const [editItem, setEditItem] = useState<ServiceOrderItemDto | null>(null);
  const [measureItem, setMeasureItem] = useState<ServiceOrderItemDto | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [rework, setRework] = useState(false);
  const opState = useOperationalState(id, can('os.ver'));

  if (so.isPending) return <Spinner />;
  if (so.isError) return <Alert tone="danger">{so.error.message}</Alert>;
  const s = so.data;
  const open = s.status === 'ABERTA';
  const manage = can('os.gerenciar') && open;
  const productionDone = ['PRONTA_PARA_ENTREGA', 'EM_ENTREGA', 'ENTREGUE', 'DEVOLVIDA'].includes(
    opState.data?.state ?? '',
  );
  // Registro direto das medidas das peças: gestão.
  const canMeasure = can('os.gerenciar') && open;
  const canProduction = can('producao.ver') || can('producao.planejar');
  const canQuality = ['qualidade.gerenciar', 'entregas.ver', 'entregas.gerenciar'].some((p) =>
    can(p as Permission),
  );
  // Reformulação, Fase 1: entrega confirmada direto na OS (com ou sem a logística ligada).
  const canDelivery = can('os.ver') || can('entregas.ver');
  // Evolução Fase 5: valores de mão de obra só para quem vê o financeiro.
  const canLabor = can('financeiro.ver');
  const next = opState.data
    ? nextStepOf({
        state: opState.data.state,
        reasons: opState.data.items.flatMap((i) => i.reasons),
        materialPurchased: Boolean(s.materialPurchasedAt),
        cancelled: !open,
      })
    : null;
  // "Voltou com defeito": mesmas permissões do Novo retrabalho.
  const canRework = can('os.gerenciar') && can('pedidos.gerenciar') && can('retiradas.gerenciar');

  return (
    <>
      <BackLink href="/painel/os" label="Ordens de serviço" />
      {rework && (
        <ReworkFromOrder
          onClose={() => setRework(false)}
          order={{ id: s.order.id, code: s.order.code }}
        />
      )}
      <ReworkBanner rework={s.rework} />
      {s.onSite && (
        <Alert tone="info" className="mb-4" title="Serviço no local" data-testid="os-on-site">
          Feito na casa do cliente
          {s.onSite.date
            ? ` em ${formatDay(s.onSite.date, true)}${s.onSite.windowStart ? `, chegada ${s.onSite.windowStart}` : ''}`
            : ''}
          {s.onSite.address ? `. Endereço: ${s.onSite.address}` : ''}. A peça não vem para a
          tapeçaria: leve o material e as ferramentas. Ao terminar, use “Marcar como entregue”.
        </Alert>
      )}
      <PageHeader
        title={s.code}
        description={`${s.customer.name} · pedido ${s.order.code} · criada em ${formatDateTime(s.createdAt)}${s.createdBy ? ` por ${s.createdBy}` : ''}`}
        actions={
          <>
            <Link
              href={`/painel/os/${s.id}/ficha`}
              className={buttonClass('secondary', 'md')}
              data-testid="os-open-sheet"
            >
              <FileText className="size-4" aria-hidden />
              Abrir OS
            </Link>
            {s.status !== 'CANCELADA' && (
              <QrLabelButton
                serviceOrderId={s.id}
                code={s.code}
                customerName={s.customer.name}
                pieces={s.items.flatMap((it) =>
                  Array.from({ length: Math.max(1, it.quantity) }, (_, n) => ({
                    code: it.quantity > 1 ? `${it.code} (${n + 1}/${it.quantity})` : it.code,
                    description: it.description,
                  })),
                )}
              />
            )}
            {s.status !== 'CANCELADA' && can('clientes.ver') && (
              <CustomerWhatsApp
                customerId={s.customer.id}
                customerName={s.customer.name}
                code={s.code}
                piece={
                  s.items.length === 1
                    ? `o seu ${s.items[0]!.description.toLowerCase()}`
                    : 'o seu pedido'
                }
                date={
                  s.promisedDate ? s.promisedDate.split('-').reverse().slice(0, 2).join('/') : null
                }
              />
            )}
            {manage && (
              <>
                {
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
                }
              </>
            )}
          </>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {/* Fase 3: "Aberta" ficava ao lado de "Entregue" (a OS continua aberta no banco depois da
            entrega). A situação geral fica no quadro abaixo; aqui só o cancelamento. */}
        {s.status === 'CANCELADA' && <ServiceOrderStatusBadge status={s.status} />}
        {s.status === 'ABERTA' && !s.materialPurchasedAt && (
          <span data-testid="os-material">
            <MaterialPurchasedButton os={s} canManage={manage} />
          </span>
        )}
        {/* Oficina sem tablet (2026-11-24): a próxima etapa, um clique, na ordem da oficina. */}
        {next && (
          <NextStepButton
            size="md"
            os={{
              id: s.id,
              code: s.code,
              nextStep: next,
              customer: s.customer,
              pieces:
                s.items.length === 1
                  ? `o seu ${s.items[0]!.description.toLowerCase()}`
                  : 'o seu pedido',
            }}
          />
        )}
        {s.status === 'ABERTA' && s.materialPurchasedAt && (
          <span data-testid="os-material">
            <MaterialPurchasedButton os={s} canManage={manage} />
          </span>
        )}
        {opState.data?.state === 'ENTREGUE' && canRework && (
          <Button
            variant="outline-danger"
            icon={<Undo2 className="size-4" aria-hidden />}
            onClick={() => setRework(true)}
            data-testid="os-back-with-defect"
          >
            Voltou com defeito
          </Button>
        )}
        <PriorityBadge priority={s.priority} always />
        {s.promisedDate && (
          <span className="text-sm text-ink-muted">
            Prazo prometido: {formatDay(s.promisedDate, true)}
          </span>
        )}
        <DeadlineBadge deadline={s.deadline} withReasons />
      </div>
      {can('os.ver') && <OsStateHeader serviceOrderId={s.id} onGo={setTab} />}
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
          { key: 'pecas', label: 'Peças e fotos', count: s.items.length },
          {
            key: 'materiais',
            label: 'Materiais',
            count: simpleMaterials.data?.summary.total ?? 0,
          },
          ...(canProduction ? [{ key: 'producao', label: 'Produção' }] : []),
          ...(canQuality || canDelivery
            ? [{ key: 'qualidade', label: 'Qualidade e entrega' }]
            : []),
          { key: 'album', label: 'Álbum de fotos' },
          { key: 'historico', label: 'Histórico', count: revisions.data?.length },
        ]}
      >
        {tab === 'qualidade' && (canQuality || canDelivery) && (
          <div className="space-y-6">
            {canDelivery && <OsDirectDelivery serviceOrderId={s.id} />}
            {canQuality && (
              <Section title="Peças na qualidade e entrega" bodyClassName="p-0">
                <OsQualityDelivery serviceOrderId={s.id} />
              </Section>
            )}
          </div>
        )}
        {tab === 'producao' && canProduction && <OsProduction serviceOrderId={s.id} />}
        {tab === 'album' && <OsAlbumPanel serviceOrderId={s.id} />}
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
                <Detail label="Peças">{`${plural(s.pieceCount, 'peça', 'peças')} em ${plural(s.itemCount, 'item', 'itens')}`}</Detail>
                <div className="sm:col-span-2">
                  <Detail label="Instruções técnicas">{s.technicalInstructions}</Detail>
                </div>
                <div className="sm:col-span-2">
                  <Detail label="Observações">{s.notes}</Detail>
                </div>
              </dl>
            </Section>
            {/* Melhoria 167: depois que a produção termina, o quadro de prontidão sai da tela. */}
            {!productionDone && (
              <Section title="Prontidão para produção" className="lg:col-span-2">
                <ul className="divide-y divide-line" data-testid="readiness">
                  <ReadinessRow
                    label="Medidas"
                    state={s.readiness.measurements}
                    hint="Opcional: medidas das peças registradas na aba Peças. Não impedem o início da produção."
                  />
                  <ReadinessRow
                    label="Responsável técnico"
                    state={s.readiness.technicalLead}
                    hint="Tapeceiro principal da peça."
                  />
                  <ReadinessRow
                    label="Materiais"
                    state={s.readiness.simpleMaterialsPending > 0 ? 'INFORMATIVO' : 'OK'}
                    hint={
                      s.readiness.simpleMaterialsPending > 0
                        ? `Aviso: ${plural(s.readiness.simpleMaterialsPending, 'material da lista ainda não está', 'materiais da lista ainda não estão')} na oficina. Não impede o início.`
                        : 'Materiais informados na aba Materiais. Não impedem o início da produção.'
                    }
                  />
                  <ReadinessRow
                    label="Programação"
                    state={s.readiness.scheduling}
                    hint="Tarefas incluídas em planejamento semanal publicado."
                  />
                </ul>
                <p className="mt-3 rounded-lg bg-subtle px-3 py-2 text-xs text-ink-soft">
                  A produção começa quando programação, responsável e dependências permitirem.
                  Materiais pendentes aparecem só como aviso.
                </p>
              </Section>
            )}
            {canLabor && (
              <div className="lg:col-span-5" data-testid="os-labor-section">
                <h2 className="mb-3 text-base font-semibold">Mão de obra</h2>
                <OsLabor serviceOrderId={s.id} />
              </div>
            )}
          </div>
        )}

        {tab === 'pecas' && (
          <ul className="space-y-4">
            <li>
              <Section title="Fotos gerais da OS">
                <PhotoGallery entityType="SERVICE_ORDER" entityId={s.id} canManage={manage} />
              </Section>
            </li>
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
                    {/* Fase 2: a localização registrada no mapa da oficina. */}
                    <Detail label="Localização na oficina">
                      {i.currentLocation && (
                        <span data-testid={`so-item-location-${i.code}`}>
                          <Link
                            href="/painel/producao/mapa"
                            className="text-brand-700 hover:underline"
                          >
                            {i.currentLocation.label}
                          </Link>
                        </span>
                      )}
                    </Detail>
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
                        <dd className="mt-0.5 text-[15px] text-ink-muted">
                          Sem medidas registradas
                        </dd>
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

        {tab === 'materiais' && (
          <div className="space-y-8">
            <OsMaterialList serviceOrderId={s.id} open={open} />
          </div>
        )}

        {tab === 'historico' && (
          <div className="space-y-6">
            <ServiceTimeline serviceOrderId={s.id} />
            <Section title="Histórico técnico (revisões da OS)" bodyClassName="p-0">
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
          </div>
        )}
      </Tabs>

      {editing && <EditServiceOrderDialog so={s} onClose={() => setEditing(false)} />}
      {editItem && <EditItemDialog so={s} item={editItem} onClose={() => setEditItem(null)} />}
      {measureItem && (
        <MeasureDialog so={s} item={measureItem} onClose={() => setMeasureItem(null)} />
      )}
      {cancelling && <CancelDialog so={s} onClose={() => setCancelling(false)} />}
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
        <Field
          label="Prioridade"
          hint="Vale também no planejamento (tarefas ainda não iniciadas). Programação publicada: informe o motivo."
        >
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
          <li key={idx} className="grid grid-cols-[1fr_120px_auto] gap-2">
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
            <div className="field-action">
              <Button
                variant="ghost"
                aria-label={`Remover medida ${idx + 1}`}
                icon={<Trash2 className="size-4" aria-hidden />}
                onClick={() => setRows(rows.filter((_, i) => i !== idx))}
              />
            </div>
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

/** Fase 12: situação de cada peça da OS na qualidade e entrega (Fase 10; S1: sem embalagem). */
function OsQualityDelivery({ serviceOrderId }: { serviceOrderId: string }) {
  const q = usePieces({ serviceOrderId });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  if (!q.data.length) return <p className="text-sm text-ink-muted">Nenhuma peça nesta OS.</p>;
  return (
    <ul className="divide-y divide-line rounded-xl border border-line" data-testid="os-quality">
      {q.data.map((p) => (
        <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
          <span className="w-28 font-mono font-semibold">{p.code}</span>
          <span className="min-w-40 flex-1">
            {p.description} ({p.quantity})
            {p.location && <span className="text-ink-muted"> · {p.location.label}</span>}
          </span>
          <Badge
            tone={p.stage === 'ENTREGUE' ? 'ok' : p.stage === 'DEVOLVIDA' ? 'neutral' : 'info'}
          >
            {FULFILLMENT_STAGE_LABEL[p.stage]}
          </Badge>
          {p.inspection && (
            <Link
              className="text-brand-700 hover:underline"
              href={`/painel/qualidade/inspecoes/${p.inspection.id}`}
            >
              {p.inspection.code} (rodada {p.inspection.round})
            </Link>
          )}
          {p.delivery && (
            <Link
              className="text-brand-700 hover:underline"
              href={`/painel/entregas/${p.delivery.id}`}
            >
              {p.delivery.code} · {p.delivery.scheduledDate.split('-').reverse().join('/')}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

const TIMELINE_DOMAIN: Record<string, string> = {
  PEDIDO: 'Pedido',
  RETIRADA: 'Retirada',
  RECEBIMENTO: 'Recebimento',
  OS: 'OS',
  MEDICAO: 'Medição',
  PRODUCAO: 'Produção',
  QUALIDADE: 'Qualidade',
  ENTREGA: 'Entrega',
  FINANCEIRO: 'Cobrança',
  AUDITORIA: 'Registro',
};

/**
 * Fase 10 (plano principal): a história do serviço do pedido à cobrança, numa visão só,
 * montada a partir dos históricos que já existem (nada novo é gravado).
 */
function ServiceTimeline({ serviceOrderId }: { serviceOrderId: string }) {
  const q = useServiceTimeline(serviceOrderId);
  return (
    <Section title="Linha do tempo do serviço" bodyClassName="p-0">
      {q.isPending ? (
        <Spinner className="p-5" />
      ) : q.isError ? (
        <Alert tone="danger" title="Não foi possível carregar a linha do tempo" />
      ) : !q.data?.entries.length ? (
        <EmptyState title="Nada registrado ainda" />
      ) : (
        <ol className="divide-y divide-line" data-testid="service-timeline">
          {q.data.truncated && (
            <li className="px-5 py-2 text-xs text-ink-muted">
              Mostrando os registros mais recentes.
            </li>
          )}
          {q.data.entries.map((e, n) => (
            <li key={`${e.at}-${n}`} className="px-5 py-3">
              <p className="text-sm font-medium">
                <Badge tone="neutral">{TIMELINE_DOMAIN[e.domain] ?? e.domain}</Badge> {e.title}
              </p>
              {e.note && <p className="text-sm text-ink-soft">{e.note}</p>}
              <p className="text-xs text-ink-muted">
                {formatDateTime(e.at)} · {e.actor ?? 'Sistema'}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
