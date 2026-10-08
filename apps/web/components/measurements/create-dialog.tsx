'use client';

import type { MeasurementDetailDto, MeasurementKind } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, fieldErrors, newIdempotencyKey } from '@/lib/api';
import { formatDay } from '@/lib/commercial';
import { useAssignees, usePlanning } from '@/lib/measurements';

export interface MeasurementTarget {
  serviceOrder: { id: string; code: string };
  items: { id: string; code: string; description: string }[];
  /** Peça pré-selecionada (null = OS inteira). */
  itemId?: string | null;
}

/**
 * Atribui uma medição. Rotina: o gestor mede no dia configurado (sexta).
 * Extraordinária: delegável a tapeceiro autorizado, com motivo e prazo.
 */
export function CreateMeasurementDialog({
  target,
  onClose,
}: {
  target: MeasurementTarget;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter();
  const assignees = useAssignees();
  const planning = usePlanning();
  const measurementDay = planning.data?.period.measurementDay ?? '';
  const [kind, setKind] = useState<MeasurementKind>('ROTINA');
  const [itemId, setItemId] = useState(target.itemId ?? '');
  const [assignee, setAssignee] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [reason, setReason] = useState('');
  const [key] = useState(newIdempotencyKey);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const eligible = (assignees.data ?? []).filter((a) => kind === 'EXTRAORDINARIA' || a.isManager);
  const effectiveAssignee = assignee || (eligible.length === 1 ? eligible[0]!.userId : '');
  const effectiveDue = dueDate || (kind === 'ROTINA' ? measurementDay : '');

  const create = useMutation({
    mutationFn: () =>
      api<MeasurementDetailDto>('/api/v1/measurements', {
        method: 'POST',
        idempotencyKey: key,
        body: {
          serviceOrderId: target.serviceOrder.id,
          serviceOrderItemId: itemId || null,
          kind,
          assigneeUserId: effectiveAssignee,
          dueDate: effectiveDue,
          reason: reason.trim() || null,
        },
      }),
    onSuccess: (d) => {
      qc.setQueryData(['measurement', d.id], d);
      void qc.invalidateQueries({ queryKey: ['measurements'] });
      void qc.invalidateQueries({ queryKey: ['measurements-awaiting'] });
      toast('ok', `Medição ${d.code} atribuída a ${d.assignee.displayName}.`);
      onClose();
      router.push(`/painel/medicoes/${d.id}`);
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      setError(errorMessage(e));
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Solicitar medição · ${target.serviceOrder.code}`}
      description="O responsável recebe a tarefa no tablet imediatamente."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={create.isPending}
            disabled={!effectiveAssignee || !effectiveDue}
            onClick={() => create.mutate()}
          >
            Atribuir medição
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <fieldset className="mb-4">
        <legend className="label">Tipo</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ['ROTINA', 'Rotina de sexta', 'Feita pelo gestor no dia de medição.'],
              ['EXTRAORDINARIA', 'Extraordinária', 'Fora da rotina; pode ser delegada.'],
            ] as const
          ).map(([k, title, text]) => (
            <label
              key={k}
              className="flex cursor-pointer gap-3 rounded-xl border border-line p-3 has-[:checked]:border-brand-700 has-[:checked]:bg-brand-50/50"
            >
              <input
                type="radio"
                name="kind"
                value={k}
                checked={kind === k}
                onChange={() => {
                  setKind(k);
                  setAssignee('');
                }}
                className="mt-1 accent-brand-700"
              />
              <span>
                <span className="block font-medium">{title}</span>
                <span className="block text-sm text-ink-muted">{text}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Peça" className="sm:col-span-2" error={errors.serviceOrderItemId}>
          {(p) => (
            <Select {...p} value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">Toda a OS ({target.items.length} peça(s))</option>
              {target.items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.code} — {i.description}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Responsável"
          error={errors.assigneeUserId}
          hint={
            kind === 'ROTINA'
              ? 'A rotina de sexta é do gestor.'
              : 'Somente pessoas autorizadas a executar medições.'
          }
        >
          {(p) => (
            <Select {...p} value={effectiveAssignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Selecione…</option>
              {eligible.map((a) => (
                <option key={a.userId} value={a.userId}>
                  {a.displayName}
                  {a.jobTitle ? ` — ${a.jobTitle}` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Prazo"
          error={errors.dueDate}
          hint={
            kind === 'ROTINA' && measurementDay
              ? `Dia de medição: ${formatDay(measurementDay)}`
              : undefined
          }
        >
          {(p) => (
            <Input
              {...p}
              type="date"
              value={effectiveDue}
              onChange={(e) => setDueDate(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Motivo"
          className="sm:col-span-2"
          required={kind === 'EXTRAORDINARIA'}
          error={errors.reason}
        >
          {(p) => (
            <Textarea
              {...p}
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                kind === 'EXTRAORDINARIA' ? 'Ex.: cliente com urgência, peça chegou na terça' : ''
              }
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
