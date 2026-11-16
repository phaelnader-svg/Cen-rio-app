/**
 * Classes do botão, sem 'use client': o componente Button (interativo) e os links com cara de
 * botão renderizados no servidor (ex.: a landing em /conheca) usam exatamente o mesmo visual.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline-danger';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

export const BUTTON_BASE =
  'inline-flex shrink-0 items-center justify-center font-semibold whitespace-nowrap transition-colors disabled:cursor-not-allowed';

export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-700 text-white shadow-sm hover:bg-brand-800 active:bg-brand-800 disabled:bg-brand-200',
  secondary:
    'border border-line-strong bg-surface text-ink hover:bg-subtle active:bg-line disabled:text-ink-muted',
  ghost: 'text-ink-soft hover:bg-subtle hover:text-ink disabled:text-ink-muted',
  danger: 'bg-danger-600 text-white shadow-sm hover:bg-danger-700 disabled:opacity-50',
  'outline-danger':
    'border border-danger-600/40 bg-surface text-danger-600 hover:bg-danger-50 disabled:opacity-50',
};

export const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-9 gap-1.5 rounded-lg px-3 text-sm',
  md: 'h-11 gap-2 rounded-xl px-4 text-[15px]',
  lg: 'h-12 gap-2 rounded-xl px-5 text-base',
  xl: 'h-16 gap-3 rounded-2xl px-7 text-lg',
};
