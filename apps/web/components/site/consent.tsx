'use client';

import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { BUTTON_BASE, BUTTON_SIZES, BUTTON_VARIANTS } from '@/components/ui/button-styles';

/**
 * Consentimento de cookies (LGPD, 2026-11-25). O site só usa cookies necessários (login, anti-robô)
 * — esses não precisam de aceite. O Google Analytics é o único opcional: o script dele NÃO é
 * carregado antes de a pessoa tocar em "Aceitar". "Recusar" tem o mesmo peso de "Aceitar" (guia de
 * cookies da ANPD), e a escolha pode ser mudada a qualquer hora pelo rodapé.
 */

export const CONSENT_KEY = 'cenario-cookies-v1';
const CHANGED = 'cenario-cookies-mudou';
const OPEN = 'cenario-cookies-abrir';

export type ConsentChoice = 'aceito' | 'recusado';

export function readConsent(): ConsentChoice | null {
  try {
    const v = window.localStorage.getItem(CONSENT_KEY);
    return v === 'aceito' || v === 'recusado' ? v : null;
  } catch {
    return null;
  }
}

function saveConsent(v: ConsentChoice) {
  try {
    window.localStorage.setItem(CONSENT_KEY, v);
  } catch {
    // Sem armazenamento (aba anônima bloqueada): vale só para esta página.
  }
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: v }));
}

/** Apaga os cookies do Google Analytics deste domínio (quando a pessoa recusa depois de aceitar). */
function clearAnalyticsCookies() {
  const host = window.location.hostname;
  const domains = ['', host, `.${host}`, `.${host.split('.').slice(-3).join('.')}`];
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0]!.trim();
    if (!/^_ga(_|$)|^_gid$|^_gat/.test(name)) continue;
    for (const d of domains)
      document.cookie = `${name}=; Max-Age=0; path=/${d ? `; domain=${d}` : ''}`;
  }
}

type GtagWindow = Window & {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
  [k: `ga-disable-${string}`]: boolean;
};

function loadAnalytics(id: string) {
  const w = window as unknown as GtagWindow;
  w[`ga-disable-${id}`] = false;
  if (w.gtag) return;
  w.dataLayer = w.dataLayer || [];

  w.gtag = function gtag() {
    // O gtag.js espera o objeto `arguments`, não um array.
    // eslint-disable-next-line prefer-rest-params
    w.dataLayer!.push(arguments);
  };
  w.gtag('js', new Date());
  // Só medição de visitas: sem sinais do Google para anúncios e sem personalização de anúncios.
  w.gtag('config', id, { allow_google_signals: false, allow_ad_personalization_signals: false });
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
  document.head.appendChild(s);
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href^="https://wa.me/"]');
    if (a && !w[`ga-disable-${id}`])
      w.gtag?.('event', 'whatsapp_click', { origem: a.getAttribute('data-origem') || 'site' });
  });
}

/**
 * Google Analytics da landing e do blog: só carrega depois do "Aceitar". Sem escolha ou com
 * "Recusar", nenhum script do Google entra na página.
 */
export function Analytics({ id }: { id: string }) {
  useEffect(() => {
    const safe = id.replace(/[^A-Z0-9-]/gi, '');
    const apply = (v: ConsentChoice | null) => {
      if (v === 'aceito') loadAnalytics(safe);
      else if (v === 'recusado') {
        (window as unknown as GtagWindow)[`ga-disable-${safe}`] = true;
        clearAnalyticsCookies();
      }
    };
    apply(readConsent());
    const onChange = (e: Event) => apply((e as CustomEvent<ConsentChoice>).detail);
    window.addEventListener(CHANGED, onChange);
    return () => window.removeEventListener(CHANGED, onChange);
  }, [id]);
  return null;
}

/** Aviso de cookies no rodapé da tela. Só aparece quando há algo opcional para aceitar. */
export function CookieBanner({ enabled }: { enabled: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    // Lê a escolha depois da montagem (o servidor não sabe o que está guardado no aparelho).
    const first = window.setTimeout(() => {
      if (readConsent() === null) setOpen(true);
    }, 0);
    const reopen = () => setOpen(true);
    window.addEventListener(OPEN, reopen);
    return () => {
      window.clearTimeout(first);
      window.removeEventListener(OPEN, reopen);
    };
  }, [enabled]);
  if (!enabled || !open) return null;
  const choose = (v: ConsentChoice) => {
    saveConsent(v);
    setOpen(false);
  };
  return (
    <section
      role="region"
      aria-label="Aviso de cookies"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-line bg-surface shadow-pop"
      data-testid="cookie-banner"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <p className="max-w-3xl text-sm leading-6 text-ink-soft">
          Usamos cookies necessários para o site funcionar. Com a sua permissão, usamos também o
          Google Analytics para saber quantas pessoas visitam o site e quais páginas leem. Nada de
          anúncios.{' '}
          <a href="/privacidade#cookies" className="font-medium text-brand-700 underline">
            Saiba mais
          </a>
        </p>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            onClick={() => choose('recusado')}
            className={clsx(BUTTON_BASE, BUTTON_VARIANTS.secondary, BUTTON_SIZES.sm)}
            data-testid="cookie-recusar"
          >
            Recusar
          </button>
          <button
            type="button"
            onClick={() => choose('aceito')}
            className={clsx(BUTTON_BASE, BUTTON_VARIANTS.secondary, BUTTON_SIZES.sm)}
            data-testid="cookie-aceitar"
          >
            Aceitar
          </button>
        </div>
      </div>
    </section>
  );
}

/** Link do rodapé que reabre o aviso para mudar a escolha. */
export function CookiePrefsButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => window.dispatchEvent(new Event(OPEN))}
      data-testid="cookie-preferencias"
    >
      Preferências de cookies
    </button>
  );
}
