'use client';

import clsx from 'clsx';
import { forwardRef, useId } from 'react';

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
  children: (props: {
    id: string;
    'aria-invalid'?: boolean;
    'aria-describedby'?: string;
  }) => React.ReactNode;
  className?: string;
  required?: boolean;
}

/**
 * Campo acessível: rótulo associado, mensagem de erro e dica ligadas por aria-describedby.
 * Sempre três filhos (rótulo · controle · mensagem): num grid, campos vizinhos compartilham as
 * mesmas trilhas (ver `.field` em globals.css) e ficam alinhados mesmo com dica, erro ou rótulo
 * longo.
 */
export function Field({ label, error, hint, children, className, required }: FieldProps) {
  const id = useId();
  const describedBy = [error ? `${id}-err` : null, hint ? `${id}-hint` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={clsx('field', className)}>
      <label htmlFor={id} className="label">
        {label}
        {required && (
          <span className="text-danger-600" aria-hidden>
            {' '}
            *
          </span>
        )}
      </label>
      <div className="min-w-0">
        {children({
          id,
          'aria-invalid': error ? true : undefined,
          'aria-describedby': describedBy || undefined,
        })}
      </div>
      <div className="field-msg">
        {hint && !error && (
          <p id={`${id}-hint`} className="mt-1.5 text-xs leading-4 text-ink-muted">
            {hint}
          </p>
        )}
        {error && (
          <p id={`${id}-err`} role="alert" className="mt-1.5 text-sm leading-5 text-danger-600">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={clsx('input', className)} {...rest} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={clsx('input', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...rest }, ref) {
    return <select ref={ref} className={clsx('input', className)} {...rest} />;
  },
);

export function Checkbox({
  label,
  description,
  className,
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label: React.ReactNode; description?: string }) {
  const id = useId();
  return (
    <div className={clsx('flex items-start gap-3', className)}>
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-5 shrink-0 cursor-pointer rounded border-line-strong accent-brand-700 disabled:cursor-not-allowed"
        {...rest}
      />
      <label htmlFor={id} className="cursor-pointer text-sm">
        <span className="font-medium text-ink">{label}</span>
        {description && <span className="mt-0.5 block text-ink-muted">{description}</span>}
      </label>
    </div>
  );
}
