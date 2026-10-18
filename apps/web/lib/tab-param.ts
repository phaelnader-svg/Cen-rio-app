'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';

/**
 * Aba inicial vinda do endereço (`?tab=`), para os links da Central abrirem o contexto certo.
 * Só aceita abas conhecidas; depois a navegação entre abas continua local.
 */
export function useTabParam(fallback: string, allowed: readonly string[]) {
  const param = useSearchParams().get('tab');
  return useState(param && allowed.includes(param) ? param : fallback);
}
