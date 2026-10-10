'use client';

import clsx from 'clsx';
import { Loader2 } from 'lucide-react';
import { forwardRef } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline-danger';
type Size = 'sm' | 'md' | 'lg' | 'xl';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
}

const variants: Record<Variant, string> = {
  primary:
    'bg-brand-700 text-white shadow-sm hover:bg-brand-800 active:bg-brand-800 disabled:bg-brand-200',
  secondary:
    'border border-line-strong bg-surface text-ink hover:bg-subtle active:bg-line disabled:text-ink-muted',
  ghost: 'text-ink-soft hover:bg-subtle hover:text-ink disabled:text-ink-muted',
  danger: 'bg-danger-600 text-white shadow-sm hover:bg-danger-700 disabled:opacity-50',
  'outline-danger':
    'border border-danger-600/40 bg-surface text-danger-600 hover:bg-danger-50 disabled:opacity-50',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 gap-1.5 rounded-lg px-3 text-sm',
  md: 'h-11 gap-2 rounded-xl px-4 text-[15px]',
  lg: 'h-12 gap-2 rounded-xl px-5 text-base',
  xl: 'h-16 gap-3 rounded-2xl px-7 text-lg',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center font-semibold whitespace-nowrap transition-colors disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});
