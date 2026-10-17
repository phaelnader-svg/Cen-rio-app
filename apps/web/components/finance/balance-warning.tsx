'use client';

import { Checkbox } from '@/components/ui/field';
import { Alert } from '@/components/ui/misc';
import { useCan } from '@/lib/hooks';
import { money, useBalances } from '@/lib/finance';

/**
 * Cobrança (AM-5): aviso forte do saldo do cliente no painel de entregas — só para quem vê o
 * financeiro. Não bloqueia a operação: quando `onAck` é passado, pede confirmação consciente.
 */
export function useDeliveryBalance(q: { deliveryId?: string; serviceOrderItemIds?: string[] }) {
  const can = useCan();
  const b = useBalances(q, can('financeiro.ver'));
  const rows = (b.data ?? []).filter((r) => r.openCents > 0);
  return { rows, open: rows.reduce((a, r) => a + r.openCents, 0) };
}

export function BalanceWarning({
  deliveryId,
  serviceOrderItemIds,
  ack,
  onAck,
  delivered,
}: {
  deliveryId?: string;
  serviceOrderItemIds?: string[];
  ack?: boolean;
  onAck?: (v: boolean) => void;
  delivered?: boolean;
}) {
  const { rows, open } = useDeliveryBalance({ deliveryId, serviceOrderItemIds });
  if (open <= 0) return null;
  return (
    <div className="space-y-2" data-testid="delivery-balance">
      <Alert
        tone="danger"
        title={`${delivered ? 'Entregue com saldo' : 'Saldo pendente'}: ${money(open)}`}
      >
        {rows
          .map(
            (r) =>
              `${r.orderCode}: saldo ${money(r.openCents)}${r.dueOnDeliveryCents ? ` (na entrega ${money(r.dueOnDeliveryCents)})` : ''}${r.overdueCents ? ` · vencido ${money(r.overdueCents)}` : ''}`,
          )
          .join(' · ')}
        . A entrega não é bloqueada: combine o pagamento com o cliente.
      </Alert>
      {onAck && (
        <Checkbox
          label="Estou ciente do saldo pendente"
          checked={Boolean(ack)}
          onChange={(e) => onAck(e.target.checked)}
          data-testid="delivery-balance-ack"
        />
      )}
    </div>
  );
}
