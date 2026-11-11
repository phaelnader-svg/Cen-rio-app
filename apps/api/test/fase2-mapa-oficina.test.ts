import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { panelUserWith } from './commercial-helpers';
import { type Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { openServiceOrder } from './measurement-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/**
 * Reformulação, Fase 2 — mapa interno da oficina: áreas existentes + peças das OS abertas, a
 * movimentação de sempre (mesmas permissões, histórico imutável) e a localização atual na OS.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());
beforeEach(async () => resetDatabase());

const send = (c: Client, method: 'POST' | 'PUT', url: string, body: unknown = {}) =>
  c.req(method, url, body, { 'idempotency-key': idemKey() });
const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const MAP = '/api/v1/workshop-map';
const pieces = (m: J) => [...m.areas.flatMap((a: J) => a.pieces), ...m.unplaced];

describe('Mapa da oficina', () => {
  it('peças sem movimentação ficam em "sem localização" com o texto do recebimento; mover leva à área', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Mapa');
    let map = ok(await admin.get(MAP));
    expect(map.can).toEqual({ move: true, manageAreas: true });
    const mine = map.unplaced.filter((p: J) => p.serviceOrderId === so.id);
    expect(mine.map((p: J) => p.code)).toEqual(so.items.map((i: J) => i.code));
    expect(mine[0]).toMatchObject({
      customerName: 'Cliente Mapa',
      stage: 'EM_PRODUCAO',
      receiptLocations: ['Área de recebimento'],
      movedAt: null,
    });
    const area = ok(
      await send(admin, 'POST', '/api/v1/locations', { label: 'Bancada 3', position: 5 }),
    );
    const piece = so.items[0];
    ok(await send(admin, 'POST', `/api/v1/pieces/${piece.id}/move`, { locationId: area.id }));
    map = ok(await admin.get(MAP));
    const a = map.areas.find((x: J) => x.id === area.id);
    expect(a.pieces.map((p: J) => p.code)).toEqual([piece.code]);
    expect(a.pieces[0].movedBy).toBeTruthy();
    expect(map.unplaced.some((p: J) => p.id === piece.id)).toBe(false);
    // Histórico imutável continua sendo o registro de movimentações.
    expect(await db().itemLocationEvent.count({ where: { serviceOrderItemId: piece.id } })).toBe(1);
    // A OS mostra a localização atual (e mantém o texto do recebimento).
    const detail = ok(await admin.get(`/api/v1/service-orders/${so.id}`));
    const it0 = detail.items.find((i: J) => i.id === piece.id);
    expect(it0.currentLocation).toEqual({ id: area.id, label: 'Bancada 3' });
    expect(it0.locations).toEqual(['Área de recebimento']);
    expect(detail.items.find((i: J) => i.id !== piece.id).currentLocation).toBeNull();

    // Área desativada com peça continua visível (ninguém perde a peça de vista); vazia some.
    ok(
      await send(admin, 'PUT', `/api/v1/locations/${area.id}`, {
        label: 'Bancada 3',
        position: 5,
        active: false,
      }),
    );
    map = ok(await admin.get(MAP));
    expect(map.areas.find((x: J) => x.id === area.id)).toMatchObject({ active: false });
    const empty = ok(
      await send(admin, 'POST', '/api/v1/locations', { label: 'Depósito vazio', active: false }),
    );
    map = ok(await admin.get(MAP));
    expect(map.areas.some((x: J) => x.id === empty.id)).toBe(false);
  });

  it('OS cancelada e peça entregue saem do mapa', async () => {
    const admin = await loginAdmin(app);
    const a = await openServiceOrder(admin, 'Cliente Cancelado');
    const b = await openServiceOrder(admin, 'Cliente Entregue');
    await db().serviceOrder.update({
      where: { id: a.id },
      data: { status: 'CANCELADA', cancelledAt: new Date() },
    });
    await db().serviceOrderItem.update({
      where: { id: b.items[0].id },
      data: { fulfillmentStage: 'ENTREGUE' },
    });
    const ids = pieces(ok(await admin.get(MAP))).map((p: J) => p.id);
    expect(ids.some((id: string) => a.items.some((i: J) => i.id === id))).toBe(false);
    expect(ids).not.toContain(b.items[0].id);
    expect(ids).toContain(b.items[1].id);
  });

  it('quem só vê OS enxerga o mapa mas não move; sem permissão = 403', async () => {
    const admin = await loginAdmin(app);
    const so = await openServiceOrder(admin, 'Cliente Leitura');
    const viewer = await panelUserWith(app, admin, 'leitor-mapa', ['os.ver']);
    const map = ok(await viewer.get(MAP));
    expect(map.can).toEqual({ move: false, manageAreas: false });
    expect(pieces(map).length).toBeGreaterThan(0);
    const area = ok(await send(admin, 'POST', '/api/v1/locations', { label: 'Corte' }));
    expect(
      (await send(viewer, 'POST', `/api/v1/pieces/${so.items[0].id}/move`, { locationId: area.id }))
        .status,
    ).toBe(403);
    const nobody = await panelUserWith(app, admin, 'sem-mapa', ['clientes.ver']);
    expect((await nobody.get(MAP)).status).toBe(403);
  });
});
