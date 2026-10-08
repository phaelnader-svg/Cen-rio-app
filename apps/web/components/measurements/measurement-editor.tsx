'use client';

import type { MaterialKind, MeasurementDetailDto } from '@cenario/shared';
import { MATERIAL_KIND_LABEL } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, ChevronLeft, ChevronRight, Plus, Save, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { decimalText, parseDecimal } from '@/lib/measurements';
import { ItemsList, OsTotals } from './items-list';
import { type ItemDraft, MaterialForm, type PieceOption } from './material-form';

type Step = 'pecas' | MaterialKind | 'revisar';
interface DimRow {
  label: string;
  value: string;
}
interface PieceState {
  rows: DimRow[];
  notes: string;
}

const DEFAULT_ROWS = ['Largura', 'Profundidade', 'Altura'];

function initialPieces(m: MeasurementDetailDto): Record<string, PieceState> {
  const out: Record<string, PieceState> = {};
  for (const it of m.serviceOrderInfo.items) {
    const saved = m.pieces.find((p) => p.serviceOrderItemId === it.id);
    const dims = saved?.dimensions.length ? saved.dimensions : it.currentDimensions;
    out[it.id] = {
      rows: dims.length
        ? dims.map((d) => ({ label: d.label, value: decimalText(d.valueCm) }))
        : DEFAULT_ROWS.map((label) => ({ label, value: '' })),
      notes: saved?.notes ?? '',
    };
  }
  return out;
}

function initialItems(m: MeasurementDetailDto): ItemDraft[] {
  return m.items.map((i) => ({
    key: i.id,
    serviceOrderItemId: i.serviceOrderItemId,
    kind: i.kind,
    sourcing: i.sourcing,
    description: i.description,
    color: i.color ?? '',
    reference: i.reference ?? '',
    foamDensity: i.foamDensity ?? '',
    thicknessCm: i.thicknessCm,
    lengthCm: i.lengthCm,
    widthCm: i.widthCm,
    quantity: i.quantity,
    unit: i.unit,
    notes: i.notes ?? '',
  }));
}

const stripKey = ({ key: _key, ...rest }: ItemDraft) => rest;

/**
 * Editor da medição em etapas curtas: medidas das peças → tecidos → espumas →
 * outros → revisar e enviar. Usado no tablet (modo `large`) e no painel.
 * Em `mode="review"` o gestor ajusta somente as quantidades (com motivo).
 */
export function MeasurementEditor({
  m,
  large,
  mode = 'execute',
  onClose,
}: {
  m: MeasurementDetailDto;
  large?: boolean;
  mode?: 'execute' | 'review';
  onClose?: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const review = mode === 'review';
  const steps: Step[] = review
    ? ['TECIDO', 'ESPUMA', 'OUTRO', 'revisar']
    : ['pecas', 'TECIDO', 'ESPUMA', 'OUTRO', 'revisar'];
  const [step, setStep] = useState<Step>(steps[0]!);
  const [pieces, setPieces] = useState(() => initialPieces(m));
  const [items, setItems] = useState(() => initialItems(m));
  const [notes, setNotes] = useState(m.notes ?? '');
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState<{ kind: MaterialKind; key: string | null } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [submitKey] = useState(newIdempotencyKey);

  const osCode = m.serviceOrder.code;
  const pieceOptions: PieceOption[] = m.serviceOrderInfo.items.map((i) => ({
    id: i.id,
    code: i.code,
    description: i.description,
  }));
  const codeOf = (id: string | null | undefined) =>
    id ? (pieceOptions.find((p) => p.id === id)?.code ?? null) : null;
  const rows = items.map((i) => ({
    ...i,
    color: i.color || null,
    reference: i.reference || null,
    foamDensity: i.foamDensity || null,
    thicknessCm: i.thicknessCm ?? null,
    lengthCm: i.lengthCm ?? null,
    widthCm: i.widthCm ?? null,
    notes: i.notes || null,
    itemCode: codeOf(i.serviceOrderItemId),
  }));

  function piecesPayload() {
    const out: {
      serviceOrderItemId: string;
      dimensions: { label: string; valueCm: number }[];
      notes: string;
    }[] = [];
    for (const [id, p] of Object.entries(pieces)) {
      // Linhas-modelo sem valor (ex.: "Altura" vazia) são ignoradas.
      const filled = p.rows.filter((r) => r.value.trim());
      const dims = filled.map((r) => ({ label: r.label.trim(), valueCm: parseDecimal(r.value) }));
      const code = codeOf(id);
      if (dims.some((d) => !d.label || !(d.valueCm > 0))) {
        throw new Error(`Preencha nome e valor (em cm) de cada medida de ${code}.`);
      }
      if (dims.length || p.notes.trim())
        out.push({ serviceOrderItemId: id, dimensions: dims, notes: p.notes });
    }
    return out;
  }

  const onFail = (e: unknown) => {
    if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
      setConflict(true);
      setError('Esta medição foi alterada em outro lugar. Recarregue para ver a versão atual.');
      return;
    }
    setError(e instanceof Error && !(e instanceof ApiError) ? e.message : errorMessage(e));
  };
  const accept = (d: MeasurementDetailDto) => {
    qc.setQueryData(['measurement', m.id], d);
    void qc.invalidateQueries({ queryKey: ['my-measurements'] });
    void qc.invalidateQueries({ queryKey: ['measurements'] });
    setDirty(false);
    setError(null);
    return d;
  };

  const saveDraft = () =>
    api<MeasurementDetailDto>(`/api/v1/measurements/${m.id}/draft`, {
      method: 'PUT',
      body: { pieces: piecesPayload(), items: items.map(stripKey), notes, version: m.version },
    }).then(accept);

  const draft = useMutation({
    mutationFn: saveDraft,
    onSuccess: () => toast('ok', 'Rascunho salvo.'),
    onError: onFail,
  });
  const submit = useMutation({
    mutationFn: async () => {
      const saved = await saveDraft();
      return api<MeasurementDetailDto>(`/api/v1/measurements/${m.id}/submit`, {
        method: 'POST',
        body: { version: saved.version },
        idempotencyKey: submitKey,
      }).then(accept);
    },
    onSuccess: () => {
      toast('ok', 'Medição enviada ao gestor.');
      onClose?.();
    },
    onError: onFail,
  });
  const revise = useMutation({
    mutationFn: () =>
      api<MeasurementDetailDto>(`/api/v1/measurements/${m.id}/request/items`, {
        method: 'PUT',
        body: { items: items.map(stripKey), reason, version: m.request!.version },
      }).then(accept),
    onSuccess: () => {
      toast('ok', 'Quantidades revisadas.');
      onClose?.();
    },
    onError: onFail,
  });

  const busy = draft.isPending || submit.isPending || revise.isPending;
  const idx = steps.indexOf(step);
  const countOf = (k: MaterialKind) => items.filter((i) => i.kind === k).length;
  const piecesFilled = Object.values(pieces).filter((p) =>
    p.rows.some((r) => r.value.trim()),
  ).length;
  const stepLabel = (s: Step) =>
    s === 'pecas'
      ? `Medidas (${piecesFilled}/${pieceOptions.length})`
      : s === 'revisar'
        ? review
          ? 'Confirmar'
          : 'Revisar e enviar'
        : `${s === 'OUTRO' ? 'Outros' : MATERIAL_KIND_LABEL[s] + 's'} (${countOf(s)})`;

  function upsert(item: ItemDraft) {
    setItems((cur) =>
      cur.some((x) => x.key === item.key)
        ? cur.map((x) => (x.key === item.key ? item : x))
        : [...cur, item],
    );
    setEditing(null);
    setDirty(true);
  }
  function setPiece(id: string, next: PieceState) {
    setPieces((cur) => ({ ...cur, [id]: next }));
    setDirty(true);
  }

  const inputCls = large ? 'h-14 text-lg' : undefined;
  const btn = large ? 'xl' : 'md';

  return (
    <div data-testid="measurement-editor">
      <ol className="mb-5 flex gap-2 overflow-x-auto pb-1" aria-label="Etapas">
        {steps.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              aria-current={s === step ? 'step' : undefined}
              onClick={() => {
                setEditing(null);
                setStep(s);
              }}
              className={clsx(
                'inline-flex items-center gap-2 rounded-full border font-medium whitespace-nowrap',
                large ? 'px-5 py-3 text-base' : 'px-3.5 py-1.5 text-sm',
                s === step
                  ? 'border-brand-700 bg-brand-700 text-white'
                  : 'border-line-strong bg-surface text-ink-soft hover:bg-subtle',
              )}
            >
              <span
                className={clsx(
                  'grid size-6 place-items-center rounded-full text-xs',
                  s === step ? 'bg-white/20' : 'bg-subtle',
                )}
              >
                {i < idx ? <Check className="size-3.5" aria-hidden /> : i + 1}
              </span>
              {stepLabel(s)}
            </button>
          </li>
        ))}
      </ol>

      {m.returnReason && !review && (
        <Alert tone="warn" className="mb-5" title="Devolvida pelo gestor para correção">
          {m.returnReason}
        </Alert>
      )}
      {error && (
        <Alert tone="danger" className="mb-5">
          {error}
          {conflict && (
            <Button
              size="sm"
              variant="secondary"
              className="ml-3"
              onClick={() => {
                void qc.invalidateQueries({ queryKey: ['measurement', m.id] });
                onClose?.();
              }}
            >
              Recarregar
            </Button>
          )}
        </Alert>
      )}

      {step === 'pecas' && (
        <ul className="space-y-5">
          {m.serviceOrderInfo.items.map((it) => {
            const p = pieces[it.id]!;
            return (
              <li
                key={it.id}
                className="rounded-2xl border border-line bg-surface p-4"
                data-testid={`piece-${it.code}`}
              >
                <p className={clsx('font-semibold', large && 'text-xl')}>
                  {it.code} · {it.description}{' '}
                  <span className="font-normal text-ink-muted">({it.quantity}×)</span>
                </p>
                {(it.fabricName || it.foamSpecs || it.technicalNotes) && (
                  <p className={clsx('mt-1 text-ink-muted', large ? 'text-base' : 'text-sm')}>
                    {[
                      it.fabricName &&
                        `Tecido: ${[it.fabricName, it.fabricColor].filter(Boolean).join(' · ')}`,
                      it.foamSpecs && `Espumas: ${it.foamSpecs}`,
                      it.technicalNotes,
                    ]
                      .filter(Boolean)
                      .join(' — ')}
                  </p>
                )}
                <ul className="mt-3 space-y-2">
                  {p.rows.map((r, k) => (
                    <li
                      key={k}
                      className="grid grid-cols-[1fr_8rem_auto] items-center gap-2 sm:grid-cols-[1fr_10rem_auto]"
                    >
                      <Input
                        aria-label={`Nome da medida ${k + 1} de ${it.code}`}
                        className={inputCls}
                        value={r.label}
                        onChange={(e) =>
                          setPiece(it.id, {
                            ...p,
                            rows: p.rows.map((x, j) =>
                              j === k ? { ...x, label: e.target.value } : x,
                            ),
                          })
                        }
                      />
                      <div className="relative">
                        <Input
                          aria-label={`${r.label || `Medida ${k + 1}`} de ${it.code} em cm`}
                          className={clsx(inputCls, 'pr-10 text-right tabular-nums')}
                          inputMode="decimal"
                          value={r.value}
                          onChange={(e) =>
                            setPiece(it.id, {
                              ...p,
                              rows: p.rows.map((x, j) =>
                                j === k ? { ...x, value: e.target.value } : x,
                              ),
                            })
                          }
                        />
                        <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-ink-muted">
                          cm
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size={large ? 'lg' : 'md'}
                        aria-label={`Remover medida ${k + 1} de ${it.code}`}
                        icon={<Trash2 className="size-4" aria-hidden />}
                        onClick={() =>
                          setPiece(it.id, { ...p, rows: p.rows.filter((_, j) => j !== k) })
                        }
                      />
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <Button
                    variant="secondary"
                    size={large ? 'lg' : 'sm'}
                    icon={<Plus className="size-4" aria-hidden />}
                    onClick={() =>
                      setPiece(it.id, { ...p, rows: [...p.rows, { label: '', value: '' }] })
                    }
                  >
                    Adicionar medida
                  </Button>
                  <Field label="Observação da peça" className="min-w-60 flex-1">
                    {(fp) => (
                      <Input
                        {...fp}
                        className={inputCls}
                        value={p.notes}
                        onChange={(e) => setPiece(it.id, { ...p, notes: e.target.value })}
                      />
                    )}
                  </Field>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {(step === 'TECIDO' || step === 'ESPUMA' || step === 'OUTRO') && (
        <div className="space-y-4">
          <ItemsList
            large={large}
            rows={rows.filter((r) => r.kind === step)}
            empty={`Nenhum ${step === 'OUTRO' ? 'outro material' : MATERIAL_KIND_LABEL[step].toLowerCase()} informado.`}
            onEdit={(key) => setEditing({ kind: step, key })}
            onRemove={(key) => {
              setItems((cur) => cur.filter((x) => x.key !== key));
              setDirty(true);
            }}
          />
          {editing?.kind === step ? (
            <MaterialForm
              key={editing.key ?? 'new'}
              kind={step}
              pieces={pieceOptions}
              large={large}
              initial={items.find((x) => x.key === editing.key)}
              onSave={upsert}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <Button
              size={btn}
              variant="secondary"
              icon={<Plus className="size-5" aria-hidden />}
              onClick={() => setEditing({ kind: step, key: null })}
            >
              {step === 'TECIDO'
                ? 'Adicionar tecido'
                : step === 'ESPUMA'
                  ? 'Adicionar espuma'
                  : 'Adicionar outro material'}
            </Button>
          )}
        </div>
      )}

      {step === 'revisar' && (
        <div className="space-y-5">
          {!review && (
            <div className="rounded-2xl border border-line bg-surface p-4">
              <p className={clsx('mb-2 font-semibold', large && 'text-lg')}>Medidas</p>
              <ul className="space-y-1 text-sm" data-testid="review-pieces">
                {m.serviceOrderInfo.items.map((it) => {
                  const filled = pieces[it.id]!.rows.filter((r) => r.value.trim());
                  return (
                    <li key={it.id}>
                      <span className="font-medium">{it.code}:</span>{' '}
                      {filled.length ? (
                        filled.map((r) => `${r.label} ${r.value} cm`).join(' · ')
                      ) : (
                        <span className="text-ink-muted">sem medidas</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <div className="rounded-2xl border border-line bg-surface p-4">
            <p className={clsx('mb-2 font-semibold', large && 'text-lg')}>Materiais por peça</p>
            <ItemsList rows={rows} large={large} />
          </div>
          {rows.length > 0 && (
            <div className="rounded-2xl border border-line bg-surface p-4">
              <p className={clsx('mb-2 font-semibold', large && 'text-lg')}>
                Total consolidado da {osCode}
              </p>
              <OsTotals rows={rows} osCode={osCode} />
            </div>
          )}
          {review ? (
            <Field
              label="Motivo da revisão"
              required
              hint="Fica registrado no histórico e é mostrado ao responsável."
            >
              {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
            </Field>
          ) : (
            <Field label="Observações gerais">
              {(p) => (
                <Textarea
                  {...p}
                  className={large ? 'text-lg' : undefined}
                  rows={2}
                  value={notes}
                  onChange={(e) => {
                    setNotes(e.target.value);
                    setDirty(true);
                  }}
                />
              )}
            </Field>
          )}
        </div>
      )}

      <div
        className={clsx(
          'mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-5',
          large && 'sticky bottom-0 -mx-1 bg-canvas/95 px-1 pb-4 backdrop-blur',
        )}
      >
        {idx > 0 && (
          <Button
            size={btn}
            variant="ghost"
            icon={<ChevronLeft className="size-5" aria-hidden />}
            onClick={() => setStep(steps[idx - 1]!)}
          >
            Voltar
          </Button>
        )}
        <span className="flex-1" />
        {!review && (
          <Button
            size={btn}
            variant="secondary"
            loading={draft.isPending}
            disabled={busy}
            icon={<Save className="size-5" aria-hidden />}
            onClick={() => draft.mutate()}
          >
            Salvar rascunho{dirty ? ' •' : ''}
          </Button>
        )}
        {step === 'revisar' ? (
          review ? (
            <Button
              size={btn}
              loading={revise.isPending}
              disabled={busy || reason.trim().length < 3 || items.length === 0}
              icon={<Check className="size-5" aria-hidden />}
              onClick={() => revise.mutate()}
            >
              Salvar revisão
            </Button>
          ) : (
            <Button
              size={btn}
              loading={submit.isPending}
              disabled={busy}
              icon={<Send className="size-5" aria-hidden />}
              onClick={() => submit.mutate()}
            >
              {m.request?.status === 'DEVOLVIDA' ? 'Reenviar ao gestor' : 'Enviar medição'}
            </Button>
          )
        ) : (
          <Button
            size={btn}
            icon={<ChevronRight className="size-5" aria-hidden />}
            onClick={() => setStep(steps[idx + 1]!)}
          >
            Próximo
          </Button>
        )}
      </div>
    </div>
  );
}
