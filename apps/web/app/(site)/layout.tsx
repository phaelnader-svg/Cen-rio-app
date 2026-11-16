import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { siteMode } from '@/components/site/config';

/**
 * Área pública comercial. Fica fora do painel e do tablet (sem AdminShell, sem sessão, sem API).
 * Lida a cada requisição: a variável SITE_COMERCIAL vale em tempo de execução, não de build.
 */
export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return {
    title: { absolute: 'Cenário Gestão · Sistema de gestão para tapeçarias' },
    description:
      'O Cenário Gestão nasceu dentro da Cenário Estofados para organizar a nossa própria operação. Do pedido à entrega, no escritório e no tablet da oficina.',
    // Só a landing publicada é indexável; o resto do sistema segue com noindex (layout raiz).
    robots: siteMode() === 'live' ? { index: true, follow: true } : { index: false, follow: false },
  };
}

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  if (siteMode() === 'off') notFound();
  return children;
}
