import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/components/site/config';

/**
 * Mapa do site para buscadores: só páginas públicas. A /conheca aponta para a raiz (canônica), e
 * painel, tablet e links de clientes nunca entram. A data acompanha a versão publicada.
 */
const PUBLISHED = new Date(); // gerado no build: data da versão publicada

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${SITE_URL}/`, lastModified: PUBLISHED, changeFrequency: 'monthly', priority: 1 },
  ];
}
