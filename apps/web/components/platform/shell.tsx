'use client';

import type { PlatformMeDto } from '@cenario/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Building2,
  HandCoins,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  QrCode,
  Tags,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BrandMark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/misc';
import { ApiError, api } from '@/lib/api';
import { useThemeScope } from '@/lib/theme';

/** As 7 abas do painel da plataforma, aprovadas pelo dono em 25/11/2026. */
export const PLATFORM_NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/plataforma', label: 'Início', icon: LayoutDashboard },
  { href: '/plataforma/empresas', label: 'Empresas', icon: Building2 },
  { href: '/plataforma/cobranca', label: 'Cobrança', icon: HandCoins },
  { href: '/plataforma/planos', label: 'Planos e preços', icon: Tags },
  { href: '/plataforma/recebimento', label: 'Como eu recebo', icon: QrCode },
  { href: '/plataforma/avisos', label: 'Avisos e pedidos', icon: Megaphone },
  { href: '/plataforma/conta', label: 'Minha conta', icon: KeyRound },
];

export function usePlatformMe() {
  return useQuery({
    queryKey: ['platform-me'],
    queryFn: () => api<PlatformMeDto>('/api/plataforma/eu'),
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * Painel da plataforma (/plataforma): o painel do dono do Cenário Gestão como produto. Login e
 * menu próprios, separados do painel das empresas (a Cenário Estofados não vê nada disto).
 */
export function PlatformShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const qc = useQueryClient();
  const pathname = usePathname();
  const me = usePlatformMe();
  const [drawer, setDrawer] = useState(false);
  useThemeScope();
  useEffect(() => setDrawer(false), [pathname]);

  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (unauthenticated) router.replace('/plataforma/entrar');
  }, [unauthenticated, router]);

  if (me.isPending || unauthenticated)
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  if (me.isError)
    return (
      <div className="mx-auto max-w-md p-8">
        <Alert tone="danger" title="Não foi possível abrir o painel">
          {me.error.message}
        </Alert>
        <Button className="mt-4" variant="secondary" onClick={() => void me.refetch()}>
          Tentar novamente
        </Button>
      </div>
    );

  async function logout() {
    try {
      await api('/api/plataforma/sair', { method: 'POST' });
    } finally {
      qc.clear();
      router.replace('/plataforma/entrar?motivo=saiu');
    }
  }

  const active = (href: string) =>
    href === '/plataforma' ? pathname === href : pathname.startsWith(href);

  const sidebar = (
    <nav aria-label="Menu do painel da plataforma" className="flex h-full flex-col">
      <div className="px-5 pt-5 pb-6">
        <BrandMark subtitle="Painel da plataforma" />
      </div>
      <ul className="space-y-0.5 px-3">
        {PLATFORM_NAV.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active(item.href) ? 'page' : undefined}
              className={clsx(
                'flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-medium transition-colors',
                active(item.href)
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-ink-soft hover:bg-subtle hover:text-ink',
              )}
            >
              <item.icon className="size-[18px]" aria-hidden />
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-auto border-t border-line p-4">
        <p className="truncate text-sm font-semibold" data-testid="platform-user">
          {me.data.displayName}
        </p>
        <p className="truncate text-xs text-ink-muted">{me.data.email}</p>
        <Button
          size="sm"
          variant="ghost"
          className="mt-2"
          onClick={() => void logout()}
          icon={<LogOut className="size-3.5" aria-hidden />}
        >
          Sair
        </Button>
      </div>
    </nav>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[256px_1fr]">
      <aside className="sticky top-0 hidden h-dvh overflow-y-auto border-r border-line bg-surface lg:block">
        {sidebar}
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Fechar menu"
            className="absolute inset-0 bg-ink/40"
            onClick={() => setDrawer(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-[86%] max-w-xs overflow-y-auto bg-surface shadow-[var(--shadow-pop)]">
            <button
              type="button"
              onClick={() => setDrawer(false)}
              className="absolute top-4 right-3 rounded-lg p-2 text-ink-muted hover:bg-subtle"
              aria-label="Fechar menu"
            >
              <X className="size-5" aria-hidden />
            </button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-canvas/85 px-4 backdrop-blur lg:hidden">
          <button
            type="button"
            className="-ml-1 rounded-lg p-2 text-ink-soft hover:bg-subtle"
            onClick={() => setDrawer(true)}
            aria-label="Abrir menu"
            aria-expanded={drawer}
          >
            <Menu className="size-5" aria-hidden />
          </button>
          <p className="truncate text-sm font-medium text-ink-muted">
            {PLATFORM_NAV.find((i) => active(i.href))?.label ?? 'Painel da plataforma'}
          </p>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
