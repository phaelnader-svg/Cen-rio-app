'use client';

import type { ServiceOrderDto } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ShoppingCart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

/**
 * Fluxo da OS (2026-11-18): botão rápido "Material comprado". Marcado, a OS entra na
 * programação da semana. Na lista aparece como botão (aguardando) ou selo (comprado).
 */
export function MaterialPurchasedButton({
  os,
  canManage,
  compact = false,
}: {
  os: { id: string; code: string; version: number; materialPurchasedAt: string | null };
  canManage: boolean;
  compact?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: (purchased: boolean) =>
      api<ServiceOrderDto>(`/api/v1/service-orders/${os.id}/material-purchased`, {
        method: 'POST',
        body: { version: os.version, purchased },
      }),
    onSuccess: (_so, purchased) => {
      void qc.invalidateQueries({ queryKey: ['service-orders'] });
      void qc.invalidateQueries({ queryKey: ['service-order', os.id] });
      void qc.invalidateQueries({ queryKey: ['production-pipeline'] });
      void qc.invalidateQueries({ queryKey: ['production-candidates'] });
      toast(
        'ok',
        purchased
          ? `${os.code}: material comprado. Já pode entrar na programação da semana.`
          : `${os.code}: voltou para aguardando material.`,
      );
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  if (os.materialPurchasedAt)
    return (
      <span className="inline-flex items-center gap-2">
        <span
          className="inline-flex items-center gap-1.5 text-sm font-medium text-ok-600"
          title={`Marcado em ${formatDateTime(os.materialPurchasedAt)}`}
          data-testid={`material-ok-${os.code}`}
        >
          <CheckCircle2 className="size-4" aria-hidden />
          Material comprado
        </span>
        {!compact && canManage && (
          <Button size="sm" variant="ghost" loading={m.isPending} onClick={() => m.mutate(false)}>
            Desfazer
          </Button>
        )}
      </span>
    );
  if (!canManage)
    return (
      <span className="text-sm font-medium text-warn-600" data-testid={`material-wait-${os.code}`}>
        Aguardando material
      </span>
    );
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={m.isPending}
      icon={<ShoppingCart className="size-4" aria-hidden />}
      onClick={() => m.mutate(true)}
      data-testid={`material-buy-${os.code}`}
    >
      Material comprado
    </Button>
  );
}
