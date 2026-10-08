import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Cenário Gestão — Produção',
    short_name: 'Cenário',
    description: 'Interface de produção da Cenário Estofados',
    start_url: '/tablet',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#f6f5f2',
    theme_color: '#1d4a45',
    lang: 'pt-BR',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}
