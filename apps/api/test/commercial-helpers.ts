import type { App } from '../src/app';
import { refreshOrderStatus } from '../src/modules/commercial/status';
import { type Client, db, idemKey, loginAdmin } from './helpers';

/** CPFs/CNPJs fictícios com dígitos verificadores válidos (gerados para teste). */
export const FAKE_CPF = ['52998224725', '11144477735', '39053344705'];
export const FAKE_CNPJ = '11222333000181';

export const address = {
  label: 'Residência',
  street: 'Rua Exemplo de Teste',
  number: '100',
  district: 'Bairro Fictício',
  city: 'Cidade Teste',
  state: 'SP',
  postalCode: '01000-000',
};

export async function createCustomer(admin: Client, overrides: Record<string, unknown> = {}) {
  const r = await admin.post(
    '/api/v1/customers',
    {
      kind: 'PF',
      name: 'Cliente Fictício',
      phone: '(11) 90000-0001',
      addresses: [address],
      ...overrides,
    },
    { 'idempotency-key': idemKey() },
  );
  if (r.status !== 201) throw new Error(`cliente: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function createOrder(
  admin: Client,
  customer: { id: string; addresses: { id: string }[] },
  items?: unknown[],
) {
  const r = await admin.post(
    '/api/v1/orders',
    {
      customerId: customer.id,
      pickupAddressId: customer.addresses[0]?.id ?? null,
      contractedService: 'Reforma completa com troca de tecido',
      agreedValueCents: 350000,
      paymentTerms: '50% na retirada, 50% na entrega',
      items: items ?? [
        { pieceType: 'SOFA', description: 'Sofá 3 lugares', quantity: 1 },
        { pieceType: 'CADEIRA', description: 'Cadeiras de jantar', quantity: 6 },
      ],
    },
    { 'idempotency-key': idemKey() },
  );
  if (r.status !== 201) throw new Error(`pedido: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function createPickup(
  admin: Client,
  order: { id: string; items: { id: string; quantity: number }[] },
  date: string | null = '2026-10-15',
) {
  const r = await admin.post(
    '/api/v1/pickups',
    {
      orderId: order.id,
      scheduledDate: date,
      windowStart: date ? '09:00' : null,
      windowEnd: date ? '12:00' : null,
      team: 'LOGISTICA_TERCEIRIZADA',
      items: order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
    },
    { 'idempotency-key': idemKey() },
  );
  if (r.status !== 201) throw new Error(`retirada: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/**
 * Recebimentos removidos: a chegada à oficina é só uma marcação opcional ("Peças na oficina" no
 * pedido ou "chegaram na oficina" na retirada). Nos testes, marca direto as quantidades chegadas.
 */
export async function markArrived(
  orderId: string,
  lines: { orderItemId: string; quantity: number }[],
) {
  await db().$transaction(async (tx) => {
    for (const l of lines)
      await tx.commercialOrderItem.update({
        where: { id: l.orderItemId },
        data: { receivedQuantity: { increment: l.quantity } },
      });
    await refreshOrderStatus(tx, orderId);
  });
  return { status: 201 as const, body: null as unknown };
}

/** Usuário de painel com uma função contendo só as permissões indicadas. */
export async function panelUserWith(app: App, admin: Client, tag: string, permissions: string[]) {
  const role = await admin.post(
    '/api/roles',
    { name: `Função ${tag}`, permissions: ['painel.acessar', ...permissions] },
    { 'idempotency-key': idemKey() },
  );
  if (role.status !== 201) throw new Error(`role: ${JSON.stringify(role.body)}`);
  const email = `${tag}@teste.local`;
  const emp = await admin.post(
    '/api/employees',
    {
      fullName: `Pessoa ${tag}`,
      displayName: tag,
      jobTitle: 'Teste',
      color: '#445566',
      roleIds: [role.body.id],
      email,
      password: 'SenhaSegura123',
    },
    { 'idempotency-key': idemKey() },
  );
  if (emp.status !== 201) throw new Error(`emp: ${JSON.stringify(emp.body)}`);
  return loginAdmin(app, { email, password: 'SenhaSegura123' });
}
