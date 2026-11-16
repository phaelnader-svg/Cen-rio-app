'use client';

import type { PublicationPreviewDto } from '@cenario/shared';
import { Send } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/field';
import { Alert, Spinner } from '@/components/ui/misc';
import { api, newIdempotencyKey } from '@/lib/api';
import { usePublicationPreview } from '@/lib/production';
import { useSend } from './use-send';

const day = (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : '—');

/**
 * Reformulação, Fase 3 — publicação ÚNICA da semana. Antes havia dois diálogos (um em "A
 * planejar", outro no planejamento avançado) publicando o mesmo plano com resumos diferentes.
 * Agora as duas telas usam este: prévia do que vai para os tablets (servidor) e observação
 * opcional para o histórico. Mesma rota e mesma regra de antes (publica as tarefas em rascunho).
 */
export function PublishWeekDialog({ planId, onClose }: { planId: string; onClose: () => void }) {
  const q = usePublicationPreview(planId);
  const [key] = useState(newIdempotencyKey);
  const [notes, setNotes] = useState('');
  const { m, error } = useSend(onClose);
  const p: PublicationPreviewDto | undefined = q.data;
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={p ? `Publicar semana de ${day(p.weekStart)}` : 'Publicar semana'}
      description="Confira o que vai para os tablets. Tarefas com impedimento continuam bloqueadas até a condição ser resolvida."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Voltar
          </Button>
          <Button
            loading={m.isPending}
            disabled={!p?.publishable}
            data-testid="publish-confirm"
            icon={<Send className="size-4" aria-hidden />}
            onClick={() =>
              m.mutate({
                run: () =>
                  api(`/api/v1/production-plans/${planId}/publish`, {
                    method: 'POST',
                    idempotencyKey: key,
                    body: { version: p!.version, ...(notes.trim() ? { notes: notes.trim() } : {}) },
                  }),
                ok: 'Semana publicada: os tablets já receberam as tarefas.',
              })
            }
          >
            Publicar semana
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : (
        p && (
          <div className="space-y-4 text-sm" data-testid="publish-preview">
            <dl className="grid grid-cols-3 gap-3">
              {[
                ['OS', p.serviceOrders],
                ['Peças', p.pieces],
                ['Tarefas', p.tasks],
              ].map(([k, v]) => (
                <div key={k as string} className="rounded-xl bg-subtle p-3 text-center">
                  <dt className="text-ink-muted">{k}</dt>
                  <dd className="text-xl font-semibold tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            <div>
              <p className="font-semibold">Distribuição por profissional</p>
              <ul className="mt-1 space-y-0.5">
                {p.byAssignee.map((b) => (
                  <li key={b.userId ?? '-'}>
                    {b.displayName}: {b.tasks} tarefa(s)
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="font-semibold">Datas de início</p>
              <ul className="mt-1 space-y-0.5">
                {p.startDates.map((s) => (
                  <li key={s.code}>
                    {s.code}: {day(s.startDate)}
                  </li>
                ))}
              </ul>
            </div>
            {p.materialsBlocked.length > 0 && (
              <Alert tone="warn" title="Materiais pendentes (as etapas ficam bloqueadas)">
                {p.materialsBlocked.map((x) => `${x.code}: ${x.label}`).join(' · ')}
              </Alert>
            )}
            {[...p.pendencies, ...p.conflicts].length > 0 && (
              <Alert tone="warn" title="Pendências e conflitos">
                <ul>
                  {[...p.pendencies, ...p.conflicts].map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </Alert>
            )}
            {p.planStatus === 'PUBLICADO' && (
              <p className="text-ink-muted">
                Esta semana já tinha sido publicada: os serviços acima entram como nova revisão; o
                que já estava publicado não muda.
              </p>
            )}
          </div>
        )
      )}
      <label className="mt-4 block text-sm">
        <span className="font-medium">Observações (vão para o histórico)</span>
        <Input
          className="mt-1"
          aria-label="Observações da publicação"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
    </Dialog>
  );
}
