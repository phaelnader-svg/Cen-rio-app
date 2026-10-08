import type { NextConfig } from 'next';

/**
 * Endereço interno da API. ATENÇÃO: os rewrites são gravados no build, então
 * API_INTERNAL_URL precisa estar definido no momento do `next build`.
 */
const apiUrl = (process.env.API_INTERNAL_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const isProd = process.env.NODE_ENV === 'production';

/**
 * Política de segurança de conteúdo. 'unsafe-inline' em scripts é exigido pelo
 * runtime do Next.js sem nonce; nenhuma origem externa é permitida.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

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
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default nextConfig;
