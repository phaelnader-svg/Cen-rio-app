import clsx from 'clsx';

/** Marca do sistema (monograma + nome). */
export function BrandMark({ className, inverted }: { className?: string; inverted?: boolean }) {
  return (
    <div className={clsx('flex items-center gap-2.5', className)}>
      <svg viewBox="0 0 40 40" className="size-9 shrink-0" aria-hidden>
        <rect width="40" height="40" rx="11" fill={inverted ? '#ffffff' : '#1d4a45'} />
        <path
          d="M26.5 14.2a8 8 0 1 0 0 11.6"
          fill="none"
          stroke={inverted ? '#1d4a45' : '#ffffff'}
          strokeWidth="3.2"
          strokeLinecap="round"
        />
        <circle cx="27" cy="20" r="2.4" fill="#a8743f" />
      </svg>
      <div className="leading-tight">
        <p
          className={clsx(
            'text-[15px] font-semibold tracking-tight',
            inverted ? 'text-white' : 'text-ink',
          )}
        >
          Cenário Gestão
        </p>
        <p className={clsx('text-xs', inverted ? 'text-white/70' : 'text-ink-muted')}>
          Cenário Estofados
        </p>
      </div>
    </div>
  );
}
