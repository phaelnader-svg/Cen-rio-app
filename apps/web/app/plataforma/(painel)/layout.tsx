import { PlatformShell } from '@/components/platform/shell';

/** Painel da plataforma: login e menu próprios, separados do painel das empresas. */
export default function PlataformaLayout({ children }: { children: React.ReactNode }) {
  return <PlatformShell>{children}</PlatformShell>;
}
