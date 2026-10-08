'use client';

import type {
  IssueDto,
  IssueImpact,
  IssueKind,
  MaterialUnit,
  ProductionTaskDetailDto,
  ProductionTaskDto,
} from '@cenario/shared';
import {
  ISSUE_IMPACTS,
  ISSUE_IMPACT_LABEL,
  ISSUE_KIND_LABEL,
  ISSUE_OPEN,
  ISSUE_STATUS_LABEL,
  MATERIAL_UNITS,
  MATERIAL_UNIT_LABEL,
} from '@cenario/shared';
import clsx from 'clsx';
import { Camera, PackageX, TriangleAlert, Undo2, Wrench, X } from 'lucide-react';
import { useState } from 'react';
import { useSend } from '@/components/production/use-send';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/misc';
import { api, newIdempotencyKey } from '@/lib/api';
import { useMyIssues } from '@/lib/issues';
import { useOnline } from './tasks';

/**
 * Fase 9 — "Tenho um problema" no tablet: falta de material, problema técnico ou outro
 * impedimento. OS, tarefa, funcionário, dispositivo e horário são registrados pelo servidor.
 * Botões grandes, poucas perguntas, foto opcional. A ajuda de colega continua em "Ajuda".
 */

const KIND_ICON = { MATERIAL: PackageX, TECNICO: Wrench, OUTRO: TriangleAlert } as const;
const isOpen = (i: IssueDto) => (ISSUE_OPEN as readonly string[]).includes(i.status);
const DONE = ['CONCLUIDA', 'CANCELADA', 'RASCUNHO'];

function statusText(i: IssueDto) {
  if (i.status === 'ATRIBUIDA') return `${i.assignee?.displayName} vai resolver`;
  if (i.status === 'EM_RESOLUCAO') return `${i.assignee?.displayName} está resolvendo`;
  if (i.status === 'AGUARDANDO_VERIFICACAO') return 'Solução feita — aguardando o gestor confirmar';
  if (i.status === 'ABERTA') return 'Registrado — o gestor vai decidir a solução';
  return ISSUE_STATUS_LABEL[i.status];
}

export function IssueCard({ i, compact }: { i: IssueDto; compact?: boolean }) {
  const online = useOnline();
  const { m, error } = useSend();
  const [key] = useState(newIdempotencyKey);
  const [confirm, setConfirm] = useState(false);
  return (
    <div
      className={clsx(
        'rounded-2xl border p-4',
        isOpen(i) ? 'border-warn-600/40 bg-warn-50' : 'border-line bg-subtle',
      )}
      data-testid={`issue-${i.code}`}
      data-status={i.status}
    >
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        <span className="font-mono font-semibold text-ink-soft">{i.code}</span>
        <span>· {i.task.code}</span>
        <span>· {ISSUE_IMPACT_LABEL[i.impact]}</span>
      </p>
      <p className={clsx('mt-1 font-semibold', compact ? 'text-lg' : 'text-xl')}>
        {ISSUE_KIND_LABEL[i.kind]}: {i.description}
      </p>
      <p className="mt-1 text-lg" data-testid="issue-status">
        {statusText(i)}
      </p>
      {error && <p className="mt-2 text-sm text-danger-600">{error}</p>}
      {!compact && i.status === 'ABERTA' && (
        <Button
          size="lg"
          variant={confirm ? 'danger' : 'secondary'}
          className="mt-3 w-full"
          disabled={!online}
          loading={m.isPending}
          icon={<X className="size-5" aria-hidden />}
          onClick={() =>
            confirm
              ? m.mutate({
                  run: () =>
                    api(`/api/v1/issues/${i.id}/cancel`, {
                      method: 'POST',
                      body: {
                        note: 'Registrado por engano (cancelado por quem registrou).',
                        version: i.version,
                      },
                      idempotencyKey: key,
                    }),
                  ok: 'Ocorrência cancelada.',
                })
              : setConfirm(true)
          }
        >
          {confirm ? 'Toque de novo para cancelar' : 'Foi engano — cancelar'}
        </Button>
      )}
    </div>
  );
}

/** "Tenho um problema" na tarefa própria (não encerrada). */
export function ProblemPanel({ t }: { t: ProductionTaskDetailDto }) {
  const q = useMyIssues();
  const online = useOnline();
  const [kind, setKind] = useState<IssueKind | null>(null);
  if (DONE.includes(t.status)) return null;
  const mine = (q.data ?? []).filter((i) => i.task.id === t.id);
  return (
    <section className="space-y-3" data-testid="problem-panel">
      <h2 className="text-xl font-semibold">Problema na tarefa</h2>
      {mine.filter(isOpen).map((i) => (
        <IssueCard key={i.id} i={i} />
      ))}
      {kind ? (
        <ProblemForm t={t} kind={kind} onClose={() => setKind(null)} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-3" data-testid="problem-options">
          {(['MATERIAL', 'TECNICO', 'OUTRO'] as const).map((k) => {
            const Icon = KIND_ICON[k];
            return (
              <Button
                key={k}
                size="xl"
                variant="secondary"
                disabled={!online}
                icon={<Icon className="size-6" aria-hidden />}
                onClick={() => setKind(k)}
              >
                {ISSUE_KIND_LABEL[k]}
              </Button>
            );
          })}
        </div>
      )}
      {mine
        .filter((i) => !isOpen(i))
        .slice(0, 2)
        .map((i) => (
          <IssueCard key={i.id} i={i} compact />
        ))}
    </section>
  );
}

function Choice({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        'min-h-14 rounded-xl border px-4 py-3 text-left text-lg font-semibold active:scale-[0.99]',
        active ? 'border-brand-700 bg-brand-50 text-brand-800' : 'border-line bg-surface',
      )}
    >
      {children}
    </button>
  );
}

function ProblemForm({
  t,
  kind,
  onClose,
}: {
  t: ProductionTaskDetailDto;
  kind: IssueKind;
  onClose: () => void;
}) {
  const online = useOnline();
  const { m, error, setError } = useSend(onClose);
  const [key] = useState(newIdempotencyKey);
  const [description, setDescription] = useState('');
  const [impact, setImpact] = useState<IssueImpact | null>(null);
  const [canContinue, setCanContinue] = useState<boolean | null>(null);
  const [requirementId, setRequirementId] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState<MaterialUnit>('METRO');
  const [photo, setPhoto] = useState<File | null>(null);
  const materials = t.materials;

  const send = () => {
    if (kind === 'OUTRO') {
      if (description.trim().length < 3) return setError('Descreva o problema.');
      if (canContinue === null) return setError('Diga se consegue continuar trabalhando.');
    } else if (!impact) return setError('Escolha como o problema afeta o seu trabalho.');
    if (kind === 'TECNICO' && description.trim().length < 3)
      return setError('Descreva o problema.');
    if (kind === 'MATERIAL') {
      if (!requirementId && other.trim().length < 2)
        return setError('Escolha ou descreva o material.');
      if (!(Number(quantity.replace(',', '.')) > 0)) return setError('Informe a quantidade.');
    }
    m.mutate({
      run: async () => {
        const issue = await api<IssueDto>('/api/v1/issues', {
          method: 'POST',
          body: {
            taskId: t.id,
            kind,
            description: description || undefined,
            ...(kind === 'OUTRO' ? { canContinue } : { impact }),
            ...(kind === 'MATERIAL'
              ? {
                  material: {
                    requirementId,
                    description: requirementId ? undefined : other,
                    quantity: Number(quantity.replace(',', '.')),
                    unit,
                  },
                }
              : {}),
          },
          idempotencyKey: key,
        });
        if (photo) {
          const fd = new FormData();
          fd.append('entityType', 'PRODUCTION_ISSUE');
          fd.append('entityId', issue.id);
          fd.append('file', photo);
          await api('/api/v1/attachments', { method: 'POST', body: fd });
        }
        return issue;
      },
      ok: 'Problema registrado. O gestor foi avisado.',
    });
  };

  return (
    <div
      className="space-y-5 rounded-2xl border border-line bg-surface p-5"
      data-testid="problem-form"
    >
      <p className="text-xl font-semibold">{ISSUE_KIND_LABEL[kind]}</p>
      {kind === 'MATERIAL' && (
        <>
          <div>
            <p className="mb-2 text-base font-semibold text-ink-soft">Qual material?</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {materials.map((l) => (
                <Choice
                  key={l.requirementId}
                  active={requirementId === l.requirementId}
                  onClick={() => {
                    setRequirementId(l.requirementId);
                    setUnit(l.unit);
                  }}
                >
                  {l.description}
                </Choice>
              ))}
              <Choice active={requirementId === null} onClick={() => setRequirementId(null)}>
                Outro material
              </Choice>
            </div>
            {requirementId === null && (
              <input
                className="mt-3 h-14 w-full rounded-xl border border-line bg-surface px-4 text-lg"
                placeholder="Qual material está faltando?"
                value={other}
                maxLength={200}
                onChange={(e) => setOther(e.target.value)}
                data-testid="problem-material"
              />
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-base font-semibold text-ink-soft">Quantidade</span>
              <input
                inputMode="decimal"
                className="h-14 w-full rounded-xl border border-line bg-surface px-4 text-lg"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                data-testid="problem-quantity"
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-base font-semibold text-ink-soft">Unidade</span>
              <select
                className="h-14 w-full rounded-xl border border-line bg-surface px-4 text-lg"
                value={unit}
                onChange={(e) => setUnit(e.target.value as MaterialUnit)}
                data-testid="problem-unit"
              >
                {MATERIAL_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {MATERIAL_UNIT_LABEL[u]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </>
      )}
      <label className="block">
        <span className="mb-2 block text-base font-semibold text-ink-soft">
          {kind === 'MATERIAL' ? 'Observação (opcional)' : 'O que está acontecendo?'}
        </span>
        <textarea
          className="min-h-24 w-full rounded-xl border border-line bg-surface px-4 py-3 text-lg"
          value={description}
          maxLength={1000}
          onChange={(e) => setDescription(e.target.value)}
          data-testid="problem-description"
        />
      </label>
      {kind === 'OUTRO' ? (
        <div>
          <p className="mb-2 text-base font-semibold text-ink-soft">
            Consegue continuar trabalhando nesta tarefa?
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Choice active={canContinue === true} onClick={() => setCanContinue(true)}>
              Sim, consigo continuar
            </Choice>
            <Choice active={canContinue === false} onClick={() => setCanContinue(false)}>
              Não, estou impedido
            </Choice>
          </div>
        </div>
      ) : (
        <div>
          <p className="mb-2 text-base font-semibold text-ink-soft">Como afeta o seu trabalho?</p>
          <div className="grid gap-3">
            {ISSUE_IMPACTS.map((i) => (
              <Choice key={i} active={impact === i} onClick={() => setImpact(i)}>
                {ISSUE_IMPACT_LABEL[i]}
              </Choice>
            ))}
          </div>
        </div>
      )}
      <label className="flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border border-dashed border-line-strong px-4 text-lg">
        <Camera className="size-6" aria-hidden />
        {photo ? `Foto: ${photo.name}` : 'Adicionar foto (opcional)'}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
          data-testid="problem-photo"
        />
      </label>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Button size="xl" disabled={!online} loading={m.isPending} onClick={send}>
          Registrar problema
        </Button>
        <Button size="xl" variant="secondary" onClick={onClose} icon={<Undo2 className="size-6" />}>
          Voltar
        </Button>
      </div>
    </div>
  );
}

/** Tarefa de resolução: qual ocorrência e o problema (no cartão e no detalhe). */
export function IssueInfo({ t, large }: { t: ProductionTaskDto; large?: boolean }) {
  if (!t.issueFor) return null;
  return (
    <span
      className={clsx(
        'mt-2 block rounded-xl bg-warn-50 px-3 py-2 text-warn-600',
        large ? 'text-lg' : 'text-sm',
      )}
      data-testid="issue-info"
    >
      <Wrench className="mr-1 inline size-4" aria-hidden />
      Resolver {t.issueFor.code} ({t.issueFor.reporter}): {t.issueFor.description}
    </span>
  );
}

/** Meus problemas ainda abertos (no Meu dia). */
export function MyOpenIssues({ userId }: { userId: string }) {
  const q = useMyIssues();
  const open = (q.data ?? []).filter((i) => isOpen(i) && i.reporter.userId === userId);
  if (!open.length) return null;
  return (
    <section data-testid="my-issues">
      <h2 className="mb-3 text-xl font-semibold">Problemas registrados</h2>
      <ul className="grid gap-3 lg:grid-cols-2">
        {open.map((i) => (
          <li key={i.id}>
            <IssueCard i={i} compact />
          </li>
        ))}
      </ul>
    </section>
  );
}
