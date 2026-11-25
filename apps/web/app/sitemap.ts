import type { MetadataRoute } from 'next';
import { artigosPublicados } from '@/components/site/blog/artigos';
import { SITE_URL } from '@/components/site/config';

/**
 * Mapa do site para buscadores: só páginas públicas (a raiz e o blog com cada artigo publicado).
 * A /conheca aponta para a raiz (canônica); painel, tablet e links de clientes nunca entram.
 */
const PUBLISHED = new Date(); // gerado no build: data da versão publicada

export default function sitemap(): MetadataRoute.Sitemap {
  const artigos = artigosPublicados();
  const home = {
    url: `${SITE_URL}/`,
    lastModified: PUBLISHED,
    changeFrequency: 'monthly',
    priority: 1,
  } as const;
  if (artigos.length === 0) return [home];
  return [
    home,
    { url: `${SITE_URL}/blog`, lastModified: PUBLISHED, changeFrequency: 'weekly', priority: 0.8 },
    ...artigos.map((a) => ({
      url: `${SITE_URL}/blog/${a.slug}`,
      lastModified: new Date(`${a.atualizadoEm ?? a.publicadoEm}T12:00:00-03:00`),
      changeFrequency: 'monthly' as const,
      priority: 0.7,
    })),
  ];
}
