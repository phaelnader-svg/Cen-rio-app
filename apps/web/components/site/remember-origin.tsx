'use client';

import { useEffect } from 'react';
import { rememberOrigin } from '@/lib/origem';

/** Item 45: guarda de onde veio o visitante, para o Criar conta mandar junto. */
export function RememberOrigin() {
  useEffect(() => {
    rememberOrigin();
  }, []);
  return null;
}
