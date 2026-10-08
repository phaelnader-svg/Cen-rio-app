import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import {
  WsClient,
  createTestApp,
  idemKey,
  loginAdmin,
  resetDatabase,
  setupTablet,
} from './helpers';
import {
  approvedNeeds,
  confirmPurchase,
  createPurchase,
  createSupplier,
  linen,
  ok,
  receive,
} from './purchasing-helpers';

let app: App;
const sockets: WsClient[] = [];
const track = (w: WsClient) => (sockets.push(w), w);

beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
  await app.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  (app.ctx.hub as unknown as { feed: { lastSeq: bigint } }).feed.lastSeq = 0n;
});
afterEach(async () => {
  await Promise.all(sockets.splice(0).map((s) => s.close()));
});

async function draftFabric(admin: Awaited<ReturnType<typeof loginAdmin>>) {
  const { so, reqs } = await approvedNeeds(admin, 'Cliente Tempo Real', (s) => [
    linen(s.items[0].id),
  ]);
  const supplier = await createSupplier(admin);
  const po = await createPurchase(admin, {
    supplierId: supplier.id,
    items: [
      {
        sourcing: 'EXCLUSIVO_OS',
        allocations: [{ materialRequirementId: reqs[0]!.id, quantity: 12 }],
        quantity: 12,
        unitPriceCents: 4500,
      },
    ],
  });
  return { so, po: po.body };
}

describe('Compras e recebimento em tempo real', () => {
  it('tablet recebe o pedido confirmado; painel recebe recebimento e prontidão — sem valores', async () => {
    const admin = await loginAdmin(app);
    const { tablet } = await setupTablet(app, admin, {
      name: 'Tablet João',
      employee: 'João',
      pin: '121212',
    });
    const { so, po } = await draftFabric(admin);
    const wTablet = track(await WsClient.connect(app, tablet));
    const wGestor = track(await WsClient.connect(app, admin));

    const confirmed = (await confirmPurchase(admin, po)).body;
    const c = await wTablet.waitFor((x) => x.event?.type === 'purchase_order.confirmed');
    expect(c.event.payload).toEqual({ id: po.id, code: po.code, status: 'CONFIRMADO' });
    await wGestor.waitFor(
      (x) =>
        x.event?.type === 'material.readiness_changed' &&
        x.event.payload.to === 'AGUARDANDO_RECEBIMENTO',
    );

    await receive(tablet, confirmed.id, [ok(confirmed.items[0].id, 12)]);
    const received = await wGestor.waitFor((x) => x.event?.type === 'material.received');
    expect(received.event.payload.status).toBe('RECEBIDO');
    const ready = await wGestor.waitFor(
      (x) => x.event?.type === 'material.readiness_changed' && x.event.payload.to === 'COMPLETO',
    );
    expect(ready.event.payload.serviceOrderId).toBe(so.id);
    await wTablet.waitFor((x) => x.event?.type === 'material.received');
    // Eventos de prontidão e de estoque são da gestão; nenhum payload leva preços.
    expect(wTablet.events('material.readiness_changed')).toHaveLength(0);
    for (const m of [...wTablet.events(), ...wGestor.events()]) {
      expect(JSON.stringify(m.payload)).not.toMatch(/cents|price/i);
    }
  });

  it('reconexão: confirmação feita com o tablet sem internet é recuperada', async () => {
    const admin = await loginAdmin(app);
    const { tablet } = await setupTablet(app, admin, {
      name: 'Tablet João',
      employee: 'João',
      pin: '121212',
    });
    const { po } = await draftFabric(admin);
    let w = track(await WsClient.connect(app, tablet));
    await admin.post('/api/sync/signal', { message: 'antes' }, { 'idempotency-key': idemKey() });
    const last = (await w.waitFor((x) => x.event?.payload?.message === 'antes')).event
      .seq as string;
    await w.close();

    await confirmPurchase(admin, po);

    w = track(await WsClient.connect(app, tablet, last));
    await w.waitFor((x) => x.kind === 'replay.done');
    const replayed = w.events('purchase_order.confirmed');
    expect(replayed).toHaveLength(1);
    expect(replayed[0].payload.id).toBe(po.id);
    // O tablet então lista o pedido como pendente de recebimento.
    const pending = await tablet.get('/api/v1/material-receipts/pending');
    expect(pending.body.map((p: { id: string }) => p.id)).toEqual([po.id]);
  });
});
