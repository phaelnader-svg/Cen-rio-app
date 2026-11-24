'use client';

import {
  FEEDBACK_KINDS,
  FEEDBACK_KIND_LABEL,
  SEARCH_RESULT_LABEL,
  type FeedbackKind,
  type SearchResultDto,
  type SystemNoticeDto,
} from '@cenario/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  CornerDownLeft,
  MessageSquareWarning,
  Monitor,
  Moon,
  Search,
  Sparkles,
  Sun,
  Wrench,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { FormGrid, SelectField, TextAreaField } from '@/components/ui/form';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { NOVIDADES, NOVIDADES_KEY } from '@/lib/novidades';
import { useTheme, type ThemeChoice } from '@/lib/theme';

interface NavLink {
  href: string;
  label: string;
  group: string;
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

/**
 * Melhorias 83 e 109: busca rápida (Ctrl+K ou /) e atalhos de teclado (N novo serviço, ? ajuda).
 * Fica no topo do painel; no celular vira só o ícone da lupa.
 */
export function CommandPalette({ nav, canNewService }: { nav: NavLink[]; canNewService: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector('dialog[open]')) return;
      if (e.key === '/') {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === '?') {
        e.preventDefault();
        setHelp(true);
      } else if ((e.key === 'n' || e.key === 'N') && canNewService) {
        e.preventDefault();
        router.push('/painel/orcamentos');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router, canNewService]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center gap-2 rounded-xl border border-line bg-surface px-2.5 text-sm text-ink-muted hover:bg-subtle lg:w-56"
        aria-label="Buscar (Ctrl+K)"
        data-testid="busca-rapida"
      >
        <Search className="size-4" aria-hidden />
        <span className="hidden flex-1 text-left lg:inline">Buscar…</span>
        <kbd className="hidden rounded border border-line px-1.5 text-[11px] font-medium lg:inline">
          Ctrl K
        </kbd>
      </button>
      {open && (
        <PaletteDialog
          nav={nav}
          onClose={() => setOpen(false)}
          onGo={(href) => {
            setOpen(false);
            router.push(href);
          }}
        />
      )}
      <Dialog open={help} onClose={() => setHelp(false)} title="Atalhos de teclado" size="sm">
        <ul className="space-y-2 text-sm">
          {[
            ['Ctrl + K', 'Busca rápida'],
            ['/', 'Busca rápida'],
            ...(canNewService ? [['N', 'Novo orçamento']] : []),
            ['?', 'Mostrar esta lista'],
            ['Esc', 'Fechar janelas'],
          ].map(([k, label]) => (
            <li key={`${k}${label}`} className="flex items-center justify-between gap-3">
              <span>{label}</span>
              <kbd className="rounded-md border border-line-strong bg-subtle px-2 py-0.5 text-xs font-semibold">
                {k}
              </kbd>
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}

function PaletteDialog({
  nav,
  onClose,
  onGo,
}: {
  nav: NavLink[];
  onClose: () => void;
  onGo: (href: string) => void;
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const term = useDeferredValue(q.trim());
  const search = useQuery({
    queryKey: ['busca', term],
    // A API responde { items: [...] }; tratar como lista quebrava a tela inteira ao digitar.
    queryFn: () =>
      api<{ items: SearchResultDto[] }>(`/api/v1/search?q=${encodeURIComponent(term)}`).then((r) =>
        Array.isArray(r?.items) ? r.items : [],
      ),
    enabled: term.length >= 2,
    staleTime: 10_000,
  });
  const norm = (s: string) =>
    s
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase();
  const pages = term
    ? nav.filter((n) => norm(n.label ?? '').includes(norm(term))).slice(0, 6)
    : nav.slice(0, 8);
  const rows: { key: string; href: string; title: string; kind: string; sub: string | null }[] = [
    ...pages.map((p) => ({
      key: `p:${p.href}`,
      href: p.href,
      title: p.label,
      kind: 'Tela',
      sub: p.group,
    })),
    ...(term.length >= 2 ? (search.data ?? []) : []).map((r) => ({
      key: `${r.kind}:${r.id}`,
      href: r.href,
      title: r.title,
      kind: SEARCH_RESULT_LABEL[r.kind],
      sub: r.subtitle,
    })),
  ];
  const current = Math.min(active, Math.max(0, rows.length - 1));

  return (
    <Dialog open onClose={onClose} title="Busca rápida" size="md">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
          aria-hidden
        />
        <input
          autoFocus
          className="h-11 w-full rounded-xl border border-line-strong bg-surface pr-3 pl-9 text-[15px] outline-none focus:border-brand-500"
          placeholder="Cliente, telefone, nº do pedido, OS, orçamento ou tela"
          value={q}
          aria-label="Buscar"
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, rows.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter' && rows[current]) {
              e.preventDefault();
              onGo(rows[current].href);
            }
          }}
        />
      </div>
      <ul className="mt-3 max-h-[55vh] overflow-y-auto" role="listbox" aria-label="Resultados">
        {rows.map((r, i) => (
          <li key={r.key} role="option" aria-selected={i === current}>
            <button
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => onGo(r.href)}
              className={clsx(
                'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left',
                i === current ? 'bg-brand-50 text-brand-700' : 'hover:bg-subtle',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{r.title}</span>
                {r.sub && <span className="block truncate text-xs text-ink-muted">{r.sub}</span>}
              </span>
              <span className="shrink-0 text-xs text-ink-muted">{r.kind}</span>
              {i === current && <CornerDownLeft className="size-3.5 shrink-0" aria-hidden />}
            </button>
          </li>
        ))}
      </ul>
      {term.length >= 2 && search.isFetching && <Spinner className="mt-2" label="Buscando…" />}
      {term.length >= 2 && search.isSuccess && !rows.length && (
        <p className="mt-3 text-sm text-ink-muted">Nada encontrado para “{term}”.</p>
      )}
    </Dialog>
  );
}

const THEME_NEXT: Record<ThemeChoice, ThemeChoice> = {
  claro: 'escuro',
  escuro: 'sistema',
  sistema: 'claro',
};
const THEME_LABEL: Record<ThemeChoice, string> = {
  claro: 'Tema claro',
  escuro: 'Tema escuro',
  sistema: 'Tema igual ao do aparelho',
};

/** Melhoria 87: alterna claro → escuro → igual ao aparelho. */
export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const Icon = theme === 'escuro' ? Moon : theme === 'sistema' ? Monitor : Sun;
  return (
    <button
      type="button"
      onClick={() => setTheme(THEME_NEXT[theme])}
      className="rounded-lg p-2 text-ink-soft hover:bg-subtle"
      aria-label={`${THEME_LABEL[theme]} (trocar)`}
      title={`${THEME_LABEL[theme]}. Clique para trocar.`}
      data-testid="tema"
    >
      <Icon className="size-5" aria-hidden />
    </button>
  );
}

/** Melhoria 110: Novidades, com um ponto enquanto a mais recente não foi vista neste aparelho. */
export function WhatsNew() {
  const [open, setOpen] = useState(false);
  const latest = NOVIDADES[0]?.id;
  // Montado só no navegador (o painel aparece depois de carregar a sessão).
  const [unseen, setUnseen] = useState(() => {
    try {
      return Boolean(latest) && localStorage.getItem(NOVIDADES_KEY) !== latest;
    } catch {
      return false;
    }
  });
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setUnseen(false);
          try {
            if (latest) localStorage.setItem(NOVIDADES_KEY, latest);
          } catch {
            /* sem armazenamento */
          }
        }}
        className="relative rounded-lg p-2 text-ink-soft hover:bg-subtle"
        aria-label={unseen ? 'Novidades (há novidades)' : 'Novidades'}
        title="Novidades"
        data-testid="novidades"
      >
        <Sparkles className="size-5" aria-hidden />
        {unseen && (
          <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-bronze-500" />
        )}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Novidades" size="md">
        <div className="space-y-6">
          {NOVIDADES.map((n) => (
            <section key={n.id}>
              <p className="text-xs font-semibold text-ink-muted">
                {n.date.split('-').reverse().join('/')}
              </p>
              <h3 className="font-semibold">{n.title}</h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
                {n.items.map((it) => (
                  <li key={it}>{it}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </Dialog>
    </>
  );
}

/** Tira o print da tela (sem a janela de envio), reduzido para caber no envio. */
async function captureScreen(): Promise<string | null> {
  try {
    const { toJpeg } = await import('html-to-image');
    const el = document.getElementById('conteudo') ?? document.body;
    const scale = Math.min(1, 1280 / Math.max(1, el.scrollWidth));
    const data = await toJpeg(el, {
      quality: 0.7,
      pixelRatio: scale,
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      height: Math.min(el.scrollHeight, 2400),
      filter: (n) => !(n instanceof HTMLElement && n.dataset.semPrint !== undefined),
    });
    return data.length <= 1_400_000 ? data : null;
  } catch {
    return null;
  }
}

/** Melhoria 112: "Enviar sugestão ou problema", com o print da tela; chega na tela Empresas. */
export function FeedbackButton({ className }: { className?: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const [withShot, setWithShot] = useState(true);
  const [kind, setKind] = useState<FeedbackKind>('PROBLEMA');
  const [message, setMessage] = useState('');
  const send = useMutation({
    mutationFn: () =>
      api('/api/v1/feedback', {
        method: 'POST',
        body: {
          kind,
          message,
          pageUrl: window.location.pathname,
          screenshot: withShot ? shot : null,
        },
      }),
    onSuccess: () => {
      toast('ok', 'Recebemos. Obrigado por avisar!');
      setOpen(false);
      setMessage('');
      setShot(null);
    },
  });
  return (
    <>
      <button
        type="button"
        disabled={capturing}
        onClick={async () => {
          setCapturing(true);
          setShot(await captureScreen());
          setCapturing(false);
          setOpen(true);
        }}
        className={clsx(
          'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-ink-soft hover:bg-subtle',
          className,
        )}
        data-testid="enviar-sugestao"
      >
        <MessageSquareWarning className="size-4" aria-hidden />
        {capturing ? 'Preparando…' : 'Enviar sugestão ou problema'}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Enviar sugestão ou problema"
        description="Conte o que aconteceu ou o que poderia ser melhor. A equipe do Cenário recebe na hora."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <FormGrid>
            <SelectField
              label="Tipo"
              cols={12}
              value={kind}
              onChange={(e) => setKind(e.target.value as FeedbackKind)}
            >
              {FEEDBACK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {FEEDBACK_KIND_LABEL[k]}
                </option>
              ))}
            </SelectField>
            <TextAreaField
              label={kind === 'PROBLEMA' ? 'O que aconteceu?' : 'Qual a sua sugestão?'}
              cols={12}
              rows={4}
              maxLength={4000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </FormGrid>
          {shot ? (
            <div className="mt-4">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={withShot}
                  onChange={(e) => setWithShot(e.target.checked)}
                />
                Enviar o print da tela junto
              </label>
              {withShot && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={shot}
                  alt="Print da tela que será enviado"
                  className="mt-2 max-h-48 rounded-lg border border-line object-contain object-top"
                />
              )}
            </div>
          ) : (
            <p className="mt-3 text-xs text-ink-muted">
              Não foi possível tirar o print desta tela; a mensagem vai sem ele.
            </p>
          )}
          {send.error && (
            <Alert tone="danger" className="mt-3">
              {errorMessage(send.error)}
            </Alert>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" loading={send.isPending} disabled={message.trim().length < 3}>
              Enviar
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

/** Melhoria 131: aviso de manutenção no topo (cadastrado na tela Empresas). */
export function MaintenanceBanner() {
  const notice = useQuery({
    queryKey: ['aviso-sistema'],
    queryFn: () => api<{ notice: SystemNoticeDto | null }>('/api/public/aviso'),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
  const n = notice.data?.notice;
  if (!n) return null;
  const until = new Date(n.showUntil);
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 bg-warn-50 px-4 py-2 text-center text-sm font-medium text-warn-600"
      data-testid="aviso-manutencao"
    >
      <Wrench className="size-4 shrink-0" aria-hidden />
      <span>
        {n.message}{' '}
        <span className="font-normal">
          (até {until.toLocaleDateString('pt-BR')} às{' '}
          {until.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })})
        </span>
      </span>
    </div>
  );
}

/** Melhoria 96: erros da tela vão para o registro do servidor (no máximo 5 por visita). */
export function ClientErrorReporter() {
  const sent = useRef(0);
  useEffect(() => {
    const report = (message: string, stack?: string) => {
      if (sent.current >= 5 || !message) return;
      sent.current++;
      void fetch('/api/public/client-error', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: message.slice(0, 500),
          stack: stack?.slice(0, 4000),
          url: window.location.pathname,
          source: window.location.pathname.startsWith('/tablet') ? 'tablet' : 'painel',
        }),
        keepalive: true,
      }).catch(() => {});
    };
    const onError = (e: ErrorEvent) => report(e.message, (e.error as Error | undefined)?.stack);
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason as { message?: string; stack?: string; status?: number } | undefined;
      // Erros de API já respondidos (4xx) não são falha da tela.
      if (r && typeof r.status === 'number') return;
      report(r?.message ?? String(e.reason), r?.stack);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
  return null;
}
