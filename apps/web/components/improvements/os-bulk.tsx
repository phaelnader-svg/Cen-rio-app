'use client';

import { plural } from '@cenario/shared';
import {
  NEXT_STEP_LABEL,
  PRIORITIES,
  PRIORITY_LABEL,
  type NextStep,
  type Priority,
  type ServiceOrderDto,
} from '@cenario/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { DateField, FormGrid, SelectField, TextField } from '@/components/ui/form';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/hooks';
import { useEmployees } from '@/lib/queries';
import { advanceOs, useCanStep, useInvalidateOs } from '@/components/production/next-step';

type Action = 'PRAZO' | 'PRIORIDADE' | 'RESPONSAVEL';
const TITLE: Record<Action, string> = {
  PRAZO: 'Mudar o prazo',
  PRIORIDADE: 'Mudar a prioridade',
  RESPONSAVEL: 'Mudar o responsável técnico',
};

/**
 * Melhoria 85: ações em lote nas OS selecionadas. Cada OS é alterada com a mesma regra da tela
 * dela (versão conferida, motivo no histórico); uma que falhar não trava as outras.
 */
export function OsBulkBar({
  ids,
  rows = [],
  onDone,
}: {
  ids: string[];
  /** Oficina sem tablet: as OS selecionadas com a próxima etapa (para marcar todas de uma vez). */
  rows?: { id: string; code: string; nextStep?: NextStep | null; customer: { name: string } }[];
  onDone: () => void;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const [steps, setSteps] = useState(false);
  const canStep = useCanStep();
  const movable = rows.filter((r) => r.nextStep && canStep(r.nextStep));
  if (!ids.length) return null;
  return (
    <div className="sticky top-16 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-brand-200 bg-brand-50 px-4 py-2.5 text-sm">
      <span className="flex-1 font-medium text-brand-700">
        {plural(ids.length, 'OS selecionada', 'OS selecionadas')}
      </span>
      {movable.length > 0 && (
        <Button size="sm" onClick={() => setSteps(true)} data-testid="bulk-next-step">
          Marcar a próxima etapa
        </Button>
      )}
      {(Object.keys(TITLE) as Action[]).map((a) => (
        <Button key={a} size="sm" variant="secondary" onClick={() => setAction(a)}>
          {TITLE[a]}
        </Button>
      ))}
      <Button size="sm" variant="ghost" onClick={onDone}>
        Limpar seleção
      </Button>
      {steps && (
        <BulkStepDialog
          rows={movable}
          onClose={() => setSteps(false)}
          onDone={() => {
            setSteps(false);
            onDone();
          }}
        />
      )}
      {action && (
        <BulkDialog
          action={action}
          ids={ids}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null);
            onDone();
          }}
        />
      )}
    </div>
  );
}

function BulkDialog({
  action,
  ids,
  onClose,
  onDone,
}: {
  action: Action;
  ids: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const employees = useEmployees(action === 'RESPONSAVEL' && can('funcionarios.ver'));
  const [date, setDate] = useState('');
  const [priority, setPriority] = useState<Priority>('NORMAL');
  const [lead, setLead] = useState('');
  const [reason, setReason] = useState('');
  const [running, setRunning] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);

  async function run() {
    setRunning(true);
    setFailures([]);
    const failed: string[] = [];
    let ok = 0;
    for (const id of ids) {
      try {
        const so = await api<ServiceOrderDto>(`/api/v1/service-orders/${id}`);
        await api(`/api/v1/service-orders/${id}`, {
          method: 'PUT',
          body: {
            technicalInstructions: so.technicalInstructions,
            notes: so.notes,
            promisedDate: action === 'PRAZO' ? date : so.promisedDate,
            priority: action === 'PRIORIDADE' ? priority : so.priority,
            technicalLeadId:
              action === 'RESPONSAVEL' ? lead || null : (so.technicalLead?.id ?? null),
            reason: reason.trim() || 'Alteração em lote',
            version: so.version,
          },
        });
        ok++;
      } catch (e) {
        failed.push(`${id.slice(0, 8)}: ${errorMessage(e)}`);
      }
    }
    setRunning(false);
    await qc.invalidateQueries({ queryKey: ['service-orders'] });
    await qc.invalidateQueries({ queryKey: ['service-order'] });
    if (failed.length) setFailures(failed);
    else {
      toast('ok', `${plural(ok, 'OS alterada', 'OS alteradas')}.`);
      onDone();
    }
  }

  const ready =
    action === 'PRAZO' ? Boolean(date && reason.trim()) : action === 'RESPONSAVEL' ? true : true;
  return (
    <Dialog
      open
      onClose={onClose}
      title={TITLE[action]}
      description={`Vale para as ${ids.length} OS selecionadas.`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={running} disabled={!ready} onClick={() => void run()}>
            Aplicar
          </Button>
        </>
      }
    >
      <FormGrid>
        {action === 'PRAZO' && (
          <DateField
            label="Novo prazo prometido"
            cols={12}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        )}
        {action === 'PRIORIDADE' && (
          <SelectField
            label="Prioridade"
            cols={12}
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </SelectField>
        )}
        {action === 'RESPONSAVEL' && (
          <SelectField
            label="Responsável técnico"
            cols={12}
            value={lead}
            onChange={(e) => setLead(e.target.value)}
          >
            <option value="">A definir</option>
            {employees.data
              ?.filter((e) => e.active)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.displayName} — {e.jobTitle}
                </option>
              ))}
          </SelectField>
        )}
        <TextField
          label={action === 'PRAZO' ? 'Motivo (obrigatório)' : 'Motivo (opcional)'}
          cols={12}
          maxLength={300}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </FormGrid>
      {failures.length > 0 && (
        <Alert tone="warn" className="mt-3" title="Algumas OS não foram alteradas">
          <ul className="list-disc pl-4">
            {failures.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </Alert>
      )}
    </Dialog>
  );
}

/**
 * Oficina sem tablet (2026-11-24): no fim do dia, marca a próxima etapa de várias OS de uma vez.
 * Cada OS anda só uma etapa (a que aparece no botão dela); uma que falhar não trava as outras.
 */
function BulkStepDialog({
  rows,
  onClose,
  onDone,
}: {
  rows: { id: string; code: string; nextStep?: NextStep | null; customer: { name: string } }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const invalidate = useInvalidateOs();
  const [running, setRunning] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  async function run() {
    setRunning(true);
    const failed: string[] = [];
    let ok = 0;
    for (const r of rows) {
      try {
        await advanceOs(r.id, r.nextStep!);
        ok++;
      } catch (e) {
        failed.push(`${r.code}: ${errorMessage(e)}`);
      }
    }
    setRunning(false);
    invalidate();
    if (failed.length) setFailures(failed);
    else {
      toast('ok', `${plural(ok, 'OS andou', 'OS andaram')} uma etapa.`);
      onDone();
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title="Marcar a próxima etapa"
      description="Cada OS anda uma etapa, no nome do tapeceiro dela."
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={running} onClick={() => void run()} data-testid="bulk-next-step-run">
            Marcar {plural(rows.length, 'OS', 'OS')}
          </Button>
        </>
      }
    >
      <ul className="divide-y divide-line rounded-lg border border-line text-sm">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-3 px-3 py-2.5">
            <span className="font-mono font-semibold">{r.code}</span>
            <span className="min-w-0 flex-1 truncate text-ink-muted">{r.customer.name}</span>
            <span className="font-medium text-brand-700">{NEXT_STEP_LABEL[r.nextStep!]}</span>
          </li>
        ))}
      </ul>
      {failures.length > 0 && (
        <Alert tone="warn" className="mt-3" title="Algumas OS não andaram">
          <ul className="list-disc pl-4">
            {failures.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </Alert>
      )}
    </Dialog>
  );
}
