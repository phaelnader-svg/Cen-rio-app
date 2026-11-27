import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';
import { THEME_PREPAINT } from '@/lib/theme-prepaint';

export const metadata: Metadata = {
  title: { default: 'Cenário Gestão', template: '%s · Cenário Gestão' },
  description: 'Gestão de produção para tapeçarias',
  applicationName: 'Cenário Gestão',
  // Instalar a partir do site ou do painel instala o app do DONO (/dono). O app da equipe se
  // instala pela tela /tablet (e pelo código QR de Dispositivos), que tem o próprio manifesto.
  manifest: '/dono/manifest',
  // Ícone da aba: o sofá da Cenário Gestão. `?v=2` força os navegadores a trocar o "C" antigo em cache.
  icons: {
    icon: [
      { url: '/favicon.ico?v=2', sizes: '48x48' },
      { url: '/icon-32.png?v=2', sizes: '32x32', type: 'image/png' },
      { url: '/icon.svg?v=2', type: 'image/svg+xml' },
    ],
    shortcut: '/favicon.ico?v=2',
    apple: { url: '/apple-touch-icon.png?v=2', sizes: '180x180' },
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#064a4b',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_PREPAINT }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
