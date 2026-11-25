import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    // App instalado (2026-11-25): o app da equipe, no tablet e no celular.
    id: '/tablet',
    name: 'Cenário',
    short_name: 'Cenário',
    description: 'App do Cenário para a equipe: produção no tablet, entregas no celular.',
    start_url: '/tablet',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#f6f5f2',
    theme_color: '#064a4b',
    lang: 'pt-BR',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}
