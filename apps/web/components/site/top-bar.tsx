'use client';

import { ArrowRight, X } from 'lucide-react';
import { useSyncExternalStore } from 'react';

const KEY = 'cenario-tarja-fechada-v1';

/**
 * Tarja fina no topo da página de vendas (pedido do dono, 26/11/2026): convite para agendar
 * uma demonstração, pelo WhatsApp (o mesmo do botão do canto). Não fica o tempo todo: não acompanha a rolagem
 * (some ao descer a página) e, fechada no X, não volta mais para aquele visitante.
 */
const CHANGED = 'cenario-tarja-mudou';

function readClosed(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    // Sem acesso ao armazenamento do navegador: a tarja aparece e o X fecha só nesta visita.
    return closedNow;
  }
}
let closedNow = false;

function subscribe(cb: () => void) {
  window.addEventListener(CHANGED, cb);
  return () => window.removeEventListener(CHANGED, cb);
}

export function TopBar({ href, origem }: { href: string | null; origem?: string }) {
  const closed = useSyncExternalStore(subscribe, readClosed, () => false);

  if (!href || closed) return null;

  function close() {
    closedNow = true;
    try {
      window.localStorage.setItem(KEY, '1');
    } catch {
      // Idem: fecha só nesta visita.
    }
    window.dispatchEvent(new Event(CHANGED));
  }

  return (
    <div className="bg-[#064a4b] text-white" data-testid="site-tarja">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2 text-sm sm:px-6 lg:px-8">
        <p className="min-w-0 flex-1 text-center">
          <span className="font-semibold">
            Quer ver o sistema<span className="max-sm:hidden"> funcionando</span> na sua tapeçaria?
          </span>{' '}
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            {...(origem ? { 'data-origem': origem } : {})}
            className="inline-flex items-center gap-1 font-semibold whitespace-nowrap underline underline-offset-4 hover:no-underline"
            data-testid="site-tarja-link"
          >
            Agende uma demonstração <ArrowRight className="size-3.5" aria-hidden />
            <span className="sr-only"> (abre o WhatsApp em outra aba)</span>
          </a>
        </p>
        <button
          type="button"
          onClick={close}
          aria-label="Fechar aviso"
          className="-mr-1 grid size-8 shrink-0 place-items-center rounded-lg text-white/80 hover:bg-white/10 hover:text-white"
          data-testid="site-tarja-fechar"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
