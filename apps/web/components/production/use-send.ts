'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';

/** Chaves de consulta da produção invalidadas após qualquer alteração. */
export const PRODUCTION_KEYS = [
  'production-plan',
  'production-plans',
  'production-candidates',
  'production-board',
  'production-task',
  'production-templates',
  'my-tasks',
  'os-production',
  'service-order',
  // Fase 8 — ajuda e reprogramação
  'my-help',
  'help-requests',
  'help-request',
  'reschedule-proposals',
  'planning-actions',
  'skills',
  'alternatives',
];

/** Mutação genérica da produção: executa, invalida as consultas e mostra o erro. */
export function useSend(onDone?: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: ({ run }: { run: () => Promise<unknown>; ok?: string }) => run(),
    onSuccess: (_d, v) => {
      for (const k of PRODUCTION_KEYS) void qc.invalidateQueries({ queryKey: [k] });
      setError(null);
      if (v.ok) toast('ok', v.ok);
      onDone?.();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return { m, error, setError };
}
