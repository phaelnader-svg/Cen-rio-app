'use client';

import type { MeasurementDetailDto } from '@cenario/shared';
import { MEASUREMENT_KIND_LABEL } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  CheckCircle2,
  ClipboardCheck,
  Pencil,
  Ruler,
  RotateCcw,
  Undo2,
  UserRoundCog,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { BackLink, Detail, Section } from '@/components/commercial/section';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, Avatar, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { formatDay } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useAssignees, useMeasurement } from '@/lib/measurements';
import { KindBadge, MeasurementStatusBadge, RequestStatusBadge } from './badges';
import { ItemsList, OsTotals } from './items-list';
import { MeasurementEditor } from './measurement-editor';

const REVISION_LABEL: Record<string, string> = {
  ATRIBUIDA: 'Medição atribuída',
  REATRIBUIDA: 'Responsável ou prazo alterado',
  INICIADA: 'Medição iniciada',
  ENVIADA: 'Medição concluída e enviada',
  REENVIADA: 'Corrigida e reenviada',
  EM_REVISAO: 'Revisão iniciada pelo gestor',
  REVISADA: 'Quantidades revisadas pelo gestor',
  APROVADA: 'Aprovada para compra',
  DEVOLVIDA: 'Devolvida para correção',
  REABERTA: 'Aprovação reaberta',
  CANCELADA: 'Medição cancelada',
};

/** Mutação de ação da medição: grava o novo detalhe no cache e mostra o erro. */
function useAction(id: string, success: string, onDone?: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (fn: () => Promise<MeasurementDetailDto>) => fn(),
    onSuccess: (d) => {
      qc.setQueryData(['measurement', id], d);
      void qc.invalidateQueries({ queryKey: ['measurements'] });
      void qc.invalidateQueries({ queryKey: ['planning'] });
      void qc.invalidateQueries({ queryKey: ['consolidated'] });
      setError(null);
      toast('ok', success);
      onDone?.();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT')
        void qc.invalidateQueries({ queryKey: ['measurement', id] });
      setError(errorMessage(e));
    },
  });
  return { m, error };
}

export function MeasurementDetail({ id }: { id: string }) {
  const q = useMeasurement(id);
  const [editor, setEditor] = useState<'execute' | 'review' | null>(null);
  const [dialog, setDialog] = useState<
    'assign' | 'cancel' | 'return' | 'reopen' | 'approve' | null
  >(null);
  const startReview = useAction(id, 'Revisão iniciada.');

  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const m = q.data;
  const rs = m.request?.status;
  const reqVersion = m.request?.version ?? 0;

  const actions = (
    <>
      {m.can.edit && !editor && (
        <Button
          icon={<Ruler className="size-4" aria-hidden />}
          onClick={() => setEditor('execute')}
        >
          {m.status === 'PENDENTE' ? 'Medir agora' : 'Continuar medição'}
        </Button>
      )}
      {m.can.review && rs === 'ENVIADA' && (
        <Button
          icon={<ClipboardCheck className="size-4" aria-hidden />}
          loading={startReview.m.isPending}
          onClick={() =>
            startReview.m.mutate(() =>
              api(`/api/v1/measurements/${id}/request/review`, {
                method: 'POST',
                body: { version: reqVersion },
              }),
            )
          }
        >
          Iniciar revisão
        </Button>
      )}
      {m.can.review && rs === 'EM_REVISAO' && !editor && (
        <>
          <Button
            icon={<CheckCircle2 className="size-4" aria-hidden />}
            onClick={() => setDialog('approve')}
          >
            Aprovar para compra
          </Button>
          <Button
            variant="secondary"
            icon={<Pencil className="size-4" aria-hidden />}
            onClick={() => setEditor('review')}
          >
            Ajustar quantidades
          </Button>
          <Button
            variant="secondary"
            icon={<Undo2 className="size-4" aria-hidden />}
            onClick={() => setDialog('return')}
          >
            Devolver para correção
          </Button>
        </>
      )}
      {m.can.review && rs === 'APROVADA' && (
        <Button
          variant="secondary"
          icon={<RotateCcw className="size-4" aria-hidden />}
          onClick={() => setDialog('reopen')}
        >
          Reabrir aprovação
        </Button>
      )}
      {m.can.reassign && (
        <Button
          variant="secondary"
          icon={<UserRoundCog className="size-4" aria-hidden />}
          onClick={() => setDialog('assign')}
        >
          Reatribuir
        </Button>
      )}
      {m.can.cancel && (
        <Button
          variant="ghost"
          icon={<Ban className="size-4" aria-hidden />}
          onClick={() => setDialog('cancel')}
        >
          Cancelar medição
        </Button>
      )}
    </>
  );

  return (
    <>
      <BackLink href="/painel/medicoes" label="Medições" />
      <PageHeader
        title={`${m.code} · ${m.serviceOrder.code}`}
        description={`${MEASUREMENT_KIND_LABEL[m.kind]} · ${m.customer.name} · ${m.serviceOrderItem ? `${m.serviceOrderItem.code} — ${m.serviceOrderItem.description}` : 'OS inteira'}`}
        actions={actions}
      />
      <div className="mb-6 flex flex-wrap items-center gap-2" data-testid="measurement-badges">
        <KindBadge kind={m.kind} />
        <MeasurementStatusBadge status={m.status} />
        {rs && <RequestStatusBadge status={rs} />}
        {m.overdue && <span className="text-sm font-semibold text-danger-600">Prazo vencido</span>}
      </div>
      {startReview.error && (
        <Alert tone="danger" className="mb-4">
          {startReview.error}
        </Alert>
      )}
      {m.status === 'CANCELADA' && (
        <Alert tone="warn" className="mb-6" title={`Cancelada em ${formatDateTime(m.cancelledAt)}`}>
          {m.cancelReason}
        </Alert>
      )}
      {m.returnReason && (
        <Alert tone="warn" className="mb-6" title="Devolvida para correção">
          {m.returnReason}
        </Alert>
      )}
      {rs === 'APROVADA' && (
        <Alert tone="ok" className="mb-6" title="Quantidades conferidas e aprovadas para compra">
          A aprovação não significa que o material foi comprado ou recebido, e não libera o início
          da produção. Compras e recebimento entram na próxima fase.
        </Alert>
      )}

      {editor && (
        <Section
          title={editor === 'review' ? 'Ajustar quantidades (revisão do gestor)' : 'Medição'}
          className="mb-6"
          actions={
            <Button size="sm" variant="ghost" onClick={() => setEditor(null)}>
              Fechar editor
            </Button>
          }
        >
          <MeasurementEditor key={editor} m={m} mode={editor} onClose={() => setEditor(null)} />
        </Section>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Section title="Materiais solicitados">
            <ItemsList
              rows={m.items.map((i) => ({ ...i, key: i.id }))}
              empty="Nenhum material informado ainda."
            />
            {m.items.length > 0 && (
              <div className="mt-5 border-t border-line pt-4">
                <p className="mb-2 text-sm font-semibold">Total consolidado da OS</p>
                <OsTotals
                  rows={m.items.map((i) => ({ ...i, key: i.id }))}
                  osCode={m.serviceOrder.code}
                />
              </div>
            )}
          </Section>
          <Section title="Medidas por peça">
            {m.pieces.length === 0 ? (
              <p className="text-sm text-ink-muted">Nenhuma medida registrada nesta medição.</p>
            ) : (
              <ul className="space-y-3" data-testid="measured-pieces">
                {m.pieces.map((p) => (
                  <li key={p.serviceOrderItemId}>
                    <p className="text-sm font-medium">{p.itemCode}</p>
                    <ul className="mt-1 flex flex-wrap gap-2">
                      {p.dimensions.map((d, k) => (
                        <li key={k} className="rounded-lg bg-subtle px-2.5 py-1 text-sm">
                          {d.label}: <strong>{String(d.valueCm).replace('.', ',')} cm</strong>
                        </li>
                      ))}
                    </ul>
                    {p.notes && <p className="mt-1 text-xs text-ink-muted">{p.notes}</p>}
                  </li>
                ))}
              </ul>
            )}
            {m.notes && <p className="mt-3 text-sm text-ink-soft">Observações: {m.notes}</p>}
          </Section>
        </div>
        <div className="space-y-6 lg:col-span-2">
          <Section title="Dados da medição">
            <dl className="grid gap-4 sm:grid-cols-2">
              <Detail label="Responsável">
                <span className="inline-flex items-center gap-2">
                  <Avatar
                    name={m.assignee.displayName}
                    color={m.assignee.color ?? '#1d4a45'}
                    size={22}
                  />
                  {m.assignee.displayName}
                </span>
              </Detail>
              <Detail label="Prazo">{formatDay(m.dueDate, true)}</Detail>
              <Detail label="Solicitada por">{m.requestedBy}</Detail>
              <Detail label="Solicitada em">{formatDateTime(m.requestedAt)}</Detail>
              <Detail label="Iniciada em">{m.startedAt ? formatDateTime(m.startedAt) : ''}</Detail>
              <Detail label="Concluída em">
                {m.completedAt ? formatDateTime(m.completedAt) : ''}
              </Detail>
              <div className="sm:col-span-2">
                <Detail label="Motivo">{m.reason}</Detail>
              </div>
              <div className="sm:col-span-2">
                <Detail label="Ordem de serviço">
                  <Link
                    href={`/painel/os/${m.serviceOrder.id}`}
                    className="text-brand-700 hover:underline"
                  >
                    Abrir {m.serviceOrder.code}
                  </Link>
                </Detail>
              </div>
            </dl>
          </Section>
          <Section title="Histórico" bodyClassName="p-0">
            <ol className="divide-y divide-line" data-testid="measurement-history">
              {m.revisions.map((r) => (
                <li key={r.id} className="px-5 py-3">
                  <p className="text-sm font-medium">{REVISION_LABEL[r.kind] ?? r.kind}</p>
                  {r.note && <p className="text-sm text-ink-soft">{r.note}</p>}
                  <p className="text-xs text-ink-muted">
                    {formatDateTime(r.createdAt)} · {r.actor ?? 'Sistema'}
                  </p>
                </li>
              ))}
            </ol>
          </Section>
        </div>
      </div>

      {dialog === 'assign' && <AssignDialog m={m} onClose={() => setDialog(null)} />}
      {dialog === 'approve' && <ApproveDialog m={m} onClose={() => setDialog(null)} />}
      {(dialog === 'cancel' || dialog === 'return' || dialog === 'reopen') && (
        <ReasonDialog m={m} action={dialog} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

function AssignDialog({ m, onClose }: { m: MeasurementDetailDto; onClose: () => void }) {
  const assignees = useAssignees();
  const [assignee, setAssignee] = useState(m.assignee.userId);
  const [dueDate, setDueDate] = useState(m.dueDate);
  const [note, setNote] = useState('');
  const { m: mut, error } = useAction(m.id, 'Medição reatribuída.', onClose);
  const eligible = (assignees.data ?? []).filter((a) => m.kind === 'EXTRAORDINARIA' || a.isManager);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Reatribuir ${m.code}`}
      description="O responsável anterior deixa de ver a tarefa; o novo recebe no tablet."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={mut.isPending}
            onClick={() =>
              mut.mutate(() =>
                api(`/api/v1/measurements/${m.id}/assign`, {
                  method: 'POST',
                  body: {
                    assigneeUserId: assignee,
                    dueDate,
                    note: note || null,
                    version: m.version,
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
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Responsável">
          {(p) => (
            <Select {...p} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              {eligible.map((a) => (
                <option key={a.userId} value={a.userId}>
                  {a.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Prazo">
          {(p) => (
            <Input
              {...p}
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          )}
        </Field>
        <Field label="Observação" className="sm:col-span-2">
          {(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

function ApproveDialog({ m, onClose }: { m: MeasurementDetailDto; onClose: () => void }) {
  const [note, setNote] = useState('');
  const [key] = useState(newIdempotencyKey);
  const { m: mut, error } = useAction(m.id, 'Solicitação aprovada para compra.', onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Aprovar para compra?"
      description="Confirma que as quantidades foram conferidas. Isso não registra compra nem recebimento e não libera a produção."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            loading={mut.isPending}
            onClick={() =>
              mut.mutate(() =>
                api(`/api/v1/measurements/${m.id}/request/approve`, {
                  method: 'POST',
                  idempotencyKey: key,
                  body: { note: note || null, version: m.request!.version },
                }),
              )
            }
          >
            Aprovar
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <p className="mb-3 text-sm text-ink-soft">{m.items.length} material(is) na solicitação.</p>
      <Field label="Observação (opcional)">
        {(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
    </Dialog>
  );
}

const REASON_COPY = {
  cancel: {
    title: 'Cancelar a medição?',
    description: 'A tarefa sai do tablet do responsável. O histórico é preservado.',
    label: 'Motivo do cancelamento',
    button: 'Cancelar medição',
    success: 'Medição cancelada.',
    path: 'cancel',
  },
  return: {
    title: 'Devolver para correção',
    description: 'O responsável vê o motivo no tablet, corrige e reenvia.',
    label: 'O que precisa ser corrigido',
    button: 'Devolver',
    success: 'Solicitação devolvida ao responsável.',
    path: 'request/return',
  },
  reopen: {
    title: 'Reabrir a aprovação?',
    description:
      'A solicitação volta para revisão e os materiais deixam a lista aprovada até nova aprovação.',
    label: 'Motivo da reabertura',
    button: 'Reabrir',
    success: 'Aprovação reaberta.',
    path: 'request/reopen',
  },
} as const;

function ReasonDialog({
  m,
  action,
  onClose,
}: {
  m: MeasurementDetailDto;
  action: keyof typeof REASON_COPY;
  onClose: () => void;
}) {
  const copy = REASON_COPY[action];
  const [reason, setReason] = useState('');
  const { m: mut, error } = useAction(m.id, copy.success, onClose);
  const version = action === 'cancel' ? m.version : m.request!.version;
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={copy.title}
      description={copy.description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            variant={action === 'cancel' ? 'danger' : 'primary'}
            loading={mut.isPending}
            disabled={reason.trim().length < 3}
            onClick={() =>
              mut.mutate(() =>
                api(`/api/v1/measurements/${m.id}/${copy.path}`, {
                  method: 'POST',
                  body: { reason, version },
                }),
              )
            }
          >
            {copy.button}
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <Field label={copy.label}>
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
