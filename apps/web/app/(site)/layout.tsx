import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { siteMetadata, siteMode } from '@/components/site/config';

/**
 * Área pública comercial. Fica fora do painel e do tablet (sem AdminShell, sem sessão, sem API).
 * Lida a cada requisição: a variável SITE_COMERCIAL vale em tempo de execução, não de build.
 */
export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return siteMetadata(siteMode() === 'live');
}

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  if (siteMode() === 'off') notFound();
  return children;
}
