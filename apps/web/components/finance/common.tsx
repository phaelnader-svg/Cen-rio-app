'use client';

import clsx from 'clsx';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, Card } from '@/components/ui/misc';
import { newIdempotencyKey } from '@/lib/api';
import { localToday, monthStart, parseMoney, useFinSend, type Period } from '@/lib/finance';

/** Filtro de período (padrão: mês corrente). */
export function PeriodPicker({
  value,
  onChange,
}: {
  value: Period;
  onChange: (p: Period) => void;
}) {
  const today = localToday();
  const presets: { label: string; p: Period }[] = [
    { label: 'Este mês', p: { from: monthStart(today), to: today } },
    {
      label: 'Mês passado',
      p: (() => {
        const d = new Date(`${monthStart(today)}T12:00:00Z`);
        d.setUTCDate(0);
        const end = d.toISOString().slice(0, 10);
        return { from: monthStart(end), to: end };
      })(),
    },
    { label: 'Este ano', p: { from: `${today.slice(0, 4)}-01-01`, to: today } },
  ];
  return (
    <div className="mb-5 flex flex-wrap items-end gap-3" data-testid="period-picker">
      <Field label="De" className="w-40">
        {(f) => (
          <Input
            {...f}
            type="date"
            value={value.from}
            onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })}
          />
        )}
      </Field>
      <Field label="Até" className="w-40">
        {(f) => (
          <Input
            {...f}
            type="date"
            value={value.to}
            onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })}
          />
        )}
      </Field>
      {presets.map((x) => (
        <Button key={x.label} size="sm" variant="secondary" onClick={() => onChange(x.p)}>
          {x.label}
        </Button>
      ))}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'ok' | 'danger' | 'warn';
  testId?: string;
}) {
  return (
    <Card className="p-4">
      <p className="text-xs font-semibold tracking-wide text-ink-muted uppercase">{label}</p>
      <p
        data-testid={testId}
        className={clsx(
          'mt-1 text-xl font-semibold tabular-nums',
          tone === 'ok' && 'text-ok-600',
          tone === 'danger' && 'text-danger-600',
          tone === 'warn' && 'text-warn-600',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>}
    </Card>
  );
}

export type FormField = {
  name: string;
  label: string;
  type?: 'text' | 'money' | 'date' | 'month' | 'number' | 'select' | 'textarea';
  options?: { value: string; label: string }[];
  required?: boolean;
  hint?: string;
  initial?: string;
};

/**
 * Formulário genérico do financeiro: os valores em dinheiro são digitados em reais
 * ("1.234,56") e enviados em centavos. Cada abertura usa uma chave de idempotência.
 */
export function FormDialog({
  title,
  description,
  fields,
  submitLabel = 'Salvar',
  onClose,
  onSubmit,
  okMessage = 'Registrado.',
  children,
}: {
  title: string;
  description?: string;
  fields: FormField[];
  submitLabel?: string;
  onClose: () => void;
  onSubmit: (
    values: Record<string, string>,
    money: (name: string) => number,
    key: string,
  ) => Promise<unknown>;
  okMessage?: string;
  children?: React.ReactNode;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((f) => [
        f.name,
        f.initial ?? (f.type === 'select' ? (f.options?.[0]?.value ?? '') : ''),
      ]),
    ),
  );
  const [key] = useState(newIdempotencyKey);
  const { m, error, setError } = useFinSend(onClose);
  const missing = fields.some((f) => f.required && !values[f.name]?.trim());
  const submit = () => {
    try {
      const money = (name: string) => {
        const c = parseMoney(values[name] ?? '');
        if (c === null)
          throw new Error(`Valor inválido em "${fields.find((f) => f.name === name)?.label}".`);
        return c;
      };
      // Valida os valores antes de enviar.
      for (const f of fields)
        if (f.type === 'money' && (f.required || values[f.name])) money(f.name);
      m.mutate({ run: () => onSubmit(values, money, key), ok: okMessage });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <Button disabled={missing} loading={m.isPending} onClick={submit}>
          {submitLabel}
        </Button>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      {children}
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <Field
            key={f.name}
            label={f.label}
            required={f.required}
            hint={f.hint}
            className={f.type === 'textarea' ? 'sm:col-span-2' : undefined}
          >
            {(p) =>
              f.type === 'select' ? (
                <Select
                  {...p}
                  value={values[f.name]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                >
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              ) : f.type === 'textarea' ? (
                <Textarea
                  {...p}
                  value={values[f.name]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                />
              ) : (
                <Input
                  {...p}
                  type={f.type === 'money' || !f.type ? 'text' : f.type}
                  inputMode={f.type === 'money' ? 'decimal' : undefined}
                  placeholder={f.type === 'money' ? '0,00' : undefined}
                  value={values[f.name]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                />
              )
            }
          </Field>
        ))}
      </div>
    </Dialog>
  );
}

export const PAYMENT_OPTIONS = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));

export function Table({
  head,
  children,
  testId,
}: {
  head: string[];
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Card className="overflow-x-auto">
      <table className="data-table min-w-[640px]" data-testid={testId}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} className="px-4 py-2.5">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </Card>
  );
}
