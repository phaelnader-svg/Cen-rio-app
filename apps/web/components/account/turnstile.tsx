'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '@/lib/api';

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id?: string) => void;
    };
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/**
 * Anti-robô (melhoria 5): Cloudflare Turnstile, invisível na maioria das vezes. A chave pública
 * vem do servidor (/api/auth/signup-config); sem chave, não aparece nada e o formulário segue.
 * `onToken` recebe o token a mandar junto do formulário.
 */
export function Turnstile({ onToken }: { onToken: (token: string | undefined) => void }) {
  const cfg = useQuery({
    queryKey: ['signup-config'],
    queryFn: () => api<{ captchaSiteKey: string | null }>('/api/auth/signup-config'),
    staleTime: Infinity,
  });
  const box = useRef<HTMLDivElement>(null);
  const cb = useRef(onToken);
  useEffect(() => {
    cb.current = onToken;
  }, [onToken]);
  const siteKey = cfg.data?.captchaSiteKey ?? null;

  useEffect(() => {
    if (!siteKey || !box.current) return;
    let widget: string | undefined;
    let cancelled = false;
    const mount = () => {
      if (cancelled || !window.turnstile || !box.current) return;
      widget = window.turnstile.render(box.current, {
        sitekey: siteKey,
        appearance: 'interaction-only',
        language: 'pt-br',
        callback: (t: string) => cb.current(t),
        'expired-callback': () => cb.current(undefined),
        'error-callback': () => cb.current(undefined),
      });
    };
    if (window.turnstile) mount();
    else {
      let s = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT}"]`);
      if (!s) {
        s = document.createElement('script');
        s.src = SCRIPT;
        s.async = true;
        document.head.appendChild(s);
      }
      s.addEventListener('load', mount);
    }
    return () => {
      cancelled = true;
      if (widget) window.turnstile?.remove(widget);
    };
  }, [siteKey]);

  if (!siteKey) return null;
  return <div ref={box} className="min-h-0" />;
}

/** Campo-isca: invisível para pessoas; robô que preenche tudo é recusado pelo servidor. */
export function Honeypot({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
      <label>
        Site
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    </div>
  );
}
