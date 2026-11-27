'use client';

import { useCallback, useEffect, useState } from 'react';
import { THEME_KEY } from './theme-prepaint';

/** Melhoria 87: tema do painel, guardado neste aparelho. */
export type ThemeChoice = 'claro' | 'escuro' | 'sistema';

const read = (): ThemeChoice => {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'escuro' || v === 'sistema' ? v : 'claro';
  } catch {
    return 'claro';
  }
};

const resolve = (c: ThemeChoice) =>
  c === 'escuro' || (c === 'sistema' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    ? 'escuro'
    : 'claro';

export function applyTheme(c: ThemeChoice) {
  document.documentElement.dataset.tema = resolve(c);
}

/** Liga o tema enquanto o painel está aberto; fora dele (site, links do cliente) fica claro. */
export function useThemeScope() {
  useEffect(() => {
    applyTheme(read());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme(read());
    mq.addEventListener('change', onChange);
    return () => {
      mq.removeEventListener('change', onChange);
      delete document.documentElement.dataset.tema;
    };
  }, []);
}

const THEME_EVENT = 'cenario:tema';

export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  // Montado só no navegador (o painel aparece depois de carregar a sessão).
  const [choice, setChoice] = useState<ThemeChoice>(read);
  // Mais de um botão de tema (topo e menu do celular) mostram sempre a mesma escolha.
  useEffect(() => {
    const onTheme = (e: Event) => setChoice((e as CustomEvent<ThemeChoice>).detail);
    window.addEventListener(THEME_EVENT, onTheme);
    return () => window.removeEventListener(THEME_EVENT, onTheme);
  }, []);
  const set = useCallback((c: ThemeChoice) => {
    try {
      localStorage.setItem(THEME_KEY, c);
    } catch {
      /* navegador sem armazenamento: vale só nesta visita */
    }
    applyTheme(c);
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: c }));
  }, []);
  return [choice, set];
}
