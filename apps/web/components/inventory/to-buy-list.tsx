'use client';

import type { MaterialToBuyDto, ServiceOrderDto } from '@cenario/shared';
import { plural } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ShoppingCart } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { formatDay } from '@/lib/commercial';
import { useCan } from '@/lib/hooks';
import { toBuyKey, useMaterialsToBuy } from '@/lib/simple-materials';

/**
 * 2026-11-24 (Raphael): lista "Comprar". Todo material escrito numa OS aberta e ainda não comprado
 * aparece aqui, uma vez só (nada se digita de novo). "Comprei" marca a linha na própria OS; quando
 * era o último material que faltava, a OS ganha o "Material comprado" sozinha e entra na semana.
 */
const amount = (m: MaterialToBuyDto) =>
  m.quantity === null
    ? (m.unit ?? '')
    : `${m.quantity.toLocaleString('pt-BR', { maximumFractionDigits: 3 })}${m.unit ? ` ${m.unit}` : ''}`;

export function ToBuyList() {
  const can = useCan();
  const visible = can('os.ver');
  const manage = can('os.gerenciar');
  const list = useMaterialsToBuy(visible);
  const qc = useQueryClient();
  const toast = useToast();

  const bought = useMutation({
    mutationFn: async (m: MaterialToBuyDto) => {
      const so = m.serviceOrder;
      await api(`/api/v1/service-orders/${so.id}/material-list/${m.id}`, {
        method: 'PATCH',
        body: { purchased: true, version: m.version },
        idempotencyKey: newIdempotencyKey(),
      });
      const last = !(list.data ?? []).some((x) => x.id !== m.id && x.serviceOrder.id === so.id);
      if (!last || so.materialPurchased) return { released: null };
      // Era o último que faltava: libera a OS para a semana (versão atual, lida agora).
      const fresh = await api<ServiceOrderDto>(`/api/v1/service-orders/${so.id}`);
      if (fresh.materialPurchasedAt) return { released: null };
      await api(`/api/v1/service-orders/${so.id}/material-purchased`, {
        method: 'POST',
        body: { purchased: true, version: fresh.version },
        idempotencyKey: newIdempotencyKey(),
      });
      return { released: so.code };
    },
    onSuccess: async (r, m) => {
      toast(
        'ok',
        r.released
          ? `Tudo comprado para a ${r.released}. Ela já pode entrar na semana da oficina.`
          : `${m.description}: comprado.`,
      );
      await Promise.all([
        qc.invalidateQueries({ queryKey: toBuyKey }),
        qc.invalidateQueries({ queryKey: ['os-material-list', m.serviceOrder.id] }),
        qc.invalidateQueries({ queryKey: ['service-orders'] }),
        qc.invalidateQueries({ queryKey: ['service-order', m.serviceOrder.id] }),
      ]);
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });

  if (!visible) return null;
  const rows = list.data ?? [];
  const orders = new Set(rows.map((r) => r.serviceOrder.id)).size;

  return (
    <section className="card overflow-hidden" data-testid="to-buy">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h2 className="flex items-center gap-2 font-semibold text-ink">
          <ShoppingCart className="size-5 text-warn-600" aria-hidden /> Comprar
        </h2>
        {rows.length > 0 && (
          <span className="text-sm text-ink-muted">
            {plural(rows.length, 'material', 'materiais')} ·{' '}
            {plural(orders, 'ordem de serviço', 'ordens de serviço')}
          </span>
        )}
      </header>
      {list.isPending ? (
        <div className="p-5">
          <Spinner />
        </div>
      ) : list.isError ? (
        <Alert tone="danger" className="m-5">
          {list.error.message}
        </Alert>
      ) : rows.length === 0 ? (
        <p className="px-5 py-6 text-sm text-ink-muted">
          Nada para comprar. O material que faltar numa OS aparece aqui.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((m) => (
            <li
              key={m.id}
              className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center"
              data-testid="to-buy-row"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium text-ink">
                  {m.description}
                  {amount(m) && <span className="font-normal text-ink-soft"> — {amount(m)}</span>}
                </p>
                <p className="text-sm text-ink-muted">
                  <Link
                    href={`/painel/os/${m.serviceOrder.id}`}
                    className="font-semibold text-brand-700 hover:underline"
                  >
                    {m.serviceOrder.code}
                  </Link>{' '}
                  · {m.serviceOrder.customerName}
                  {m.serviceOrder.promisedDate &&
                    ` · entregar até ${formatDay(m.serviceOrder.promisedDate)}`}
                </p>
              </div>
              {manage && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full sm:w-auto"
                  loading={bought.isPending && bought.variables?.id === m.id}
                  disabled={bought.isPending}
                  onClick={() => bought.mutate(m)}
                  data-testid="to-buy-done"
                >
                  <Check className="size-4" aria-hidden /> Comprei
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
