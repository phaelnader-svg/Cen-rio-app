import { legalMode } from '@/components/site/legal/legal';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Landing } from '@/components/site/landing';
import { blogOrigemDe } from '@/components/site/blog/artigos';
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

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function Home({ searchParams }: Props) {
  if (siteMode() !== 'live') redirect('/painel');
  return (
    <Landing
      preview={false}
      blogOrigem={blogOrigemDe(await searchParams)}
      legal={await legalMode()}
    />
  );
}
