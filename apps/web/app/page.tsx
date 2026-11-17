import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Landing } from '@/components/site/landing';
import { siteMetadata, siteMode } from '@/components/site/config';

/**
 * Raiz do domínio. Com a landing publicada (SITE_COMERCIAL=1 e sem pendências), quem chega por
 * cenariogestao.com.br vê a página comercial; o painel fica em /entrar e /painel. Sem a landing
 * (desenvolvimento, homologação ou SITE_COMERCIAL desligado), continua indo direto ao painel.
 */
export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  if (siteMode() !== 'live') return {};
  return siteMetadata(true);
}

export default function Home() {
  if (siteMode() !== 'live') redirect('/painel');
  return <Landing preview={false} />;
}
