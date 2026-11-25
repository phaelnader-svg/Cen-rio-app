import type { NextConfig } from 'next';
import { HOME_LINK_HEADER } from './components/site/agentes';
import { SITE } from './components/site/config';

/**
 * Endereço interno da API. ATENÇÃO: os rewrites são gravados no build, então
 * API_INTERNAL_URL precisa estar definido no momento do `next build`.
 */
const apiUrl = (process.env.API_INTERNAL_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const isProd = process.env.NODE_ENV === 'production';

/**
 * Política de segurança de conteúdo. 'unsafe-inline' em scripts é exigido pelo
 * runtime do Next.js sem nonce. A única origem externa é o anti-robô do Criar conta
 * (Cloudflare Turnstile: script e quadro de challenges.cloudflare.com).
 */
const TURNSTILE = 'https://challenges.cloudflare.com';
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"} ${TURNSTILE}`,
  `frame-src ${TURNSTILE}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  `connect-src 'self' ws: wss: ${TURNSTILE}`,
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/**
 * Landing com Google Analytics (SITE.analyticsId preenchido): só /, /conheca e o blog liberam os
 * endereços do Google; painel, tablet e o resto do sistema continuam sem nenhuma origem externa.
 */
const GA =
  'https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com';
const siteCsp = csp
  .replace("script-src 'self' 'unsafe-inline'", `script-src 'self' 'unsafe-inline' ${GA}`)
  .replace("img-src 'self' data: blob:", `img-src 'self' data: blob: ${GA}`)
  .replace("connect-src 'self' ws: wss:", `connect-src 'self' ws: wss: ${GA}`);
const siteHeaders = SITE.analyticsId
  ? ['/', '/conheca', '/blog', '/blog/:slug'].map((source) => ({
      source,
      headers: [{ key: 'Content-Security-Policy', value: siteCsp }],
    }))
  : [];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Permite builds isolados (ex.: testes E2E) sem sobrescrever o build principal.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  poweredByHeader: false,
  transpilePackages: ['@cenario/shared'],
  // O proxy reverso de produção comprime; aqui evitamos bufferizar respostas da API.
  compress: false,
  typedRoutes: false,
  // O lint roda na raiz do monorepo (pnpm lint), com a configuração compartilhada.
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    // Mesma origem para navegador: /api/* (incluindo o WebSocket) é encaminhado à API.
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' },
        ],
      },
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      // Depois da regra geral: a CSP da landing substitui a padrão nessas duas rotas.
      ...siteHeaders,
      // Descoberta por agentes de IA (RFC 8288/9727): a página inicial aponta para o catálogo de
      // APIs, os cartões do MCP e do A2A e o llms.txt. Só endereços públicos do produto.
      ...['/', '/conheca'].map((source) => ({
        source,
        headers: [{ key: 'Link', value: HOME_LINK_HEADER }],
      })),
    ];
  },
};

export default nextConfig;
