import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/components/site/config';

/** O Google pode ler só a landing; painel, tablet e API ficam fora. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/$', '/conheca', '/site/'],
        // Links dos clientes (proposta, álbum, retirada) também ficam fora.
        disallow: [
          '/painel',
          '/tablet',
          '/entrar',
          '/api/',
          '/autorizar',
          '/ambiente-interativo',
          '/proposta/',
          '/album/',
          '/agendar/',
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
