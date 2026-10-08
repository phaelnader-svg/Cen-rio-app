import type { App } from '../src/app';
import { createCustomer, createOrder, receiptBody } from './commercial-helpers';
import { type Client, db, idemKey, setupTablet } from './helpers';

/** Próxima data (AAAA-MM-DD) com o dia da semana dado (0 = domingo), a partir de amanhã. */
export function nextDow(dow: number, minDaysAhead = 1): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + minDaysAhead);
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
export const nextFriday = () => nextDow(5);
export const nextTuesday = () => nextDow(2);

/** Concede uma permissão individual a um funcionário da equipe (sem mudar a função). */
export async function grant(admin: Client, name: string, permissions: string[]) {
  const e = await db().employee.findFirstOrThrow({
    where: { displayName: name },
    include: { user: { include: { roles: true, permissions: true } } },
  });
  const r = await admin.put(`/api/employees/${e.id}`, {
    fullName: e.fullName,
    displayName: e.displayName,
    jobTitle: e.jobTitle,
    color: e.color,
    roleIds: e.user.roles.map((x) => x.roleId),
    extraPermissions: [
      ...new Set([...e.user.permissions.map((p) => p.permission), ...permissions]),
    ],
    version: e.version,
  });
  if (r.status !== 200) throw new Error(`grant: ${JSON.stringify(r.body)}`);
  return e.userId;
}

/** OS aberta com sofá (1) + poltronas (2), já recebidas. */
export async function openServiceOrder(admin: Client, name = 'Cliente Medição') {
  const customer = await createCustomer(admin, { name, phone: null, allowSimilar: true });
  const order = await createOrder(admin, customer, [
    { pieceType: 'SOFA', description: 'Sofá 3 lugares', quantity: 1 },
    { pieceType: 'POLTRONA', description: 'Poltronas', quantity: 2 },
  ]);
  const rec = await admin.post(
    '/api/v1/receipts',
    receiptBody(
      order.id,
      order.items.map((i: { id: string; quantity: number }) => ({
        orderItemId: i.id,
        quantity: i.quantity,
      })),
    ),
    { 'idempotency-key': idemKey() },
  );
  if (rec.status !== 201) throw new Error(`receipt: ${JSON.stringify(rec.body)}`);
  const so = await admin.post(
    '/api/v1/service-orders',
    {
      orderId: order.id,
      items: [
        {
          orderItemId: order.items[0].id,
          quantity: 1,
          description: 'Sofá 3 lugares',
          serviceType: 'REFORMA_COMPLETA',
        },
        {
          orderItemId: order.items[1].id,
          quantity: 2,
          description: 'Poltronas',
          serviceType: 'TROCA_DE_TECIDO',
        },
      ],
    },
    { 'idempotency-key': idemKey() },
  );
  if (so.status !== 201) throw new Error(`os: ${JSON.stringify(so.body)}`);
  return so.body as {
    id: string;
    code: string;
    version: number;
    // Sempre duas peças (sofá e poltronas): tupla para indexação segura nos testes.
    items: [{ id: string; code: string }, { id: string; code: string }];
  };
}

export async function gestorUserId() {
  return (await db().user.findUniqueOrThrow({ where: { email: 'gestor@teste.local' } })).id;
}

export async function tapeceiroTablet(
  app: App,
  admin: Client,
  name: 'Ricardo' | 'Márcio',
  pin: string,
) {
  const userId = await grant(admin, name, ['medicoes.extraordinarias']);
  const { tablet } = await setupTablet(app, admin, { name: `Tablet ${name}`, employee: name, pin });
  return { tablet, userId };
}

export const fabric = (overrides: Record<string, unknown> = {}) => ({
  kind: 'TECIDO',
  sourcing: 'EXCLUSIVO_OS',
  description: 'Linho',
  color: 'Bege',
  quantity: 12,
  unit: 'METRO',
  ...overrides,
});

export const foam = (overrides: Record<string, unknown> = {}) => ({
  kind: 'ESPUMA',
  sourcing: 'EXCLUSIVO_OS',
  description: 'Espuma',
  foamDensity: 'D28',
  thicknessCm: 3,
  lengthCm: 200,
  widthCm: 60,
  quantity: 2,
  unit: 'PLACA',
  ...overrides,
});

export async function createMeasurement(
  admin: Client,
  body: Record<string, unknown>,
  key = idemKey(),
) {
  return admin.post('/api/v1/measurements', body, { 'idempotency-key': key });
}

/** Salva rascunho e envia (como o executor faria). */
export async function fillAndSubmit(
  client: Client,
  m: { id: string; version: number },
  body: { pieces?: unknown[]; items?: unknown[] },
) {
  const draft = await client.put(`/api/v1/measurements/${m.id}/draft`, {
    pieces: [],
    items: [],
    ...body,
    version: m.version,
  });
  if (draft.status !== 200) return draft;
  return client.post(
    `/api/v1/measurements/${m.id}/submit`,
    { version: draft.body.version },
    { 'idempotency-key': idemKey() },
  );
}
