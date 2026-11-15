'use client';
import clsx from 'clsx';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

/** Painel flutuante sobre o mapa (cartão "de madeira" com borda bronze). */
export function Panel({
  title,
  subtitle,
  icon,
  onClose,
  children,
  className,
  actions,
  testId,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      className={clsx(
        'pointer-events-auto flex max-h-full flex-col overflow-hidden rounded-2xl border-2 border-bronze-500/60 bg-[#fffaf2]/97 shadow-pop backdrop-blur',
        className,
      )}
    >
      <header className="flex items-start gap-3 border-b border-bronze-500/25 bg-gradient-to-r from-[#f5ebdf] to-[#fffaf2] px-4 py-3">
        {icon ? <div className="mt-0.5 text-xl">{icon}</div> : null}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-bold text-ink">{title}</h2>
          {subtitle ? <div className="text-xs text-ink-soft">{subtitle}</div> : null}
        </div>
        {actions}
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-ink-muted hover:bg-bronze-100 hover:text-ink"
            aria-label="Fechar painel"
          >
            <X className="size-5" />
          </button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm">{children}</div>
    </section>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[11px] font-bold tracking-wider text-bronze-600 uppercase">{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

export function GBtn({
  children,
  onClick,
  tone = 'default',
  disabled,
  title,
  className,
  type = 'button',
  testId,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: 'default' | 'primary' | 'danger' | 'ghost' | 'bronze';
  disabled?: boolean;
  title?: string;
  className?: string;
  type?: 'button' | 'submit';
  testId?: string;
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-45',
        tone === 'primary' && 'bg-brand-600 text-white shadow-sm hover:bg-brand-700',
        tone === 'bronze' && 'bg-bronze-500 text-white shadow-sm hover:bg-bronze-600',
        tone === 'danger' && 'bg-danger-600 text-white hover:bg-danger-700',
        tone === 'default' && 'border border-line-strong bg-white text-ink hover:bg-subtle',
        tone === 'ghost' && 'text-ink-soft hover:bg-bronze-100',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Tone({ tone, children }: { tone: 'FALTA' | 'DISPONIVEL' | 'A_CONFERIR' | 'risco' | 'atencao' | 'ok' | 'info'; children: ReactNode }) {
  const map = {
    FALTA: 'bg-danger-50 text-danger-700 border-danger-600/30',
    risco: 'bg-danger-50 text-danger-700 border-danger-600/30',
    DISPONIVEL: 'bg-ok-50 text-ok-600 border-ok-600/30',
    ok: 'bg-ok-50 text-ok-600 border-ok-600/30',
    A_CONFERIR: 'bg-warn-50 text-warn-600 border-warn-600/30',
    atencao: 'bg-warn-50 text-warn-600 border-warn-600/30',
    info: 'bg-info-50 text-info-600 border-info-600/30',
  } as const;
  return <span className={clsx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold', map[tone])}>{children}</span>;
}

export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-dashed border-line py-1 last:border-0">
      <span className="text-ink-muted">{k}</span>
      <span className="text-right font-medium text-ink">{v ?? '—'}</span>
    </div>
  );
}

export const fmtDate = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');
export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
export const fmtQty = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
export const UNIT_LABEL: Record<string, string> = {
  METRO: 'm',
  METRO_QUADRADO: 'm²',
  PLACA: 'placa',
  PECA: 'peça',
  UNIDADE: 'un.',
  EMBALAGEM: 'emb.',
};
export const TASK_STATUS_LABEL: Record<string, string> = {
  RASCUNHO: 'Planejada (rascunho)',
  BLOQUEADA: 'Bloqueada',
  PROGRAMADA: 'Programada',
  LIBERADA: 'Liberada (na fila)',
  EM_EXECUCAO: 'Em execução',
  PAUSADA: 'Pausada',
  CONCLUIDA: 'Concluída',
  CANCELADA: 'Cancelada',
};
