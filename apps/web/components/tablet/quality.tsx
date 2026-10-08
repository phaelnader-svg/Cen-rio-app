'use client';

import type { CheckResult, InspectionDto, ProductionTaskDto } from '@cenario/shared';
import {
  CHECK_RESULT_LABEL,
  FULFILLMENT_STAGE_LABEL,
  INSPECTION_REASON_LABEL,
  INSPECTION_STATUS_LABEL,
  PIECE_TYPE_LABEL,
  PRIORITY_LABEL,
  PROTECTIONS,
  PROTECTION_LABEL,
  SERVICE_TYPE_LABEL,
  TASK_STATUS_LABEL,
  type Protection,
} from '@cenario/shared';
import clsx from 'clsx';
import {
  BadgeCheck,
  Camera,
  Check,
  ChevronRight,
  Minus,
  PackageCheck,
  ThumbsDown,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useSend } from '@/components/production/use-send';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/misc';
import { api, newIdempotencyKey } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useInspection, useInspections, useLocations, usePackagingRecord } from '@/lib/quality';
import { useOnline } from './tasks';

/**
 * Fase 10 — área "Inspeções" do Thiago no tablet: OS, peça, tipo de serviço, prazo,
 * prioridade, fotos, checklist e histórico de produção. Botões grandes, sem valores.
 */

const formatDay = (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : '—');

export function useMyInspectionCount(enabled: boolean) {
  const q = useInspections({ scope: 'mine' }, enabled);
  return enabled ? q.data?.length : undefined;
}

export function MyInspections({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useInspections({ scope: 'mine' });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  if (!q.data.length)
    return (
      <p className="rounded-2xl bg-subtle p-6 text-lg text-ink-muted" data-testid="no-inspections">
        Nenhuma inspeção aguardando você.
      </p>
    );
  return (
    <ul className="grid gap-4 lg:grid-cols-2" data-testid="my-inspections">
      {q.data.map((i) => (
        <li key={i.id}>
          <button
            type="button"
            onClick={() => onOpen(i.id)}
            className="flex w-full items-start gap-4 rounded-2xl border border-line bg-surface p-5 text-left shadow-[var(--shadow-card)] hover:border-brand-200"
            data-testid={`inspection-${i.code}`}
            aria-label={`Abrir inspeção ${i.code}`}
          >
            <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-50 text-brand-700">
              <BadgeCheck className="size-6" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-ink-muted">
                {i.code} · {i.piece.serviceOrder.code} · {i.piece.code}
              </span>
              <span className="mt-0.5 block text-xl font-semibold">{i.piece.description}</span>
              <span className="mt-0.5 block text-base text-ink-soft">
                {PIECE_TYPE_LABEL[i.piece.pieceType]} · {SERVICE_TYPE_LABEL[i.piece.serviceType]} ·{' '}
                {i.piece.customer}
              </span>
              <span className="mt-2 flex flex-wrap gap-2 text-sm">
                <span className="rounded-full bg-subtle px-3 py-1 font-semibold">
                  {INSPECTION_STATUS_LABEL[i.status]}
                </span>
                <span
                  className={clsx(
                    'rounded-full px-3 py-1 font-semibold',
                    i.priority === 'URGENTE' || i.priority === 'ALTA'
                      ? 'bg-danger-50 text-danger-600'
                      : 'bg-subtle text-ink-soft',
                  )}
                >
                  {PRIORITY_LABEL[i.priority]}
                </span>
                {i.dueDate && (
                  <span className="py-1 text-ink-muted">Prazo {formatDay(i.dueDate)}</span>
                )}
                {i.round > 1 && (
                  <span className="rounded-full bg-warn-50 px-3 py-1 font-semibold text-warn-600">
                    {INSPECTION_REASON_LABEL[i.reason]}
                  </span>
                )}
              </span>
            </span>
            <ChevronRight className="mt-1 size-6 shrink-0 text-ink-muted" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

const RESULT_TONE: Record<CheckResult, string> = {
  OK: 'bg-ok-600 text-white',
  NAO_CONFORME: 'bg-danger-600 text-white',
  NAO_SE_APLICA: 'bg-ink-muted text-white',
};

function ChecklistItem({
  i,
  item,
  disabled,
}: {
  i: InspectionDto;
  item: InspectionDto['items'][number];
  disabled: boolean;
}) {
  const online = useOnline();
  const { m, error } = useSend();
  const [defect, setDefect] = useState(false);
  const [note, setNote] = useState(item.note ?? '');
  const send = (result: CheckResult | null, n: string | null = null) =>
    m.mutate(
      {
        run: () =>
          api(`/api/v1/quality/inspections/${i.id}/items/${item.id}`, {
            method: 'PUT',
            body: { result, note: n },
          }),
      },
      { onSuccess: () => setDefect(false) },
    );
  return (
    <li
      className={clsx(
        'rounded-2xl border p-4',
        item.result === 'NAO_CONFORME'
          ? 'border-danger-600/40 bg-danger-50'
          : 'border-line bg-surface',
      )}
      data-testid={`check-${item.label}`}
      data-result={item.result ?? ''}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xl font-semibold">
            {item.label}
            {!item.required && (
              <span className="ml-2 text-sm font-normal text-ink-muted">(opcional)</span>
            )}
          </p>
          {item.guidance && <p className="text-base text-ink-muted">{item.guidance}</p>}
          {item.result && (
            <p className="mt-1 text-sm">
              <span
                className={clsx('rounded-full px-2 py-0.5 font-semibold', RESULT_TONE[item.result])}
              >
                {CHECK_RESULT_LABEL[item.result]}
              </span>
              {item.note && <span className="ml-2">{item.note}</span>}
            </p>
          )}
        </div>
        {!disabled && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="lg"
              variant={item.result === 'OK' ? 'primary' : 'secondary'}
              disabled={!online}
              loading={m.isPending}
              icon={<Check className="size-5" aria-hidden />}
              onClick={() => send('OK')}
            >
              Conforme
            </Button>
            <Button
              size="lg"
              variant={item.result === 'NAO_CONFORME' ? 'danger' : 'secondary'}
              disabled={!online}
              icon={<X className="size-5" aria-hidden />}
              onClick={() => setDefect(true)}
            >
              Não conforme
            </Button>
            {!item.required && (
              <Button
                size="lg"
                variant="secondary"
                disabled={!online}
                icon={<Minus className="size-5" aria-hidden />}
                onClick={() => send('NAO_SE_APLICA')}
              >
                Não se aplica
              </Button>
            )}
          </div>
        )}
      </div>
      {defect && (
        <div className="mt-3 space-y-2">
          <label className="block text-base font-medium" htmlFor={`defect-${item.id}`}>
            Defeito encontrado
          </label>
          <textarea
            id={`defect-${item.id}`}
            className="input min-h-20 w-full text-lg"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Ex.: ponto solto no braço esquerdo"
          />
          <div className="flex gap-2">
            <Button
              size="lg"
              variant="danger"
              disabled={!online || note.trim().length < 3}
              loading={m.isPending}
              onClick={() => send('NAO_CONFORME', note.trim())}
            >
              Registrar defeito
            </Button>
            <Button size="lg" variant="ghost" onClick={() => setDefect(false)}>
              Voltar
            </Button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-danger-600">{error}</p>}
    </li>
  );
}

function PhotoButton({ entityType, entityId }: { entityType: string; entityId: string }) {
  const { m, error } = useSend();
  return (
    <div>
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-2xl border border-line bg-surface px-5 py-3 text-lg font-semibold">
        <Camera className="size-6" aria-hidden /> Adicionar foto
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          data-testid="inspection-photo"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const fd = new FormData();
            fd.set('entityType', entityType);
            fd.set('entityId', entityId);
            fd.set('file', file);
            m.mutate({
              run: () => api('/api/v1/attachments', { method: 'POST', body: fd }),
              ok: 'Foto registrada.',
            });
            e.target.value = '';
          }}
        />
      </label>
      {error && <p className="mt-1 text-sm text-danger-600">{error}</p>}
    </div>
  );
}

export function InspectionDetail({ id, onDone }: { id: string; onDone: () => void }) {
  const q = useInspection(id);
  const online = useOnline();
  const { m, error } = useSend();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  // Uma chave por intenção (iniciar, decidir): repetir a mesma ação não duplica nada.
  const [key, setKey] = useState(newIdempotencyKey);
  const [startKey, setStartKey] = useState(newIdempotencyKey);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const i = q.data;
  const open = i.status === 'PENDENTE' || i.status === 'EM_ANDAMENTO';
  const unchecked = i.items.filter((x) => x.required && !x.result).length;
  const defects = i.items.filter((x) => x.result === 'NAO_CONFORME');
  const decide = (path: 'approve' | 'reject', body: Record<string, unknown>, ok: string) =>
    m.mutate(
      {
        run: () =>
          api(`/api/v1/quality/inspections/${i.id}/${path}`, {
            method: 'POST',
            body: { ...body, version: i.version },
            idempotencyKey: key,
          }),
        ok,
      },
      {
        // Nova chave depois de cada resposta: outra decisão nunca reaproveita a anterior.
        onSettled: () => setKey(newIdempotencyKey()),
        onSuccess: () => onDone(),
      },
    );
  return (
    <div className="space-y-6" data-testid="inspection-detail">
      <div>
        <p className="text-base text-ink-muted">
          {i.code} · {i.piece.serviceOrder.code} · {i.piece.code} · {i.piece.customer}
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{i.piece.description}</h1>
        <p className="mt-1 text-lg text-ink-soft">
          {PIECE_TYPE_LABEL[i.piece.pieceType]} · {SERVICE_TYPE_LABEL[i.piece.serviceType]} ·
          Prioridade {PRIORITY_LABEL[i.priority].toLowerCase()}
          {i.dueDate ? ` · Prazo ${formatDay(i.dueDate)}` : ''}
        </p>
        <p className="mt-2 text-base" data-testid="inspection-status">
          <span className="rounded-full bg-subtle px-3 py-1 font-semibold">
            {INSPECTION_STATUS_LABEL[i.status]}
          </span>{' '}
          <span className="text-ink-muted">
            {INSPECTION_REASON_LABEL[i.reason]} · rodada {i.round} ·{' '}
            {FULFILLMENT_STAGE_LABEL[i.piece.stage]}
          </span>
        </p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {open && !i.can.decide && i.can.decideReason && (
        <Alert tone="warn" title="Decisão reservada">
          {i.can.decideReason}
        </Alert>
      )}
      {i.can.start && (
        <Button
          size="xl"
          className="w-full"
          disabled={!online}
          loading={m.isPending}
          onClick={() =>
            m.mutate(
              {
                run: () =>
                  api(`/api/v1/quality/inspections/${i.id}/start`, {
                    method: 'POST',
                    body: { version: i.version },
                    idempotencyKey: startKey,
                  }),
                ok: 'Inspeção iniciada.',
              },
              { onSuccess: () => setStartKey(newIdempotencyKey()) },
            )
          }
        >
          Iniciar inspeção
        </Button>
      )}

      <section>
        <h2 className="mb-3 text-xl font-semibold">Checklist</h2>
        <ul className="space-y-3" data-testid="checklist">
          {i.items.map((item) => (
            <ChecklistItem key={item.id} i={i} item={item} disabled={!i.can.check} />
          ))}
        </ul>
      </section>

      <section className="flex flex-wrap items-center gap-4">
        {i.can.check && <PhotoButton entityType="QUALITY_INSPECTION" entityId={i.id} />}
        <span className="text-base text-ink-muted" data-testid="inspection-photos">
          {i.photos} foto(s)
        </span>
      </section>

      {i.can.decide && (
        <section
          className="space-y-3 rounded-2xl border border-line bg-subtle p-5"
          data-testid="inspection-decision"
        >
          <h2 className="text-xl font-semibold">Decisão</h2>
          {!rejecting ? (
            <>
              <label className="block text-base font-medium" htmlFor="approve-note">
                Observação (opcional)
              </label>
              <textarea
                id="approve-note"
                className="input min-h-16 w-full text-lg"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <Button
                  size="xl"
                  disabled={!online || unchecked > 0 || defects.length > 0}
                  loading={m.isPending}
                  icon={<BadgeCheck className="size-6" aria-hidden />}
                  onClick={() => decide('approve', { note: note.trim() || null }, 'Peça aprovada.')}
                >
                  Aprovar
                </Button>
                <Button
                  size="xl"
                  variant="danger"
                  disabled={!online || defects.length === 0}
                  icon={<ThumbsDown className="size-6" aria-hidden />}
                  onClick={() => setRejecting(true)}
                >
                  Reprovar
                </Button>
              </div>
              {unchecked > 0 && (
                <p className="text-base text-ink-muted">
                  Faltam {unchecked} item(ns) obrigatório(s).
                </p>
              )}
              {defects.length === 0 && (
                <p className="text-base text-ink-muted">Para reprovar, marque o defeito no item.</p>
              )}
            </>
          ) : (
            <>
              <p className="text-base">
                Defeitos:{' '}
                {defects.map((d) => `${d.label}${d.note ? ` (${d.note})` : ''}`).join('; ')}
              </p>
              <label className="block text-base font-medium" htmlFor="reject-reason">
                Motivo da reprovação
              </label>
              <textarea
                id="reject-reason"
                className="input min-h-20 w-full text-lg"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <p className="text-sm text-ink-muted">
                A correção vai para o responsável pela peça com prioridade alta; a embalagem fica
                bloqueada até a nova inspeção.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Button
                  size="xl"
                  variant="danger"
                  disabled={!online || reason.trim().length < 3}
                  loading={m.isPending}
                  onClick={() =>
                    decide('reject', { reason: reason.trim() }, 'Reprovação registrada.')
                  }
                >
                  Confirmar reprovação
                </Button>
                <Button size="xl" variant="secondary" onClick={() => setRejecting(false)}>
                  Voltar
                </Button>
              </div>
            </>
          )}
        </section>
      )}

      {!open && (
        <Alert
          tone={i.status === 'APROVADA' ? 'ok' : 'warn'}
          title={INSPECTION_STATUS_LABEL[i.status]}
        >
          {i.decidedBy ? `${i.decidedBy} · ${formatDateTime(i.decidedAt!)}` : ''}
          {i.decisionNote ? ` — ${i.decisionNote}` : ''}
        </Alert>
      )}

      <section>
        <h2 className="mb-3 text-xl font-semibold">Histórico de produção</h2>
        <ul className="space-y-2 text-lg" data-testid="inspection-production">
          {i.production.map((t) => (
            <li key={t.id} className="rounded-xl bg-subtle px-4 py-2">
              {t.code} · {t.title} — {TASK_STATUS_LABEL[t.status]}
              {t.assignee ? ` · ${t.assignee}` : ''}
            </li>
          ))}
          {i.corrections.map((t) => (
            <li key={t.id} className="rounded-xl bg-warn-50 px-4 py-2 text-warn-600">
              Correção {t.code} · {t.title} — {TASK_STATUS_LABEL[t.status]}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ─────────────────────────── Correção e embalagem (dentro da tarefa) ───────────────────────────

export function QualityInfo({ t, large }: { t: ProductionTaskDto; large?: boolean }) {
  if (!t.qualityFor) return null;
  const q = t.qualityFor;
  return (
    <span
      className={clsx(
        'mt-2 block rounded-xl px-3 py-2',
        q.kind === 'CORRECAO' ? 'bg-danger-50 text-danger-600' : 'bg-brand-50 text-brand-700',
        large ? 'text-lg' : 'text-sm',
      )}
      data-testid="quality-info"
    >
      {q.kind === 'CORRECAO' ? (
        <>
          Correção da inspeção {q.code}: {q.note}
          {q.defects.length > 0 && (
            <span className="block">
              Defeitos:{' '}
              {q.defects.map((d) => `${d.label}${d.note ? ` — ${d.note}` : ''}`).join('; ')}
            </span>
          )}
        </>
      ) : (
        <>Embalagem liberada pela aprovação {q.code}</>
      )}
    </span>
  );
}

/** Conclusão da embalagem: proteção usada e local onde a peça ficou (fotos opcionais). */
export function PackagingPanel({ packagingId }: { packagingId: string }) {
  const q = usePackagingRecord(packagingId);
  const locations = useLocations();
  const online = useOnline();
  const { m, error } = useSend();
  const [protection, setProtection] = useState<Protection | null>(null);
  const [locationId, setLocationId] = useState('');
  const [notes, setNotes] = useState('');
  const [key] = useState(newIdempotencyKey);
  if (q.isPending) return <Spinner />;
  if (q.isError) return null;
  const p = q.data;
  if (p.status === 'CONCLUIDA')
    return (
      <Alert tone="ok" title="Embalagem concluída">
        {p.protection ? PROTECTION_LABEL[p.protection] : ''} · {p.location?.label}
      </Alert>
    );
  if (p.status !== 'PENDENTE' && p.status !== 'EM_ANDAMENTO')
    return (
      <Alert tone="warn" title="Embalagem suspensa">
        {p.invalidReason ?? 'Aguarde nova aprovação da qualidade.'}
      </Alert>
    );
  const active = (locations.data ?? []).filter((l) => l.active);
  return (
    <section
      className="space-y-4 rounded-2xl border border-line bg-subtle p-5"
      data-testid="packaging-panel"
    >
      <h2 className="flex items-center gap-2 text-xl font-semibold">
        <PackageCheck className="size-6" aria-hidden /> Concluir embalagem ({p.code})
      </h2>
      <div>
        <p className="mb-2 text-base font-medium">Proteção usada</p>
        <div className="flex flex-wrap gap-2">
          {PROTECTIONS.map((x) => (
            <Button
              key={x}
              size="lg"
              variant={protection === x ? 'primary' : 'secondary'}
              onClick={() => setProtection(x)}
              aria-pressed={protection === x}
            >
              {PROTECTION_LABEL[x]}
            </Button>
          ))}
        </div>
      </div>
      <div>
        <label className="mb-2 block text-base font-medium" htmlFor="packaging-location">
          Onde a peça ficou
        </label>
        <select
          id="packaging-location"
          className="input w-full text-lg"
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
        >
          <option value="">Escolha o local</option>
          {active.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-2 block text-base font-medium" htmlFor="packaging-notes">
          Observações (opcional)
        </label>
        <textarea
          id="packaging-notes"
          className="input min-h-16 w-full text-lg"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>
      <PhotoButton entityType="PACKAGING" entityId={p.id} />
      {error && <Alert tone="danger">{error}</Alert>}
      <Button
        size="xl"
        className="w-full"
        disabled={!online || !protection || !locationId}
        loading={m.isPending}
        icon={<PackageCheck className="size-6" aria-hidden />}
        onClick={() =>
          m.mutate({
            run: () =>
              api(`/api/v1/packaging/${p.id}/complete`, {
                method: 'POST',
                body: { protection, locationId, notes: notes.trim() || null, version: p.version },
                idempotencyKey: key,
              }),
            ok: 'Embalagem concluída.',
          })
        }
      >
        Concluir embalagem
      </Button>
    </section>
  );
}
