'use client';

import { useEffect } from 'react';

/**
 * Zoom no app instalado (e nas telas /dono e /tablet): pode ampliar com dois dedos para ver um
 * detalhe, mas ao soltar a tela volta ao tamanho normal. Antes o zoom ficava preso e era preciso
 * tirar na mão. No site aberto no navegador nada muda (zoom livre, por acessibilidade).
 *
 * Como volta: o navegador só desfaz o zoom quando o viewport passa a proibir ampliação; então,
 * por um instante, trocamos o meta viewport para "maximum-scale=1" e devolvemos o original.
 */
const NORMAL = 'width=device-width, initial-scale=1';
const TRAVADO = 'width=device-width, initial-scale=1, maximum-scale=1';

function emModoApp(): boolean {
  if (typeof window === 'undefined') return false;
  const instalado =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const caminho = window.location.pathname;
  return instalado || caminho.startsWith('/dono') || caminho.startsWith('/tablet');
}

export function AppZoomReset() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !emModoApp()) return;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'viewport';
      meta.content = NORMAL;
      document.head.appendChild(meta);
    }
    const original = meta.content || NORMAL;
    let dedos = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const voltar = () => {
      if (dedos > 0 || vv.scale <= 1.01 || !meta) return;
      meta.content = TRAVADO;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (meta) meta.content = original;
      }, 350);
    };
    const contar = (e: TouchEvent) => {
      dedos = e.touches.length;
      if (dedos === 0) setTimeout(voltar, 60);
    };
    // Também desfaz o zoom que o celular dá sozinho ao tocar num campo.
    const aoMudar = () => setTimeout(voltar, 250);

    document.addEventListener('touchstart', contar, { passive: true });
    document.addEventListener('touchend', contar, { passive: true });
    document.addEventListener('touchcancel', contar, { passive: true });
    vv.addEventListener('resize', aoMudar);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('touchstart', contar);
      document.removeEventListener('touchend', contar);
      document.removeEventListener('touchcancel', contar);
      vv.removeEventListener('resize', aoMudar);
      if (meta) meta.content = original;
    };
  }, []);
  return null;
}
