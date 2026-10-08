import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: { default: 'Cenário Gestão', template: '%s · Cenário Gestão' },
  description: 'Gestão de produção da Cenário Estofados',
  applicationName: 'Cenário Gestão',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg', apple: '/icon-192.png' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#1d4a45',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
