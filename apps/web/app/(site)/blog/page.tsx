import { legalMode } from '@/components/site/legal/legal';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { artigosPublicados } from '@/components/site/blog/artigos';
import { BlogList } from '@/components/site/blog/blog';
import { SITE_URL, siteMode } from '@/components/site/config';

/** Lista do blog. Sem nenhum artigo publicado, o endereço não existe (nada de blog vazio). */
export const dynamic = 'force-dynamic';

const TITLE = 'Blog do Cenário Gestão · Gestão de tapeçaria na prática';
const DESCRIPTION =
  'Artigos sobre o dia a dia e a gestão de uma tapeçaria, escritos por quem vive a oficina.';

export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(SITE_URL),
    title: { absolute: TITLE },
    description: DESCRIPTION,
    alternates: { canonical: '/blog' },
    openGraph: {
      type: 'website',
      locale: 'pt_BR',
      url: '/blog',
      siteName: 'Cenário Gestão',
      title: TITLE,
      description: DESCRIPTION,
      images: [{ url: '/site/og.png', width: 1200, height: 630 }],
    },
    robots: siteMode() === 'live' ? { index: true, follow: true } : { index: false, follow: false },
  };
}

export default async function BlogPage() {
  const artigos = artigosPublicados();
  if (artigos.length === 0) notFound();
  return (
    <BlogList artigos={artigos} preview={siteMode() === 'preview'} legal={await legalMode()} />
  );
}
