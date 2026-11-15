import clsx from 'clsx';

/** Marca do Firma Viva. */
export function FirmaMark({ className, inverted }: { className?: string; inverted?: boolean }) {
  return (
    <div className={clsx('flex items-center gap-2.5', className)}>
      <span
        className={clsx(
          'grid size-9 place-items-center rounded-xl text-base font-black',
          inverted ? 'bg-[#f5ebdf] text-brand-800' : 'bg-brand-700 text-[#f5ebdf]',
        )}
        aria-hidden
      >
        F
      </span>
      <span
        className={clsx(
          'text-lg font-black tracking-tight',
          inverted ? 'text-white' : 'text-brand-800',
        )}
      >
        Firma Viva
      </span>
    </div>
  );
}

/** Moldura das telas de acesso (entrar, convite, senha). */
export function AuthFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden overflow-hidden bg-brand-800 p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <FirmaMark inverted />
        <div className="max-w-md">
          <p className="text-sm font-semibold tracking-[0.18em] text-bronze-100/80 uppercase">
            Sua empresa, viva no mapa
          </p>
          <h2 className="mt-3 text-4xl leading-tight font-semibold tracking-tight">
            Monte a oficina e o escritório, acompanhe cada peça e cada meta.
          </h2>
          <p className="mt-4 text-white/70">
            Conecte o Cenário Gestão para operar a empresa real: OS, equipe, materiais e caixa.
          </p>
        </div>
        <p className="text-xs text-white/50">Acesso por convite.</p>
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -bottom-24 size-96 rounded-full border-[48px] border-white/5"
        />
      </section>
      <section className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm">
          <FirmaMark className="mb-10 lg:hidden" />
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle ? <p className="mt-1 text-[15px] text-ink-muted">{subtitle}</p> : null}
          <div className="mt-6">{children}</div>
        </div>
      </section>
    </main>
  );
}
