import type { Client } from './helpers';
import { db, idemKey } from './helpers';
import {
  createMeasurement,
  fabric,
  fillAndSubmit,
  gestorUserId,
  nextFriday,
  openServiceOrder,
} from './measurement-helpers';

type So = Awaited<ReturnType<typeof openServiceOrder>>;

/** OS com medição de rotina enviada e APROVADA; devolve as necessidades aprovadas. */
export async function approvedNeeds(admin: Client, name: string, items: (so: So) => unknown[]) {
  const so = await openServiceOrder(admin, name);
  const m = (
    await createMeasurement(admin, {
      serviceOrderId: so.id,
      kind: 'ROTINA',
      assigneeUserId: await gestorUserId(),
      dueDate: nextFriday(),
    })
  ).body;
  const sub = await fillAndSubmit(admin, m, { items: items(so) });
  if (sub.status !== 200) throw new Error(`submit: ${JSON.stringify(sub.body)}`);
  const approved = await admin.post(
    `/api/v1/measurements/${m.id}/request/approve`,
    { version: sub.body.request.version },
    { 'idempotency-key': idemKey() },
  );
  if (approved.status !== 200) throw new Error(`approve: ${JSON.stringify(approved.body)}`);
  const reqs = await db().materialRequirement.findMany({
    where: { serviceOrderId: so.id, origin: 'SOLICITACAO_APROVADA' },
    orderBy: { createdAt: 'asc' },
  });
  return { so, measurement: approved.body, reqs };
}

export const staples = (overrides: Record<string, unknown> = {}) => ({
  kind: 'OUTRO',
  sourcing: 'ESTOQUE',
  description: 'Grampos 80/10',
  quantity: 2,
  unit: 'EMBALAGEM',
  ...overrides,
});

export const linen = (soItemId: string, quantity = 12) =>
  fabric({ serviceOrderItemId: soItemId, description: 'Linho', color: 'Bege', quantity });

export async function createSupplier(admin: Client, name = 'Tecidos Exemplo Ltda') {
  const r = await admin.post('/api/v1/suppliers', {
    name,
    phone: '(11) 4000-0000',
    categories: ['TECIDO', 'ESPUMA', 'OUTRO'],
  });
  if (r.status !== 201) throw new Error(`supplier: ${JSON.stringify(r.body)}`);
  return r.body as { id: string };
}

export async function createPurchase(
  admin: Client,
  body: Record<string, unknown>,
  key = idemKey(),
) {
  return admin.post('/api/v1/purchase-orders', body, { 'idempotency-key': key });
}

export async function confirmPurchase(admin: Client, po: { id: string; version: number }) {
  return admin.post(
    `/api/v1/purchase-orders/${po.id}/confirm`,
    { version: po.version },
    { 'idempotency-key': idemKey() },
  );
}

/** Pedido confirmado com uma linha exclusiva (tecido) por necessidade informada. */
export async function confirmedFabricPurchase(
  admin: Client,
  supplierId: string,
  req: { id: string; quantity: unknown },
  unitPriceCents = 4500,
) {
  const q = Number(req.quantity);
  const po = await createPurchase(admin, {
    supplierId,
    expectedDate: '2030-01-10',
    items: [
      {
        sourcing: 'EXCLUSIVO_OS',
        allocations: [{ materialRequirementId: req.id, quantity: q }],
        quantity: q,
        unitPriceCents,
      },
    ],
  });
  if (po.status !== 201) throw new Error(`po: ${JSON.stringify(po.body)}`);
  const c = await confirmPurchase(admin, po.body);
  if (c.status !== 200) throw new Error(`confirm: ${JSON.stringify(c.body)}`);
  return c.body;
}

export async function receive(
  client: Client,
  purchaseOrderId: string,
  lines: Record<string, unknown>[],
  key = idemKey(),
) {
  return client.post(
    '/api/v1/material-receipts',
    { purchaseOrderId, lines },
    { 'idempotency-key': key },
  );
}

export const ok = (purchaseOrderItemId: string, acceptedQuantity: number) => ({
  purchaseOrderItemId,
  acceptedQuantity,
  specConfirmed: true,
});

export async function readiness(admin: Client, soId: string) {
  const r = await admin.get(`/api/v1/service-orders/${soId}/material-readiness`);
  if (r.status !== 200) throw new Error(`readiness: ${JSON.stringify(r.body)}`);
  return r.body;
}
