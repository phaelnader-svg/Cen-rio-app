import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SITE_META, siteMode } from '@/components/site/config';

/**
 * Área pública comercial. Fica fora do painel e do tablet (sem AdminShell, sem sessão, sem API).
 * Lida a cada requisição: a variável SITE_COMERCIAL vale em tempo de execução, não de build.
 */
export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return {
    title: { absolute: SITE_META.title },
    description: SITE_META.description,
    // Só a landing publicada é indexável; o resto do sistema segue com noindex (layout raiz).
    robots: siteMode() === 'live' ? { index: true, follow: true } : { index: false, follow: false },
  };
}

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  if (siteMode() === 'off') notFound();
  return children;
}
