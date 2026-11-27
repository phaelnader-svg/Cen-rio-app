'use client';

import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Gamepad2, KeyRound, LifeBuoy, Lock, LogOut, Menu, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { screenKeyFor } from '@cenario/shared';
import { useEffect, useRef, useState } from 'react';
import { BrandMark } from '@/components/brand';
import { ConnectionIndicator } from '@/components/connection-indicator';
import { PanelNotifications } from './panel-notifications';
import {
  ClientErrorReporter,
  CommandPalette,
  FeedbackButton,
  MaintenanceBanner,
  ThemeToggle,
  WhatsNew,
} from '@/components/improvements/panel-tools';
import { SetupRedirect } from '@/components/onboarding/getting-started';
import { WelcomeDialog } from './welcome-dialog';
import { useThemeScope } from '@/lib/theme';
import { Button } from '@/components/ui/button';
import { Alert, Avatar, Spinner } from '@/components/ui/misc';
import { ApiError, api } from '@/lib/api';
import { AMBIENTE_INTERATIVO_PATH } from '@/lib/ambiente-interativo';
import { useMe, useModules } from '@/lib/hooks';
import { RealtimeProvider } from '@/lib/realtime';
import { UPCOMING, currentPage, familyTabs, visibleNav, visiblePages } from './nav';
import { supportUrl } from '@/components/site/config';
import {
  BillingLocked,
  BillingNotices,
  SUBSCRIPTION_PATH,
} from '@/components/billing/billing-notice';

export function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const locked = me.data?.company.subscription?.locked ?? false;
  // Assinatura vencida: as rotas respondem 402; nada além do que a tela de assinatura precisa.
  const modules = useModules(me.isSuccess && !locked);
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  const saindo = useRef(false);
  useThemeScope();

  useEffect(() => setDrawer(false), [pathname]);
  // Item 49 (2026-11-27): conta a tela aberta (só o nome da tela, por dia) para o dono da
  // plataforma saber o que ninguém usa. Falha não atrapalha nada.
  const signedIn = me.isSuccess;
  useEffect(() => {
    if (!signedIn) return;
    const screen = screenKeyFor(pathname);
    if (screen)
      void api('/api/v1/usage/screen', { method: 'POST', body: { screen } }).catch(() => undefined);
  }, [pathname, signedIn]);

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

  // Cobrança desligada: o item Assinatura não aparece.
  const billingOn = data.company.subscription.billingEnabled;
  const items = visibleNav(perms, modules, data.company.platformOwner, billingOn);
  // Revisão geral (item 3): todas as telas que o perfil abre (menu + abas), para a busca e as abas.
  const pages = visiblePages(perms, modules, data.company.platformOwner, billingOn);
  const tabs = familyTabs(pathname, pages);
  const currentHref = currentPage(pathname, pages)?.href;
  // Suporte do Cenário para as empresas clientes (a Cenário Estofados é a própria dona).
  const help = data.company.platformOwner ? null : supportUrl(data.company.tradeName);

  async function logout() {
    // B4: a saída encerra a sessão, e o tempo real avisa "sessão encerrada" — que aqui é esperado.
    saindo.current = true;
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
        <BrandMark subtitle={data.company.tradeName} />
      </div>
      <ul className="space-y-0.5 px-3">
        {items.map((item, idx) => {
          // Item ativo: a família da tela de prefixo mais longo (ex.: Quadro de produção marca
          // "Semana da oficina").
          const active = !!currentHref && item.also.includes(currentHref);
          const header = idx === 0 || items[idx - 1]!.group !== item.group;
          return (
            <li key={item.href}>
              {header && item.group !== 'Início' && (
                <p className="px-3 pt-4 pb-1 text-xs font-semibold tracking-wide text-ink-muted uppercase">
                  {item.group}
                </p>
              )}
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
      {UPCOMING.length > 0 && (
        <>
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
        </>
      )}
      <div className="mt-auto border-t border-line p-4">
        <div className="mb-1 flex items-center gap-1 sm:hidden">
          <WhatsNew />
          <ThemeToggle />
        </div>
        {!data.user.supportAgent && <FeedbackButton className="mb-1" />}
        <Link
          href="/painel/lixeira"
          className="mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-ink-soft hover:bg-subtle"
        >
          <Trash2 className="size-4" aria-hidden /> Lixeira
        </Link>
        {help && (
          <a
            href={help}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="ajuda-suporte"
            className="mb-3 flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-ink-soft hover:bg-subtle"
          >
            <LifeBuoy className="size-4" aria-hidden /> Ajuda e suporte (WhatsApp)
          </a>
        )}
        <div className="flex items-center gap-3">
          <Avatar
            name={data.user.displayName}
            color={data.employee?.color ?? '#064a4b'}
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
    <RealtimeProvider
      onSessionEnded={() => {
        if (!saindo.current) router.replace('/entrar?motivo=sessao-encerrada');
      }}
    >
      <ClientErrorReporter />
      <MaintenanceBanner />
      {data.user.supportAgent && (
        <div className="bg-info-50 px-4 py-2 text-center text-sm font-medium text-info-600">
          Você está no acesso de suporte autorizado por {data.company.tradeName}. Tudo o que for
          feito aqui fica registrado na Auditoria da empresa.
        </div>
      )}
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
            <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
              {!locked && (
                <CommandPalette
                  nav={[
                    ...pages.map((i) => ({ href: i.href, label: i.label, group: i.group })),
                    { href: '/painel/resumo', label: 'Resumo da semana', group: 'Início' },
                    { href: '/painel/lixeira', label: 'Lixeira', group: 'Administração' },
                    { href: '/painel/conta', label: 'Minha conta', group: 'Administração' },
                  ]}
                  canNewService={perms.has('orcamentos.gerenciar')}
                />
              )}
              {/* Complemento "Ambiente interativo" (só o dono, quem configura a empresa): Firma Viva em outra guia. */}
              {modules.ambiente_interativo && perms.has('empresa.configurar') && (
                <a
                  href={AMBIENTE_INTERATIVO_PATH}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="ambiente-interativo"
                  aria-label="Abrir o Firma Viva (abre em nova guia)"
                  // Melhoria 159: nome do produto e o verde da marca; curto para caber no celular.
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-brand-700 px-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-800 focus-visible:ring-4 focus-visible:ring-brand-100"
                >
                  <Gamepad2 className="size-4" aria-hidden />
                  <span className="hidden sm:inline">Firma Viva</span>
                </a>
              )}
              {/* No celular, Novidades e Tema ficam no menu lateral (o topo não cabe em 390 px). */}
              <div className="hidden items-center gap-2 sm:flex">
                <WhatsNew />
                <ThemeToggle />
              </div>
              {!locked && <PanelNotifications />}
              {!locked && <ConnectionIndicator compact />}
            </div>
          </header>
          <main id="conteudo" className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-10">
            <BillingNotices me={data} canManage={perms.has('empresa.configurar')} />
            {locked && !pathname.startsWith(SUBSCRIPTION_PATH) ? (
              <BillingLocked canManage={perms.has('empresa.ver')} />
            ) : (
              <>
                {tabs && (
                  <nav
                    aria-label="Telas desta área"
                    className="-mx-1 mb-6 flex gap-1 overflow-x-auto border-b border-line px-1"
                    data-testid="family-tabs"
                  >
                    {tabs.tabs.map((t) => (
                      <Link
                        key={t.href}
                        href={t.href}
                        aria-current={t.href === tabs.active ? 'page' : undefined}
                        className={clsx(
                          '-mb-px shrink-0 border-b-2 px-3 py-2.5 text-[15px] font-medium whitespace-nowrap',
                          t.href === tabs.active
                            ? 'border-brand-700 text-brand-700'
                            : 'border-transparent text-ink-soft hover:text-ink',
                        )}
                      >
                        {t.label}
                      </Link>
                    ))}
                  </nav>
                )}
                {children}
              </>
            )}
            <WelcomeDialog me={data} />
            <SetupRedirect ready={!data.company.needsWelcome && !data.company.needsWhatsapp} />
          </main>
        </div>
      </div>
    </RealtimeProvider>
  );
}
