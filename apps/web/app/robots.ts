import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/components/site/config';

/** O Google pode ler só a landing; painel, tablet e API ficam fora. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        // Inclui o que os assistentes de IA leem: llms.txt, /.well-known (cartões do MCP, do A2A,
        // habilidades e catálogo de APIs), a ficha pública do produto e a descrição OpenAPI.
        allow: [
          '/$',
          '/conheca',
          '/site/',
          '/llms.txt',
          '/.well-known/',
          '/info/',
          '/openapi.json',
        ],
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
