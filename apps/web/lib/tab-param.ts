'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';

/**
 * Aba inicial vinda do endereço (`?tab=`), para os links da Central abrirem o contexto certo.
 * Só aceita abas conhecidas; depois a navegação entre abas continua local.
 * `aliases` mantém links antigos funcionando quando abas são reunidas (ex.: `fotos` → `pecas`).
 */
export function useTabParam(
  fallback: string,
  allowed: readonly string[],
  aliases: Readonly<Record<string, string>> = {},
) {
  const raw = useSearchParams().get('tab');
  const param = raw ? (aliases[raw] ?? raw) : null;
  return useState(param && allowed.includes(param) ? param : fallback);
}
