import { BrandMark } from '@/components/brand';

/**
 * Moldura das telas simples de conta (esqueci a senha, senha nova, confirmar e-mail).
 * Logo, título e texto centralizados, como as telas de erro: simetria com o botão e o link.
 */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <BrandMark className="mx-auto mb-10 w-fit" />
        <h1 className="text-center text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-1 text-center text-[15px] text-ink-muted">{description}</p>
        )}
        {children}
        <p className="mt-8 text-center text-sm text-ink-muted">
          <a
            href="/entrar"
            className="font-medium text-brand-700 underline-offset-4 hover:underline"
          >
            Voltar para entrar
          </a>
        </p>
      </div>
    </main>
  );
}
