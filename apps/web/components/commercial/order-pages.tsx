'use client';

import { useSearchParams } from 'next/navigation';
import { Alert, PageHeader, Spinner } from '@/components/ui/misc';
import { useCustomer, useOrder } from '@/lib/commercial';
import { useCan } from '@/lib/hooks';
import { OrderForm } from './order-form';
import { BackLink } from './section';

export function NewOrderPage() {
  const params = useSearchParams();
  const customerId = params.get('cliente');
  const can = useCan();
  // Pré-seleção do cliente vindo da ficha do cliente.
  const full = useCustomer(customerId ?? '');
  if (!can('pedidos.gerenciar'))
    return <Alert tone="warn">Você não tem permissão para criar pedidos.</Alert>;
  if (customerId && can('clientes.ver') && full.isPending) return <Spinner />;
  return (
    <>
      <BackLink href="/painel/pedidos" label="Pedidos comerciais" />
      <PageHeader
        title="Novo pedido comercial"
        description="Registre o serviço aprovado pelo cliente. A OS técnica será criada após a chegada da peça à oficina."
      />
      <OrderForm
        initialCustomer={
          full.data
            ? {
                id: full.data.id,
                kind: full.data.kind,
                name: full.data.name,
                tradeName: full.data.tradeName,
              }
            : null
        }
      />
    </>
  );
}

export function EditOrderPage({ id }: { id: string }) {
  const order = useOrder(id);
  if (order.isPending) return <Spinner />;
  if (order.isError) return <Alert tone="danger">{order.error.message}</Alert>;
  if (order.data.status === 'CANCELADO')
    return <Alert tone="warn">Pedido cancelado não pode ser alterado.</Alert>;
  return (
    <>
      <BackLink href={`/painel/pedidos/${id}`} label={`Pedido ${order.data.code}`} />
      <PageHeader title={`Editar pedido ${order.data.code}`} />
      <OrderForm order={order.data} />
    </>
  );
}
