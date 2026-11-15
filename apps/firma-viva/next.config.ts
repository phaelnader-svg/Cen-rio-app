import type { NextConfig } from 'next';

/**
 * Firma Viva (jogo). A API própria fica atrás de /api (mesma origem: cookie httpOnly).
 * FIRMA_API_INTERNAL_URL é gravado no build. NEXT_PUBLIC_CENARIO_WEB_URL aponta para o painel
 * oficial do Cenário Gestão (links "abrir no Cenário").
 */
const apiUrl = (process.env.FIRMA_API_INTERNAL_URL ?? 'http://localhost:4100').replace(/\/$/, '');
const isProd = process.env.NODE_ENV === 'production';

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  // O botão "Conectar Cenário Gestão" navega para a tela oficial do Cenário.
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  poweredByHeader: false,
  transpilePackages: ['@cenario/shared'],
  compress: false,
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiUrl}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
