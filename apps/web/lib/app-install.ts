'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * App instalado (2026-11-25): instalar o Cenário na tela do aparelho e ligar os avisos.
 * Android/Chrome: o navegador oferece "Instalar" (evento beforeinstallprompt).
 * iPhone/iPad: só pelo Compartilhar → "Adicionar à Tela de Início"; avisos só com o app instalado.
 */

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    listeners.forEach((l) => l());
  });
}

export function isIOS() {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)
  );
}

export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** "Instalar Cenário": null quando o navegador não oferece (já instalado, iPhone, etc.). */
export function useInstallPrompt() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  if (!deferred) return null;
  return async () => {
    const e = deferred;
    if (!e) return false;
    await e.prompt();
    const choice = await e.userChoice;
    deferred = null;
    listeners.forEach((l) => l());
    return choice.outcome === 'accepted';
  };
}

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function keyBytes(base64url: string) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration() {
  const existing = await navigator.serviceWorker.getRegistration('/tablet');
  return existing ?? navigator.serviceWorker.register('/sw.js', { scope: '/tablet' });
}

async function sendSubscription(sub: PushSubscription) {
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  await api('/api/tablet/push', {
    method: 'PUT',
    body: { endpoint: json.endpoint, keys: json.keys },
  });
}

/** Pede a permissão (precisa vir de um toque) e liga os avisos neste aparelho. */
export async function enablePush(): Promise<'ok' | 'negado' | 'indisponivel'> {
  if (!pushSupported()) return 'indisponivel';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'negado';
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const { publicKey } = await api<{ publicKey: string }>('/api/tablet/push');
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    }));
  await sendSubscription(sub);
  return 'ok';
}

/** A cada entrada: os avisos deste aparelho passam a ser de quem entrou (sem perguntar de novo). */
export async function syncPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/tablet');
    if (!reg) return;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sendSubscription(sub);
    else await enablePush();
  } catch {
    // Sem rede ou navegador recusou: o aviso continua na caixa do app.
  }
}
