'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Rodada 3 (F10-14): link da Central que leva ao registro exato (`?foco=<id>`). A página marca a
 * linha com `data-focus-id`; quando ela aparece (os dados chegam depois), a tela rola até ela e a
 * destaca. Sem o parâmetro, nada muda. Devolve o id para a página abrir/filtrar o que precisar.
 */
export function useFocusParam(): string | null {
  const focus = useSearchParams().get('foco');
  useEffect(() => {
    if (!focus) return;
    let tries = 0;
    const timer = setInterval(() => {
      const el = document.querySelector<HTMLElement>(`[data-focus-id="${CSS.escape(focus)}"]`);
      if (el || ++tries > 50) clearInterval(timer);
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.setAttribute('data-focused', 'true');
      el.classList.add('ring-2', 'ring-brand-500', 'ring-offset-2');
    }, 100);
    return () => clearInterval(timer);
  }, [focus]);
  return focus;
}
