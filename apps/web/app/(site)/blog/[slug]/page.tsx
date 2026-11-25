import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { artigoPorSlug } from '@/components/site/blog/artigos';
import { BlogArticle } from '@/components/site/blog/blog';
import { SITE_URL, siteMode } from '@/components/site/config';

/** Página de um artigo do blog. */
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const a = artigoPorSlug((await params).slug);
  if (!a) return {};
  const url = `/blog/${a.slug}`;
  return {
    metadataBase: new URL(SITE_URL),
    title: { absolute: `${a.titulo} · Blog do Cenário Gestão` },
    description: a.resumo,
    authors: [{ name: a.autor }],
    alternates: { canonical: url },
    openGraph: {
      type: 'article',
      locale: 'pt_BR',
      url,
      siteName: 'Cenário Gestão',
      title: a.titulo,
      description: a.resumo,
      publishedTime: a.publicadoEm,
      modifiedTime: a.atualizadoEm ?? a.publicadoEm,
      authors: [a.autor],
      images: [
        a.capa
          ? { url: a.capa.src, width: a.capa.width, height: a.capa.height, alt: a.capa.alt }
          : { url: '/site/og.png', width: 1200, height: 630 },
      ],
    },
    robots:
      siteMode() === 'live' && !a.rascunho
        ? { index: true, follow: true }
        : { index: false, follow: false },
  };
}

export default async function ArtigoPage({ params }: Props) {
  const a = artigoPorSlug((await params).slug);
  if (!a) notFound();
  return <BlogArticle a={a} preview={siteMode() === 'preview'} />;
}
