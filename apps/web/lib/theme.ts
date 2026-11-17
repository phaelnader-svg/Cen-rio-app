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

export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  // Montado só no navegador (o painel aparece depois de carregar a sessão).
  const [choice, setChoice] = useState<ThemeChoice>(read);
  const set = useCallback((c: ThemeChoice) => {
    try {
      localStorage.setItem(THEME_KEY, c);
    } catch {
      /* navegador sem armazenamento: vale só nesta visita */
    }
    setChoice(c);
    applyTheme(c);
  }, []);
  return [choice, set];
}
