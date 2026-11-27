import Link from 'next/link';
import { LogoMark } from '@/components/brand';
import { buttonClass } from '@/components/ui/button-styles';

export const metadata = { title: 'Página não encontrada' };

/** Melhoria 137: endereço errado mostra uma tela em português, com a logo e um caminho de volta. */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-6 text-center">
      <LogoMark className="size-14" />
      <h1 className="mt-6 text-2xl font-semibold tracking-tight text-ink">
        Essa página não existe
      </h1>
      <p className="mt-2 max-w-sm text-ink-soft">
        O endereço pode ter sido digitado errado ou a página mudou de lugar.
      </p>
      <Link href="/" className={`mt-8 ${buttonClass('primary', 'md')}`}>
        Voltar para o início
      </Link>
    </main>
  );
}
