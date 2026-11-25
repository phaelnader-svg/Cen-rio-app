'use client';

import { Bell, BellOff, Download, PlusSquare, Share, X } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import {
  enablePush,
  isIOS,
  isStandalone,
  pushSupported,
  syncPush,
  useInstallPrompt,
} from '@/lib/app-install';

/**
 * App instalado (2026-11-25): convite para instalar o Cenário na tela do aparelho e para ligar
 * os avisos. Some sozinho quando o app já está instalado ou quando o funcionário dispensa.
 */

const DISMISS_KEY = 'cenario-instalar-dispensado';

const noop = () => () => undefined;
/** true só no navegador (o servidor não sabe se o app está instalado). */
function useClient() {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

function dismissed(key: string) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function dismiss(key: string) {
  try {
    localStorage.setItem(key, '1');
  } catch {
    // navegador sem armazenamento: só some agora
  }
}

/** Passo a passo do iPhone/iPad: Compartilhar → Adicionar à Tela de Início. */
export function IosInstallSteps() {
  return (
    <ol className="space-y-3 text-left text-[17px] text-ink">
      <li className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-50 font-semibold text-brand-700">
          1
        </span>
        <span>
          Toque em <strong>Compartilhar</strong>{' '}
          <Share className="inline size-5 align-text-bottom text-info-600" aria-label="" /> na barra
          do Safari
        </span>
      </li>
      <li className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-50 font-semibold text-brand-700">
          2
        </span>
        <span>
          Toque em <strong>Adicionar à Tela de Início</strong>{' '}
          <PlusSquare className="inline size-5 align-text-bottom" aria-label="" />
        </span>
      </li>
      <li className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-50 font-semibold text-brand-700">
          3
        </span>
        <span>
          Abra o <strong>Cenário</strong> pelo ícone do sofá
        </span>
      </li>
    </ol>
  );
}

/** Faixa "Instalar o Cenário neste aparelho" (telas de entrada). */
export function InstallBanner() {
  const ready = useClient();
  const install = useInstallPrompt();
  const [hidden, setHidden] = useState(false);
  const [showIos, setShowIos] = useState(false);
  if (!ready || hidden || isStandalone() || dismissed(DISMISS_KEY)) return null;
  const ios = isIOS();
  if (!install && !ios) return null;
  return (
    <div
      data-testid="instalar-app"
      className="w-full max-w-xl rounded-2xl border border-brand-100 bg-brand-50 p-4"
    >
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon-192.png" alt="" className="size-11 rounded-xl" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink">Instalar o Cenário neste aparelho</p>
          <p className="text-sm text-ink-soft">Ícone na tela, abre direto e recebe avisos.</p>
        </div>
        <button
          type="button"
          aria-label="Agora não"
          className="grid size-9 place-items-center rounded-lg text-ink-muted hover:bg-white"
          onClick={() => {
            dismiss(DISMISS_KEY);
            setHidden(true);
          }}
        >
          <X className="size-5" />
        </button>
      </div>
      {showIos ? (
        <div className="mt-4 rounded-xl bg-white p-4">
          <IosInstallSteps />
        </div>
      ) : (
        <Button
          size="lg"
          className="mt-3 w-full"
          onClick={async () => {
            if (install) {
              if (await install()) setHidden(true);
            } else setShowIos(true);
          }}
        >
          <Download className="size-5" aria-hidden />
          Instalar Cenário
        </Button>
      )}
    </div>
  );
}

/**
 * Cartão "Receber avisos neste aparelho" (tela inicial do funcionário). Se já aceitou antes, só
 * atualiza em silêncio de quem são os avisos (quem acabou de entrar).
 */
export function PushCard() {
  const ready = useClient();
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'negado' | 'oculto'>('idle');
  useEffect(() => {
    if (ready) void syncPush();
  }, [ready]);
  if (!ready || !pushSupported() || state === 'oculto' || state === 'ok') return null;
  if (Notification.permission === 'granted') return null;
  if (isIOS() && !isStandalone()) return null; // no iPhone, avisos só com o app instalado
  if (dismissed('cenario-avisos-dispensado')) return null;
  const blocked = Notification.permission === 'denied' || state === 'negado';
  return (
    <div
      data-testid="ligar-avisos"
      className="mb-6 flex flex-wrap items-center gap-4 rounded-2xl border border-brand-100 bg-brand-50 p-4"
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-white text-brand-700">
        {blocked ? <BellOff className="size-6" /> : <Bell className="size-6" />}
      </span>
      <div className="min-w-0 flex-1 basis-56">
        <p className="font-semibold text-ink">
          {blocked ? 'Avisos bloqueados neste aparelho' : 'Receber avisos neste aparelho'}
        </p>
        <p className="text-sm text-ink-soft">
          {blocked
            ? 'Para ligar, libere as notificações do Cenário nos ajustes do aparelho.'
            : 'Tarefa nova, entrega do dia e perguntas do escritório chegam mesmo com o app fechado.'}
        </p>
      </div>
      {blocked ? (
        <Button
          variant="secondary"
          className="w-full sm:w-auto"
          onClick={() => {
            dismiss('cenario-avisos-dispensado');
            setState('oculto');
          }}
        >
          Entendi
        </Button>
      ) : (
        <Button
          size="lg"
          className="w-full sm:w-auto"
          loading={state === 'busy'}
          onClick={async () => {
            setState('busy');
            const r = await enablePush().catch(() => 'indisponivel' as const);
            setState(r === 'ok' ? 'ok' : r === 'negado' ? 'negado' : 'oculto');
          }}
        >
          <Bell className="size-5" aria-hidden />
          Ligar avisos
        </Button>
      )}
    </div>
  );
}

/**
 * iPhone/iPad que abriu o código QR no Safari: primeiro instala, e o app se liga à empresa
 * sozinho quando abrir pelo ícone (o código vai junto). Usar no Safari mesmo continua possível.
 */
export function IosInstallFromQr({ onUseBrowser }: { onUseBrowser: () => void }) {
  return (
    <main className="grid min-h-dvh place-items-center px-6 py-10">
      <div className="w-full max-w-md text-center" data-testid="instalar-iphone">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon-512.png" alt="" className="mx-auto size-24 rounded-[22px] shadow-pop" />
        <h1 className="mt-6 text-3xl font-semibold tracking-tight">Instalar o Cenário</h1>
        <p className="mt-2 text-lg text-ink-muted">
          Faça isso uma vez só. Depois é só abrir pelo ícone, que ele já entra na sua empresa.
        </p>
        <div className="mt-8 rounded-2xl border border-line bg-surface p-5">
          <IosInstallSteps />
        </div>
        <button
          type="button"
          onClick={onUseBrowser}
          className="mt-6 text-base text-ink-muted underline underline-offset-4"
        >
          Usar no Safari mesmo, sem instalar
        </button>
      </div>
    </main>
  );
}
