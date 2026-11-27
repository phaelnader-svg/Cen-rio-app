import { zonedDateTime } from '@cenario/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { autoArrivalAt, autoReceiveDuePickups } from '../src/modules/pickups/arrival';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, naEmpresa1, resetDatabase } from './helpers';
import { address } from './commercial-helpers';
import { day, userIdOf } from './production-helpers';

/**
 * Fluxo da OS (2026-11-18, pedido do Raphael):
 *  A. Fechar o serviço cria só o pedido ("0 de 1 peças na tapeçaria") e a retirada agendada.
 *  B. A peça passa a "na tapeçaria" sozinha 1 hora depois do horário da retirada (sem horário:
 *     18h do dia) ou à mão no pedido — inclusive a peça que estava na retirada.
 *  C. A OS é gerada à mão a partir do pedido, com os dados do pedido/orçamento para preencher.
 *  D. "Material comprado" libera a OS para a programação da semana; antes disso ela não entra.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
});

const post = (c: Client, path: string, body: unknown = {}, key = idemKey()) =>
  c.post(path, body, { 'idempotency-key': key });

async function closeService(
  admin: Client,
  pickup: Record<string, unknown> | null = { scheduledDate: day(2), windowStart: '09:00' },
) {
  const r = await post(admin, '/api/v1/services', {
    customer: {
      mode: 'NOVO',
      kind: 'PF',
      name: 'Fulana de Tal',
      phone: '(11) 97777-1234',
      address: { ...address, isPrimary: true },
    },
    service: {
      contractedService: 'Reforma de sofá',
      agreedValueCents: 250000,
      promisedDate: day(30),
      technicalNotes: 'Costura dupla.',
      items: [
        {
          pieceType: 'SOFA',
          description: 'Sofá 3 lugares',
          quantity: 1,
          serviceType: 'REFORMA_COMPLETA',
          fabricName: 'Linho cinza',
          technicalNotes: 'Trocar espuma do assento',
        },
      ],
    },
    ...(pickup ? { pickup: { team: 'LOGISTICA_TERCEIRIZADA', ...pickup } } : {}),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { order: { id: string }; pickup: { id: string } | null };
}

const orderOf = async (admin: Client, id: string) =>
  (await admin.get(`/api/v1/orders/${id}`)).body as {
    version: number;
    receivedPieces: number;
    totalPieces: number;
    items: { id: string; receivedQuantity: number; inServiceOrders: number }[];
  };

async function generateOs(admin: Client, orderId: string, extra: Record<string, unknown> = {}) {
  const order = await orderOf(admin, orderId);
  const r = await post(admin, '/api/v1/service-orders', {
    orderId,
    items: order.items.map((i) => ({
      orderItemId: i.id,
      quantity: 1,
      description: 'Sofá 3 lugares',
      serviceType: 'REFORMA_COMPLETA',
      fabricName: 'Linho cinza',
    })),
    ...extra,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as {
    id: string;
    code: string;
    version: number;
    materialPurchasedAt: string | null;
  };
}

const pipeline = async (c: Client) =>
  (await c.get('/api/v1/production/pipeline')).body as {
    counts: Record<string, number>;
    items: { serviceOrder: { id: string }; stage: string }[];
    awaitingMaterial: number;
  };

describe('A. fechar o serviço', () => {
  it('cria só o pedido e a retirada agendada, sem OS', async () => {
    const admin = await loginAdmin(app);
    const before = await db().serviceOrder.count();
    const res = await closeService(admin);
    expect(res).not.toHaveProperty('serviceOrder');
    expect(await db().serviceOrder.count()).toBe(before);
    const order = await orderOf(admin, res.order.id);
    expect(order.receivedPieces).toBe(0);
    expect(order.totalPieces).toBe(1);
    const pickup = await db().pickupRequest.findUniqueOrThrow({ where: { id: res.pickup!.id } });
    expect(pickup.status).toBe('AGENDADA');
    expect(pickup.windowStart).toBe('09:00');
  });
});

describe('A2. lista de pedidos', () => {
  it('"Aguardando OS" mostra o pedido com a retirada; depois de gerar a OS ele sai e vai para "Já viraram OS"', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin);
    const list = async (stage: string) =>
      (await admin.get(`/api/v1/orders?stage=${stage}`)).body.items as {
        id: string;
        serviceOrderCount: number;
        nextPickup: { scheduledDate: string; windowStart: string } | null;
        version: number;
      }[];
    const row = (await list('SEM_OS')).find((o) => o.id === res.order.id)!;
    expect(row).toMatchObject({
      serviceOrderCount: 0,
      nextPickup: { scheduledDate: day(2), windowStart: '09:00' },
    });
    await post(admin, `/api/v1/orders/${res.order.id}/arrived`, { version: row.version });
    await generateOs(admin, res.order.id);
    expect((await list('SEM_OS')).some((o) => o.id === res.order.id)).toBe(false);
    expect((await list('COM_OS')).find((o) => o.id === res.order.id)).toMatchObject({
      serviceOrderCount: 1,
      nextPickup: null,
    });
  });
});

describe('B. peça chegou', () => {
  it('automático 1 hora depois do horário da retirada, uma vez só', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin);
    const at = zonedDateTime(day(2), '09:00', 'America/Sao_Paulo');
    const tick = (ms: number) =>
      naEmpresa1(() => autoReceiveDuePickups(app.ctx.prisma, new Date(at.getTime() + ms)));
    expect(await tick(59 * 60_000)).toBe(0);
    expect((await orderOf(admin, res.order.id)).receivedPieces).toBe(0);
    expect(await tick(60 * 60_000)).toBe(1);
    const pickup = await db().pickupRequest.findUniqueOrThrow({
      where: { id: res.pickup!.id },
      include: { events: { orderBy: { occurredAt: 'asc' } } },
    });
    expect(pickup.status).toBe('RECEBIDA_NA_OFICINA');
    expect(pickup.events.at(-1)!.note).toMatch(/automático/);
    expect((await orderOf(admin, res.order.id)).receivedPieces).toBe(1);
    expect(await tick(2 * 60 * 60_000)).toBe(0); // idempotente
  });

  it('sem horário vale 18h do dia; cancelada ou com ocorrência não muda sozinha', async () => {
    expect(
      autoArrivalAt(
        { scheduledDate: new Date(`${day(1)}T00:00:00Z`), windowStart: null },
        'America/Sao_Paulo',
      )!.getTime(),
    ).toBe(zonedDateTime(day(1), '19:00', 'America/Sao_Paulo').getTime());
    expect(autoArrivalAt({ scheduledDate: null, windowStart: null }, 'America/Sao_Paulo')).toBe(
      null,
    );

    const admin = await loginAdmin(app);
    const res = await closeService(admin);
    const p = await db().pickupRequest.findUniqueOrThrow({ where: { id: res.pickup!.id } });
    const occ = await admin.post(`/api/v1/pickups/${p.id}/transition`, {
      version: p.version,
      toStatus: 'COM_OCORRENCIA',
      note: 'Cliente não estava',
    });
    expect(occ.status, JSON.stringify(occ.body)).toBe(200);
    const later = new Date(zonedDateTime(day(3), '12:00', 'America/Sao_Paulo'));
    expect(await naEmpresa1(() => autoReceiveDuePickups(app.ctx.prisma, later))).toBe(0);
  });

  it('manual no pedido: marca também a peça que estava na retirada', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin);
    const order = await orderOf(admin, res.order.id);
    const r = await post(admin, `/api/v1/orders/${res.order.id}/arrived`, {
      version: order.version,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.receivedPieces).toBe(1);
    const pickup = await db().pickupRequest.findUniqueOrThrow({ where: { id: res.pickup!.id } });
    expect(pickup.status).toBe('RECEBIDA_NA_OFICINA');
    const again = await post(admin, `/api/v1/orders/${res.order.id}/arrived`, {
      version: r.body.version,
    });
    expect(again.status).toBe(422);
    expect(again.body.error.message).toMatch(/já chegaram/);
  });
});

describe('C e D. gerar OS e material comprado', () => {
  it('a tela de gerar OS vem com os dados do pedido', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin);
    const r = await admin.get(`/api/v1/service-orders/available?orderId=${res.order.id}`);
    expect(r.status).toBe(200);
    expect(r.body.order).toMatchObject({ technicalNotes: 'Costura dupla.', promisedDate: day(30) });
    expect(r.body.items[0]).toMatchObject({
      fabricName: 'Linho cinza',
      technicalNotes: 'Trocar espuma do assento',
      serviceType: 'REFORMA_COMPLETA',
    });
    expect(r.body.quote).toBeNull();
  });

  it('OS sem material comprado fica fora da programação até o botão', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, null);
    const order = await orderOf(admin, res.order.id);
    await post(admin, `/api/v1/orders/${res.order.id}/arrived`, { version: order.version });
    const so = await generateOs(admin, res.order.id);
    expect(so.materialPurchasedAt).toBeNull();

    let p = await pipeline(admin);
    expect(p.items.some((i) => i.serviceOrder.id === so.id)).toBe(false);
    expect(p.awaitingMaterial).toBe(1);
    const waiting = await admin.get('/api/v1/service-orders?material=AGUARDANDO');
    expect(waiting.body.items.map((x: { id: string }) => x.id)).toEqual([so.id]);

    const ricardo = await userIdOf('Ricardo');
    const item = await db().serviceOrderItem.findFirstOrThrow({ where: { serviceOrderId: so.id } });
    const blocked = await post(admin, '/api/v1/production/plan-services', {
      entries: [
        {
          serviceOrderId: so.id,
          startDate: day(3),
          pieces: [{ serviceOrderItemId: item.id, upholstererUserId: ricardo }],
        },
      ],
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.message).toMatch(/Material comprado/);

    const ok = await post(admin, `/api/v1/service-orders/${so.id}/material-purchased`, {
      version: so.version,
      purchased: true,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.materialPurchasedAt).not.toBeNull();
    expect(ok.body.materialPurchasedBy).toBeTruthy();
    p = await pipeline(admin);
    expect(p.items.find((i) => i.serviceOrder.id === so.id)?.stage).toBe('A_PLANEJAR');
    expect(p.awaitingMaterial).toBe(0);
    const audit = await db().auditLog.findFirst({
      where: { action: 'service_order.material_purchased', entityId: so.id },
    });
    expect(audit).not.toBeNull();

    // Desmarcar volta a "aguardando material".
    const undo = await post(admin, `/api/v1/service-orders/${so.id}/material-purchased`, {
      version: ok.body.version,
      purchased: false,
    });
    expect(undo.status).toBe(200);
    expect(undo.body.materialPurchasedAt).toBeNull();
  });

  it('"Material já comprado" na criação libera direto', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, null);
    const so = await generateOs(admin, res.order.id, { materialPurchased: true });
    expect(so.materialPurchasedAt).not.toBeNull();
    expect((await pipeline(admin)).items.some((i) => i.serviceOrder.id === so.id)).toBe(true);
  });
});

describe('E. materiais da OS e lista "Comprar" (2026-11-24)', () => {
  type ToBuy = {
    id: string;
    description: string;
    quantity: number | null;
    unit: string | null;
    version: number;
    serviceOrder: { id: string; code: string; customerName: string; materialPurchased: boolean };
  };
  const toBuy = async (c: Client) => (await c.get('/api/v1/os-materials/to-buy')).body as ToBuy[];

  it('a OS não copia materiais do orçamento; os escritos ao gerar vão para "Comprar"', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, null);
    const so = await generateOs(admin, res.order.id, {
      materialsFromQuote: true, // campo antigo: ignorado
      materials: [
        { description: 'Espuma D33 5 cm', quantity: 4, unit: 'placa' },
        { description: 'Cola de contato' },
      ],
    });
    const lines = await db().serviceOrderMaterial.findMany({
      where: { serviceOrderId: so.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(lines.map((l) => l.description)).toEqual(['Espuma D33 5 cm', 'Cola de contato']);
    expect(lines.every((l) => !l.purchased && !l.notes)).toBe(true);

    const list = await toBuy(admin);
    expect(list.map((m) => m.description).sort()).toEqual(['Cola de contato', 'Espuma D33 5 cm']);
    expect(list[0]!.serviceOrder.code).toBe(so.code);
    expect(list[0]!.serviceOrder.customerName).toBe('Fulana de Tal');
    expect(list.find((m) => m.unit === 'placa')?.quantity).toBe(4);

    // Linha marcada como comprada na OS sai da lista.
    const espuma = list.find((m) => m.description.startsWith('Espuma'))!;
    const patch = await admin.req(
      'PATCH',
      `/api/v1/service-orders/${so.id}/material-list/${espuma.id}`,
      { purchased: true, version: espuma.version },
      { 'idempotency-key': idemKey() },
    );
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect((await toBuy(admin)).map((m) => m.description)).toEqual(['Cola de contato']);
  });

  it('"Material comprado" na OS tira da lista o que faltava', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, null);
    const so = await generateOs(admin, res.order.id, {
      materials: [{ description: 'Percinta', quantity: 10, unit: 'm' }],
    });
    expect(await toBuy(admin)).toHaveLength(1);
    const ok = await post(admin, `/api/v1/service-orders/${so.id}/material-purchased`, {
      version: so.version,
      purchased: true,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await toBuy(admin)).toHaveLength(0);
    const line = await db().serviceOrderMaterial.findFirstOrThrow({
      where: { serviceOrderId: so.id },
    });
    expect(line.purchased).toBe(true);
  });

  it('OS cancelada não aparece em "Comprar"', async () => {
    const admin = await loginAdmin(app);
    const res2 = await closeService(admin, null);
    const so2 = await generateOs(admin, res2.order.id, {
      materials: [{ description: 'Tecido linho', quantity: 6, unit: 'm' }],
    });
    expect(await toBuy(admin)).toHaveLength(1);
    const cancel = await post(admin, `/api/v1/service-orders/${so2.id}/cancel`, {
      reason: 'Cliente desistiu',
      version: so2.version,
    });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(await toBuy(admin)).toHaveLength(0);
  });

  it('"Já comprado" na criação grava os materiais como comprados (fora da lista)', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, null);
    await generateOs(admin, res.order.id, {
      materialPurchased: true,
      materials: [{ description: 'Grampo 106/8' }],
    });
    expect(await toBuy(admin)).toHaveLength(0);
  });
});
