'use client';

import {
  PIECE_TYPE_LABEL,
  PRIORITY_LABEL,
  SERVICE_TYPE_LABEL,
  TASK_STATUS_LABEL,
  type ServiceOrderSheetDto,
  type TaskStatus,
} from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, Circle } from 'lucide-react';
import { useState } from 'react';
import { DocHeader, Eyebrow } from '@/components/quotes/documents';
import { Alert, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';

const day = (iso: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');

export const useServiceOrderSheet = (id: string) =>
  useQuery({
    queryKey: ['service-order', 'sheet', id],
    queryFn: () => api<ServiceOrderSheetDto>(`/api/v1/service-orders/${id}/sheet`),
  });

/**
 * 2026-11-18 (Raphael): a OS como página organizada, no mesmo estilo da proposta enviada ao
 * cliente, para a equipe da oficina. Só detalhes do serviço; nenhum valor.
 */
export function ServiceOrderSheet({ id }: { id: string }) {
  const q = useServiceOrderSheet(id);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  return <SheetDocument s={q.data} />;
}

function SheetDocument({ s }: { s: ServiceOrderSheetDto }) {
  const [photo, setPhoto] = useState<number | null>(null);
  const general = s.photos.filter((p) => !p.itemCode);
  return (
    <article
      className="print-page print-flat overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)]"
      data-testid="os-sheet"
    >
      <DocHeader
        company={s.companyName}
        logo={null}
        kicker={s.rework ? `Ordem de serviço · retrabalho ${s.rework.code}` : 'Ordem de serviço'}
        title={`${s.code} · ${s.customerName}`}
        description={`Pedido ${s.orderCode}`}
      />
      {s.rework && (
        <div className="border-b border-danger-600/30 bg-danger-50 px-6 py-3 text-sm text-danger-700 sm:px-8">
          <strong>Retrabalho:</strong> {s.rework.reason}
        </div>
      )}
      <div className="space-y-6 px-6 py-6 sm:px-8">
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Info label="Entregar até" value={day(s.promisedDate)} strong />
          <Info label="Prioridade" value={PRIORITY_LABEL[s.priority]} />
          <Info label="Responsável" value={s.technicalLead ?? '—'} />
          <Info label="Aberta em" value={day(s.createdAt)} />
        </dl>

        {s.technicalInstructions && (
          <section className="rounded-xl border border-line p-5">
            <Eyebrow>O que fazer</Eyebrow>
            <p className="mt-2 text-[15px] leading-relaxed whitespace-pre-line text-ink">
              {s.technicalInstructions}
            </p>
          </section>
        )}

        <section>
          <Eyebrow>{s.items.length === 1 ? 'Peça' : `Peças (${s.items.length})`}</Eyebrow>
          <div className="mt-2 space-y-3">
            {s.items.map((it) => {
              const photos = s.photos.filter((p) => p.itemCode === it.code);
              return (
                <div key={it.id} className="rounded-xl border border-line p-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-lg font-semibold">
                      {it.quantity > 1 ? `${it.quantity}× ` : ''}
                      {it.description}
                    </p>
                    <span className="font-mono text-sm text-ink-muted">{it.code}</span>
                  </div>
                  <p className="mt-0.5 text-sm text-ink-muted">
                    {PIECE_TYPE_LABEL[it.pieceType]} · {SERVICE_TYPE_LABEL[it.serviceType]}
                    {it.upholsterer ? ` · tapeceiro: ${it.upholsterer}` : ''}
                  </p>
                  <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                    <Info
                      label="Tecido"
                      value={
                        [
                          it.fabricName,
                          it.fabricColor,
                          it.fabricReference && `ref. ${it.fabricReference}`,
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'A definir'
                      }
                    />
                    <Info label="Espuma" value={it.foamSpecs || '—'} />
                  </dl>
                  {it.technicalNotes && (
                    <p className="mt-3 rounded-lg bg-subtle px-3 py-2 text-sm whitespace-pre-line">
                      {it.technicalNotes}
                    </p>
                  )}
                  {it.measurements.length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs font-medium text-ink-muted">Medidas</p>
                      <ul className="mt-1 flex flex-wrap gap-2 text-sm">
                        {it.measurements.map((m, i) => (
                          <li
                            key={i}
                            className="rounded-full bg-subtle px-3 py-1 tabular-nums ring-1 ring-line ring-inset"
                          >
                            {m.label}: {String(m.valueCm).replace('.', ',')} cm
                          </li>
                        ))}
                      </ul>
                      {it.measurementNotes && (
                        <p className="mt-1 text-sm text-ink-muted">{it.measurementNotes}</p>
                      )}
                    </div>
                  )}
                  {photos.length > 0 && <Thumbs photos={photos} all={s.photos} onOpen={setPhoto} />}
                </div>
              );
            })}
          </div>
        </section>

        {general.length > 0 && (
          <section>
            <Eyebrow>Fotos</Eyebrow>
            <Thumbs photos={general} all={s.photos} onOpen={setPhoto} large />
          </section>
        )}

        {s.materials.length > 0 && (
          <section className="rounded-xl border border-line p-5">
            <Eyebrow>Materiais</Eyebrow>
            <ul className="mt-2 divide-y divide-line text-sm">
              {s.materials.map((m, i) => (
                <li key={i} className="flex items-center gap-3 py-2">
                  {m.available ? (
                    <Check className="size-4 text-ok-600" aria-label="Separado" />
                  ) : (
                    <Circle className="size-4 text-ink-muted" aria-label="Falta separar" />
                  )}
                  <span className="flex-1">{m.description}</span>
                  <span className="tabular-nums text-ink-soft">
                    {[m.quantity, m.unit].filter(Boolean).join(' ')}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {s.tasks.length > 0 && (
          <section>
            <Eyebrow>Etapas</Eyebrow>
            <ol className="mt-2 space-y-1.5 text-sm">
              {s.tasks.map((t, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <span className="flex size-6 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">
                    {i + 1}
                  </span>
                  <span className="font-medium">{t.title}</span>
                  <span className="text-ink-muted">
                    {t.assignee ?? 'sem responsável'} ·{' '}
                    {TASK_STATUS_LABEL[t.status as TaskStatus] ?? t.status}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {s.notes && (
          <section>
            <Eyebrow>Observações</Eyebrow>
            <p className="mt-1 text-sm whitespace-pre-line text-ink-soft">{s.notes}</p>
          </section>
        )}
      </div>
      {photo !== null && s.photos[photo] && (
        <button
          type="button"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
          onClick={() => setPhoto(null)}
          aria-label="Fechar foto"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- foto protegida da OS */}
          <img
            src={s.photos[photo]!.url}
            alt={s.photos[photo]!.caption ?? 'Foto da OS'}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        </button>
      )}
    </article>
  );
}

function Info({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd className={clsx('mt-0.5', strong ? 'font-semibold' : 'text-ink')}>{value}</dd>
    </div>
  );
}

function Thumbs({
  photos,
  all,
  onOpen,
  large,
}: {
  photos: ServiceOrderSheetDto['photos'];
  all: ServiceOrderSheetDto['photos'];
  onOpen: (i: number) => void;
  large?: boolean;
}) {
  return (
    <ul
      className={clsx(
        'mt-3 grid gap-2',
        large ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-3 sm:grid-cols-5',
      )}
    >
      {photos.map((p) => (
        <li key={p.url}>
          <button
            type="button"
            onClick={() => onOpen(all.indexOf(p))}
            className="block w-full overflow-hidden rounded-lg ring-1 ring-line"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- miniatura protegida */}
            <img
              src={p.thumbUrl}
              alt={p.caption ?? 'Foto'}
              className="aspect-[4/3] w-full object-cover"
            />
          </button>
          {p.caption && <p className="mt-1 truncate text-xs text-ink-muted">{p.caption}</p>}
        </li>
      ))}
    </ul>
  );
}
