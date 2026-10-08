'use client';

import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react';
import { initials } from '@/lib/format';

export function Card({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx('card', className)} {...rest} />;
}

type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger' | 'info' | 'bronze';
const tones: Record<Tone, string> = {
  neutral: 'bg-subtle text-ink-soft ring-line',
  brand: 'bg-brand-50 text-brand-700 ring-brand-100',
  ok: 'bg-ok-50 text-ok-600 ring-ok-600/15',
  warn: 'bg-warn-50 text-warn-600 ring-warn-600/15',
  danger: 'bg-danger-50 text-danger-600 ring-danger-600/15',
  info: 'bg-info-50 text-info-600 ring-info-600/15',
  bronze: 'bg-bronze-100 text-bronze-600 ring-bronze-500/20',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
  dot,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
  dot?: boolean;
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset',
        tones[tone],
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

export function Spinner({
  label = 'Carregando…',
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={clsx('flex items-center gap-2 text-sm text-ink-muted', className)}
    >
      <Loader2 className="size-4 animate-spin" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: 'info' | 'ok' | 'warn' | 'danger';
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const Icon = { info: Info, ok: CheckCircle2, warn: AlertTriangle, danger: XCircle }[tone];
  const style = {
    info: 'bg-info-50 text-info-600 border-info-600/15',
    ok: 'bg-ok-50 text-ok-600 border-ok-600/15',
    warn: 'bg-warn-50 text-warn-600 border-warn-600/20',
    danger: 'bg-danger-50 text-danger-600 border-danger-600/20',
  }[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={clsx('flex gap-3 rounded-xl border px-4 py-3 text-sm', style, className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={clsx(title && 'mt-0.5', 'text-ink-soft')}>{children}</div>}
      </div>
    </div>
  );
}

export function Avatar({
  name,
  color,
  photoUrl,
  size = 40,
  className,
}: {
  name: string;
  color: string;
  photoUrl?: string | null;
  size?: number;
  className?: string;
}) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.38) };
  if (photoUrl) {
    return (
      // Imagem servida pela rota autenticada da API (sem otimização externa).
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photoUrl}
        alt=""
        style={{ ...style, boxShadow: `0 0 0 2px ${color}` }}
        className={clsx('shrink-0 rounded-full object-cover', className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{ ...style, backgroundColor: color }}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white',
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {icon && <div className="mb-3 rounded-2xl bg-subtle p-3 text-ink-muted">{icon}</div>}
      <p className="font-semibold text-ink">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm text-ink-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-[15px] text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
