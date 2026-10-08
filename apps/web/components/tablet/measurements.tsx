'use client';

import type { MeasurementSummaryDto } from '@cenario/shared';
import {
  MATERIAL_REQUEST_STATUS_LABEL,
  PIECE_TYPE_LABEL,
  SERVICE_TYPE_LABEL,
} from '@cenario/shared';
import clsx from 'clsx';
import { AlertTriangle, CalendarClock, ChevronRight, Ruler } from 'lucide-react';
import { useState } from 'react';
import { PhotoGallery } from '@/components/commercial/photo-gallery';
import { ItemsList } from '@/components/measurements/items-list';
import { MeasurementEditor } from '@/components/measurements/measurement-editor';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/misc';
import { formatDay } from '@/lib/commercial';
import { useMeasurement, useMyMeasurements } from '@/lib/measurements';

const returned = (m: MeasurementSummaryDto) => m.request?.status === 'DEVOLVIDA';
const open = (m: MeasurementSummaryDto) => m.status === 'PENDENTE' || m.status === 'EM_ANDAMENTO';

/** Contagem para o bloco da tela inicial (abertas + devolvidas). */
export function useMyOpenCount(enabled: boolean) {
  const q = useMyMeasurements(enabled);
  return q.data?.filter(open).length;
}

/** Lista "Medições atribuídas" do tablet: devolvidas primeiro, depois por prazo. */
export function MyMeasurements({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useMyMeasurements();
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const todo = q.data.filter(open).sort((a, b) => Number(returned(b)) - Number(returned(a)));
  const sent = q.data.filter((m) => !open(m));
  return (
    <div className="space-y-8">
      {todo.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-strong bg-surface/60 p-10 text-center">
          <Ruler className="mx-auto size-10 text-ink-muted" aria-hidden />
          <p className="mt-3 text-xl font-semibold">Nenhuma medição para fazer</p>
          <p className="mt-1 text-base text-ink-muted">
            Quando o gestor atribuir uma medição, ela aparece aqui na hora.
          </p>
        </div>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2" data-testid="my-measurements">
          {todo.map((m) => (
            <li key={m.id}>
              <MeasurementCard m={m} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
      {sent.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-ink-soft">Enviadas recentemente</h2>
          <ul className="grid gap-3 lg:grid-cols-2" data-testid="my-sent-measurements">
            {sent.map((m) => (
              <li key={m.id}>
                <MeasurementCard m={m} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function MeasurementCard({
  m,
  onOpen,
}: {
  m: MeasurementSummaryDto;
  onOpen: (id: string) => void;
}) {
  const back = returned(m);
  return (
    <button
      type="button"
      onClick={() => onOpen(m.id)}
      data-testid={`my-measurement-${m.code}`}
      className={clsx(
        'flex w-full items-center gap-4 rounded-2xl border bg-surface p-5 text-left shadow-[var(--shadow-card)] transition active:scale-[0.99]',
        back
          ? 'border-danger-600/40 ring-2 ring-danger-600/15'
          : 'border-line hover:border-brand-200',
      )}
    >
      <span
        className={clsx(
          'grid size-14 shrink-0 place-items-center rounded-2xl',
          back ? 'bg-danger-50 text-danger-600' : 'bg-brand-50 text-brand-700',
        )}
      >
        {back ? (
          <AlertTriangle className="size-7" aria-hidden />
        ) : (
          <Ruler className="size-7" aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xl font-semibold">
          {m.serviceOrder.code} ·{' '}
          {m.serviceOrderItem ? m.serviceOrderItem.description : 'OS inteira'}
        </span>
        <span className="mt-0.5 block truncate text-base text-ink-muted">
          {m.code} · {m.customer.name}
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          {back ? (
            <span className="rounded-full bg-danger-50 px-3 py-1 font-semibold text-danger-600">
              Devolvida — corrigir e reenviar
            </span>
          ) : m.request && m.request.status !== 'RASCUNHO' ? (
            <span className="rounded-full bg-subtle px-3 py-1 font-medium text-ink-soft">
              {MATERIAL_REQUEST_STATUS_LABEL[m.request.status]}
            </span>
          ) : (
            <span className="rounded-full bg-warn-50 px-3 py-1 font-medium text-warn-600">
              {m.status === 'PENDENTE' ? 'A fazer' : 'Em andamento'}
            </span>
          )}
          {open(m) && (
            <span
              className={clsx(
                'inline-flex items-center gap-1',
                m.overdue ? 'font-semibold text-danger-600' : 'text-ink-muted',
              )}
            >
              <CalendarClock className="size-4" aria-hidden />
              Prazo {formatDay(m.dueDate)}
            </span>
          )}
        </span>
      </span>
      <ChevronRight className="size-6 shrink-0 text-ink-muted" aria-hidden />
    </button>
  );
}

/** Detalhe da medição no tablet: dados técnicos, fotos e editor em etapas. */
export function MyMeasurementDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const q = useMeasurement(id);
  const [editing, setEditing] = useState(false);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const m = q.data;

  if (editing && m.can.edit) {
    return (
      <div>
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">
          {m.serviceOrder.code} · {m.code}
        </h1>
        <p className="mb-5 text-base text-ink-muted">{m.customer.name}</p>
        <MeasurementEditor
          m={m}
          large
          onClose={() => {
            setEditing(false);
            onBack();
          }}
        />
        <Button size="lg" variant="ghost" className="mt-2" onClick={() => setEditing(false)}>
          Ver dados da OS
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {m.serviceOrder.code} ·{' '}
            {m.serviceOrderItem ? m.serviceOrderItem.description : 'OS inteira'}
          </h1>
          <p className="mt-1 text-base text-ink-muted">
            {m.code} · {m.customer.name} · prazo {formatDay(m.dueDate)}
            {m.requestedBy ? ` · pedida por ${m.requestedBy}` : ''}
          </p>
        </div>
        {m.can.edit && (
          <Button
            size="xl"
            icon={<Ruler className="size-6" aria-hidden />}
            onClick={() => setEditing(true)}
          >
            {m.request?.status === 'DEVOLVIDA'
              ? 'Corrigir medição'
              : m.status === 'PENDENTE'
                ? 'Começar medição'
                : 'Continuar medição'}
          </Button>
        )}
      </div>

      {m.reason && (
        <Alert tone="info" title="Motivo">
          <span className="text-base">{m.reason}</span>
        </Alert>
      )}
      {m.returnReason && (
        <Alert tone="warn" title="Devolvida pelo gestor para correção">
          <span className="text-base">{m.returnReason}</span>
        </Alert>
      )}
      {m.status === 'CANCELADA' && <Alert tone="warn" title="Medição cancelada pelo gestor" />}
      {!m.can.edit && m.request && m.request.status !== 'RASCUNHO' && (
        <Alert tone="ok" title={`Solicitação: ${MATERIAL_REQUEST_STATUS_LABEL[m.request.status]}`}>
          <span className="text-base">
            {m.request.status === 'APROVADA'
              ? 'O gestor conferiu as quantidades. A compra é feita pelo gestor.'
              : 'Enviada ao gestor. Se precisar de correção, ela volta para você aqui.'}
          </span>
        </Alert>
      )}

      {m.items.length > 0 && !m.can.edit && (
        <section>
          <h2 className="mb-3 text-xl font-semibold">Materiais enviados</h2>
          <ItemsList large rows={m.items.map((i) => ({ ...i, key: i.id }))} />
        </section>
      )}

      {m.serviceOrderInfo.technicalInstructions && (
        <section className="rounded-2xl border border-line bg-surface p-5">
          <h2 className="text-lg font-semibold">Instruções técnicas da OS</h2>
          <p className="mt-1 text-base whitespace-pre-line text-ink-soft">
            {m.serviceOrderInfo.technicalInstructions}
          </p>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-xl font-semibold">Peças</h2>
        <ul className="space-y-4">
          {m.serviceOrderInfo.items.map((it) => (
            <li key={it.id} className="rounded-2xl border border-line bg-surface p-5">
              <p className="text-xl font-semibold">
                {it.code} · {it.quantity}× {PIECE_TYPE_LABEL[it.pieceType]}
              </p>
              <p className="text-base text-ink-soft">{it.description}</p>
              <dl className="mt-3 grid gap-3 text-base sm:grid-cols-2">
                <TechRow label="Serviço">
                  {SERVICE_TYPE_LABEL[it.serviceType as keyof typeof SERVICE_TYPE_LABEL] ??
                    it.serviceType}
                </TechRow>
                <TechRow label="Tecido">
                  {[it.fabricName, it.fabricColor, it.fabricReference].filter(Boolean).join(' · ')}
                </TechRow>
                <TechRow label="Espumas">{it.foamSpecs}</TechRow>
                <TechRow label="Medidas atuais">
                  {it.currentDimensions
                    .map((d) => `${d.label} ${String(d.valueCm).replace('.', ',')} cm`)
                    .join(' · ')}
                </TechRow>
                {it.technicalNotes && (
                  <div className="sm:col-span-2">
                    <TechRow label="Observações técnicas">{it.technicalNotes}</TechRow>
                  </div>
                )}
              </dl>
              <div className="mt-4">
                <PhotoGallery entityType="SERVICE_ORDER_ITEM" entityId={it.id} canManage={false} />
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 text-xl font-semibold">Fotos da OS</h2>
        <PhotoGallery entityType="SERVICE_ORDER" entityId={m.serviceOrder.id} canManage={false} />
      </section>
    </div>
  );
}

function TechRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="text-ink">{children || '—'}</dd>
    </div>
  );
}
