'use client';

import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { KeyRound, Lock, LogOut, Menu, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BrandMark } from '@/components/brand';
import { ConnectionIndicator } from '@/components/connection-indicator';
import { Button } from '@/components/ui/button';
import { Alert, Avatar, Spinner } from '@/components/ui/misc';
import { ApiError, api } from '@/lib/api';
import { useMe } from '@/lib/hooks';
import { RealtimeProvider } from '@/lib/realtime';
import { NAV, UPCOMING } from './nav';

export function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);

  useEffect(() => setDrawer(false), [pathname]);

  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (unauthenticated) router.replace('/entrar');
  }, [unauthenticated, router]);

  if (me.isPending || unauthenticated) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="mx-auto max-w-md p-8">
        <Alert tone="danger" title="Não foi possível carregar o painel">
          {me.error.message}
        </Alert>
        <Button className="mt-4" variant="secondary" onClick={() => void me.refetch()}>
          Tentar novamente
        </Button>
      </div>
    );
  }

  const data = me.data;
  const perms = new Set(data.permissions);
  if (data.session.kind !== 'WEB' || !perms.has('painel.acessar')) {
    return (
      <div className="mx-auto max-w-md p-8">
        <Alert tone="warn" title="Acesso ao painel indisponível">
          Esta sessão não tem acesso ao painel administrativo.
        </Alert>
        <Button className="mt-4" variant="secondary" onClick={() => router.replace('/tablet')}>
          Ir para a interface de produção
        </Button>
      </div>
    );
  }

  const items = NAV.filter((i) => !i.anyOf || i.anyOf.some((p) => perms.has(p)));

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      qc.clear();
      router.replace('/entrar?motivo=saiu');
    }
  }

  const sidebar = (
    <nav aria-label="Navegação principal" className="flex h-full flex-col">
      <div className="px-5 pt-5 pb-6">
        <BrandMark />
      </div>
      <ul className="space-y-0.5 px-3">
        {items.map((item) => {
          // Item ativo: o de prefixo mais longo (ex.: /painel/producao/planejamento).
          const matches = (href: string) =>
            href === '/painel' ? pathname === '/painel' : pathname.startsWith(href);
          const active =
            matches(item.href) &&
            !items.some((o) => o.href.length > item.href.length && matches(o.href));
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] font-medium transition-colors',
                  active
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-ink-soft hover:bg-subtle hover:text-ink',
                )}
              >
                <item.icon className="size-[18px]" aria-hidden />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-6 px-6">
        <p className="text-[11px] font-semibold tracking-[0.12em] text-ink-muted uppercase">
          Próximas fases
        </p>
      </div>
      <ul className="mt-2 space-y-0.5 px-3" aria-label="Módulos ainda não disponíveis">
        {UPCOMING.map((m) => (
          <li
            key={m.label}
            aria-disabled="true"
            className="flex cursor-not-allowed items-center gap-3 rounded-xl px-3 py-2 text-sm text-ink-muted/80"
            title="Disponível em fase futura"
          >
            <m.icon className="size-[17px] opacity-60" aria-hidden />
            <span className="flex-1">{m.label}</span>
            <Lock className="size-3.5 opacity-60" aria-hidden />
          </li>
        ))}
      </ul>
      <div className="mt-auto border-t border-line p-4">
        <div className="flex items-center gap-3">
          <Avatar
            name={data.user.displayName}
            color={data.employee?.color ?? '#1d4a45'}
            photoUrl={data.employee?.photoUrl}
            size={36}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold" data-testid="current-user">
              {data.user.displayName}
            </p>
            <p className="truncate text-xs text-ink-muted">{data.user.email}</p>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          <Link
            href="/painel/conta"
            className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-line-strong text-sm font-medium text-ink-soft hover:bg-subtle"
          >
            <KeyRound className="size-3.5" aria-hidden /> Minha conta
          </Link>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void logout()}
            icon={<LogOut className="size-3.5" aria-hidden />}
          >
            Sair
          </Button>
        </div>
      </div>
    </nav>
  );

  return (
    <RealtimeProvider onSessionEnded={() => router.replace('/entrar?motivo=sessao-encerrada')}>
      <div className="min-h-dvh lg:grid lg:grid-cols-[272px_1fr]">
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
          <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-canvas/85 px-4 backdrop-blur sm:px-6 lg:px-10">
            <button
              type="button"
              className="-ml-1 rounded-lg p-2 text-ink-soft hover:bg-subtle lg:hidden"
              onClick={() => setDrawer(true)}
              aria-label="Abrir menu"
              aria-expanded={drawer}
            >
              <Menu className="size-5" aria-hidden />
            </button>
            <p className="truncate text-sm font-medium text-ink-muted">{data.company.tradeName}</p>
            <div className="ml-auto">
              <ConnectionIndicator compact />
            </div>
          </header>
          <main id="conteudo" className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-10">
            {children}
          </main>
        </div>
      </div>
    </RealtimeProvider>
  );
}
