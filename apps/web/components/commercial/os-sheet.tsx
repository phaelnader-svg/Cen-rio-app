'use client';

import {
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
import { fabricText, WorkChecks } from './quote-work';

const day = (iso: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');

export const useServiceOrderSheet = (id: string) =>
  useQuery({
    queryKey: ['service-order', 'sheet', id],
    queryFn: () => api<ServiceOrderSheetDto>(`/api/v1/service-orders/${id}/sheet`),
  });

/**
 * 2026-11-18 (Raphael): a OS como página organizada, no mesmo estilo da proposta enviada ao
 * cliente, para a equipe da oficina. Só detalhes do serviço; nenhum valor.
 * 2026-11-19 (Raphael): pensada para o tapeceiro — prazo e quem faz no topo, "O que fazer" com
 * as marcas do orçamento (trocar tecido, espuma…), recado, fotos, peças com medidas e materiais
 * com as medidas da espuma. Cada informação aparece uma vez só.
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
  const work = s.work;
  const owners = [...new Set(s.items.map((i) => i.upholsterer).filter(Boolean))].join(', ');
  const fabrics = new Set(s.items.map((i) => fabricOf(i, work)));
  const sameFabric = fabrics.size <= 1;
  const messages = [work?.notes, s.technicalInstructions, s.notes].filter(Boolean) as string[];
  // 2026-11-24 (Raphael): só a lista da própria OS — os materiais do orçamento não entram.
  const materials = s.materials.map((m) => ({
    name: m.description,
    amount: [m.quantity, m.unit].filter(Boolean).join(' '),
    ready: m.available,
  }));
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
        description={`Pedido ${s.orderCode} · aberta em ${day(s.createdAt)}`}
      />
      {s.rework && (
        <div className="border-b border-danger-600/30 bg-danger-50 px-6 py-3 text-sm text-danger-700 sm:px-8">
          <strong>Retrabalho:</strong> {s.rework.reason}
        </div>
      )}
      <div className="space-y-6 px-6 py-6 sm:px-8">
        {/* O essencial numa linha: até quando, quem faz e se é urgente. */}
        <dl className="grid grid-cols-2 gap-4 rounded-xl bg-subtle/60 p-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs font-medium text-ink-muted">Entregar até</dt>
            <dd className="mt-0.5 text-xl font-semibold tabular-nums" data-testid="sheet-due">
              {day(s.promisedDate)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-ink-muted">Tapeceiro</dt>
            <dd className="mt-0.5 text-xl font-semibold">{owners || 'A definir'}</dd>
          </div>
          <div className="col-span-2 sm:col-span-1">
            <dt className="text-xs font-medium text-ink-muted">Prioridade</dt>
            <dd
              className={clsx(
                'mt-0.5 text-xl font-semibold',
                (s.priority === 'ALTA' || s.priority === 'URGENTE') && 'text-danger-600',
              )}
            >
              {PRIORITY_LABEL[s.priority]}
            </dd>
          </div>
        </dl>

        {/* O que fazer: o serviço do orçamento, as marcas (trocar tecido, espuma…) e o tecido. */}
        <section className="rounded-xl border border-line p-5" data-testid="sheet-work">
          <Eyebrow>O que fazer</Eyebrow>
          <p className="mt-2 text-xl font-semibold">
            {work?.upholsteryService ||
              s.items
                .map((i) => SERVICE_TYPE_LABEL[i.serviceType])
                .filter(unique)
                .join(' · ')}
          </p>
          {work && work.checks.length > 0 && (
            <div className="mt-3">
              <WorkChecks checks={work.checks} large />
            </div>
          )}
          {sameFabric && (
            <p className="mt-4 text-[15px]">
              <span className="text-ink-muted">Tecido: </span>
              <strong>{s.items[0] ? fabricOf(s.items[0], work) : 'A definir'}</strong>
            </p>
          )}
          {messages.length > 0 && (
            <div className="mt-4 rounded-lg border-l-4 border-brand-600 bg-brand-50/60 px-4 py-3">
              <p className="text-xs font-semibold text-brand-700">Recado</p>
              <p className="mt-1 text-[15px] leading-relaxed whitespace-pre-line text-ink">
                {messages.join('\n')}
              </p>
            </div>
          )}
        </section>

        {general.length > 0 && (
          <section>
            <Eyebrow>Como a peça chegou</Eyebrow>
            <Thumbs photos={general} all={s.photos} onOpen={setPhoto} large />
          </section>
        )}

        <section>
          <Eyebrow>{s.items.length === 1 ? 'Peça' : `Peças (${s.items.length})`}</Eyebrow>
          <div className="mt-2 space-y-3">
            {s.items.map((it) => {
              const photos = s.photos.filter((p) => p.itemCode === it.code);
              const details: [string, string][] = [];
              if (!sameFabric) details.push(['Tecido', fabricOf(it, work)]);
              if (it.foamSpecs) details.push(['Espuma', it.foamSpecs]);
              if (s.items.length > 1 && it.upholsterer) details.push(['Tapeceiro', it.upholsterer]);
              return (
                <div key={it.id} className="rounded-xl border border-line p-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-lg font-semibold">
                      {it.quantity}× {it.description}
                    </p>
                    <span className="font-mono text-sm text-ink-muted">{it.code}</span>
                  </div>
                  {details.length > 0 && (
                    <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                      {details.map(([k, v]) => (
                        <Info key={k} label={k} value={v} />
                      ))}
                    </dl>
                  )}
                  {it.technicalNotes && (
                    <p className="mt-3 rounded-lg bg-subtle px-3 py-2 text-sm whitespace-pre-line">
                      {it.technicalNotes}
                    </p>
                  )}
                  <div className="mt-3">
                    <p className="text-xs font-medium text-ink-muted">Medidas</p>
                    {it.measurements.length > 0 ? (
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
                    ) : (
                      <p className="mt-1 text-sm text-ink-muted">Ainda não medida</p>
                    )}
                    {it.measurementNotes && (
                      <p className="mt-1 text-sm text-ink-muted">{it.measurementNotes}</p>
                    )}
                  </div>
                  {photos.length > 0 && <Thumbs photos={photos} all={s.photos} onOpen={setPhoto} />}
                </div>
              );
            })}
          </div>
        </section>

        {materials.length > 0 && (
          <section className="rounded-xl border border-line p-5">
            <Eyebrow>Materiais</Eyebrow>
            <ul className="mt-2 divide-y divide-line text-sm">
              {materials.map((m, i) => (
                <li key={i} className="flex items-center gap-3 py-2">
                  {m.ready ? (
                    <Check className="size-4 text-ok-600" aria-label="Separado" />
                  ) : (
                    <Circle className="size-4 text-ink-muted" aria-label="Falta separar" />
                  )}
                  <span className="flex-1">{m.name}</span>
                  <span className="tabular-nums text-ink-soft">{m.amount}</span>
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

const unique = <T,>(v: T, i: number, a: T[]) => a.indexOf(v) === i;

/** Tecido da peça (cor e referência juntas) com a metragem do orçamento. */
function fabricOf(it: ServiceOrderSheetDto['items'][number], work: ServiceOrderSheetDto['work']) {
  const base = fabricText(it.fabricName || work?.fabricName, work?.fabricMeters ?? null);
  return [
    base,
    it.fabricColor && `cor ${it.fabricColor}`,
    it.fabricReference && `ref. ${it.fabricReference}`,
  ]
    .filter(Boolean)
    .join(' · ');
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
