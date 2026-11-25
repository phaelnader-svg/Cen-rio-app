import { SITE_URL } from '@/components/site/config';

/**
 * robots.txt (RFC 9309) escrito à mão, porque o gerador do Next.js não aceita a linha
 * Content-Signal (https://contentsignals.org/).
 *
 * Buscadores e assistentes de IA podem ler só a landing e os arquivos públicos para agentes;
 * painel, tablet, API e os links dos clientes (proposta, álbum, retirada) ficam fora.
 */

/**
 * Preferências de uso por IA (pedido do dono em 25/11/2026): aparecer em buscas, ser usado nas
 * respostas das IAs e, por sugestão aceita, liberar o uso para treino (mais visibilidade).
 */
export const CONTENT_SIGNAL = { search: 'yes', 'ai-input': 'yes', 'ai-train': 'yes' } as const;

export const ROBOTS_ALLOW = [
  '/$',
  '/conheca',
  '/site/',
  '/blog',
  // O que os assistentes de IA leem: llms.txt, /.well-known (cartões do MCP, do A2A,
  // habilidades e catálogo de APIs), a ficha pública do produto e a descrição OpenAPI.
  '/llms.txt',
  '/.well-known/',
  '/info/',
  '/openapi.json',
];

export const ROBOTS_DISALLOW = [
  '/painel',
  '/tablet',
  '/dono',
  '/entrar',
  '/api/',
  '/autorizar',
  '/ambiente-interativo',
  '/proposta/',
  '/album/',
  '/agendar/',
];

export function robotsTxt(): string {
  const signal = Object.entries(CONTENT_SIGNAL)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return [
    'User-Agent: *',
    `Content-Signal: ${signal}`,
    ...ROBOTS_ALLOW.map((p) => `Allow: ${p}`),
    ...ROBOTS_DISALLOW.map((p) => `Disallow: ${p}`),
    '',
    `Sitemap: ${SITE_URL}/sitemap.xml`,
    '',
  ].join('\n');
}
