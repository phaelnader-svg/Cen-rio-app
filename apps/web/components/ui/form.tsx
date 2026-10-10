'use client';

import clsx from 'clsx';
import { forwardRef } from 'react';
import { MoneyInput } from '@/components/commercial/money-input';
import { Field, Input, Select, Textarea } from './field';

/**
 * Design system de formulários (correção global de interface). Todos os campos usam o mesmo
 * `Field` (rótulo · controle · mensagem) e a mesma altura de controle (44 px; compacto 36 px).
 * A LARGURA é proporcional à informação — o grid de 12 colunas recebe `span` por campo
 * (quantidade estreita, descrição larga) — mas o alinhamento e a altura são sempre os mesmos.
 */

type Span = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12;
const SPAN: Record<Span, string> = {
  2: 'sm:col-span-2',
  3: 'sm:col-span-3',
  4: 'sm:col-span-4',
  5: 'sm:col-span-5',
  6: 'sm:col-span-6',
  7: 'sm:col-span-7',
  8: 'sm:col-span-8',
  9: 'sm:col-span-9',
  12: 'sm:col-span-12',
};
/** No tablet (≥ 640 px) o grid tem 12 colunas; no celular, um campo por linha. */
export const span = (n: Span) => SPAN[n];

/** Grid de formulário: 12 colunas a partir de 640 px; espaçamento padrão entre campos. */
export function FormGrid({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx('grid gap-x-4 gap-y-4 sm:grid-cols-12', className)} {...rest}>
      {children}
    </div>
  );
}

/** Seção de formulário (cartão com título, descrição opcional e ações à direita). */
export function FormSection({
  title,
  description,
  actions,
  children,
  className,
  step,
  ...rest
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Número da etapa (ex.: 1 de 6), exibido antes do título. */
  step?: number;
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <section
      className={clsx('card p-5 sm:p-6', className)}
      aria-labelledby={rest.id ? `${rest.id}-titulo` : undefined}
      {...rest}
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id={rest.id ? `${rest.id}-titulo` : undefined}
            className="flex items-center gap-2 font-semibold"
          >
            {step !== undefined && (
              <span
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-bold text-brand-700"
                aria-hidden
              >
                {step}
              </span>
            )}
            {title}
          </h2>
          {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Barra de ações do formulário: alinhada à direita; no celular, botões em largura total. */
export function FormActions({
  children,
  className,
  sticky,
}: {
  children: React.ReactNode;
  className?: string;
  /** Fixa a barra no rodapé da tela em formulários longos. */
  sticky?: boolean;
}) {
  return (
    <div
      className={clsx(
        'flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end [&>*]:w-full sm:[&>*]:w-auto',
        sticky &&
          'sticky bottom-0 z-10 -mx-4 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-2xl sm:border',
        className,
      )}
    >
      {children}
    </div>
  );
}

type Common = {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  /** Largura no grid de 12 colunas (ver `span`). */
  cols?: Span;
  className?: string;
};

export const TextField = forwardRef<
  HTMLInputElement,
  Common & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className'>
>(function TextField({ label, error, hint, required, cols, className, ...rest }, ref) {
  return (
    <Field
      label={label}
      error={error}
      hint={hint}
      required={required}
      className={clsx(cols && span(cols), className)}
    >
      {(p) => <Input ref={ref} {...p} {...rest} required={required} />}
    </Field>
  );
});

export const NumberField = forwardRef<
  HTMLInputElement,
  Common & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'>
>(function NumberField(props, ref) {
  return <TextField ref={ref} {...props} type="number" inputMode="numeric" />;
});

export const DateField = forwardRef<
  HTMLInputElement,
  Common & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'>
>(function DateField(props, ref) {
  return <TextField ref={ref} {...props} type="date" />;
});

export const TimeField = forwardRef<
  HTMLInputElement,
  Common & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className' | 'type'>
>(function TimeField(props, ref) {
  return <TextField ref={ref} {...props} type="time" />;
});

export const SelectField = forwardRef<
  HTMLSelectElement,
  Common & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'className'>
>(function SelectField({ label, error, hint, required, cols, className, children, ...rest }, ref) {
  return (
    <Field
      label={label}
      error={error}
      hint={hint}
      required={required}
      className={clsx(cols && span(cols), className)}
    >
      {(p) => (
        <Select ref={ref} {...p} {...rest} required={required}>
          {children}
        </Select>
      )}
    </Field>
  );
});

export const TextAreaField = forwardRef<
  HTMLTextAreaElement,
  Common & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>
>(function TextAreaField({ label, error, hint, required, cols, className, ...rest }, ref) {
  return (
    <Field
      label={label}
      error={error}
      hint={hint}
      required={required}
      className={clsx(cols && span(cols), className)}
    >
      {(p) => <Textarea ref={ref} {...p} {...rest} required={required} />}
    </Field>
  );
});

/** Valor em reais (texto "1.234,56"; devolve centavos ou null e se o texto é válido). */
export function MoneyField({
  label,
  error,
  hint,
  required,
  cols,
  className,
  cents,
  onCents,
  ...rest
}: Common & {
  cents: number | null;
  onCents: (v: number | null, valid: boolean) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className' | 'value' | 'onChange'>) {
  return (
    <Field
      label={label}
      error={error}
      hint={hint}
      required={required}
      className={clsx(cols && span(cols), className)}
    >
      {(p) => <MoneyInput {...p} {...rest} cents={cents} onCents={onCents} />}
    </Field>
  );
}

/** Célula de ação dentro de um FormGrid: o botão fica na linha dos controles. */
export function FieldAction({
  children,
  cols,
  className,
}: {
  children: React.ReactNode;
  cols?: Span;
  className?: string;
}) {
  return <div className={clsx('field-action', cols && span(cols), className)}>{children}</div>;
}

/** Linha de resumo (rótulo à esquerda, valor monetário à direita, algarismos tabulares). */
export function SummaryRow({
  label,
  value,
  strong,
  hint,
  testId,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  strong?: boolean;
  hint?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      className={clsx('flex items-baseline justify-between gap-4 py-2', strong && 'font-semibold')}
    >
      <dt className="min-w-0 text-sm text-ink-soft">
        {label}
        {hint && <span className="block text-xs font-normal text-ink-muted">{hint}</span>}
      </dt>
      <dd className="money text-right text-[15px]" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

export { Dialog as ModalLayout } from './dialog';
