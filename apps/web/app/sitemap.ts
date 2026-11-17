import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/components/site/config';

/** Mapa do site para o Google: só a página principal (a /conheca aponta para ela). */
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${SITE_URL}/`, changeFrequency: 'monthly', priority: 1 }];
}
