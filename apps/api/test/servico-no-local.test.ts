import { zonedDateTime } from '@cenario/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { autoArrivalAt, autoReceiveDuePickups } from '../src/modules/pickups/arrival';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, naEmpresa1, resetDatabase } from './helpers';
import { address } from './commercial-helpers';
import { day } from './production-helpers';

/**
 * Serviço "No local" (2026-11-25, pedido do Raphael): ao agendar, além de Retirada, o serviço
 * pode ser feito na casa do cliente. Mesma agenda/roteiro/celular; a OS já pode nascer; o
 * prazo é o dia do serviço; "serviço feito" conta as peças (não existe "chegou na tapeçaria").
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

async function closeService(admin: Client, kind?: 'RETIRADA' | 'NO_LOCAL') {
  const r = await post(admin, '/api/v1/services', {
    customer: {
      mode: 'NOVO',
      kind: 'PF',
      name: 'Cliente Exemplo',
      phone: '(11) 97777-1234',
      address: { ...address, isPrimary: true },
    },
    service: {
      contractedService: 'Troca de tecido',
      agreedValueCents: 90000,
      promisedDate: day(30),
      deliveryBusinessDays: 10,
      items: [
        {
          pieceType: 'CADEIRA',
          description: 'Cadeiras de jantar',
          quantity: 6,
          serviceType: 'TROCA_DE_TECIDO',
          fabricName: 'Linho cru',
        },
      ],
    },
    pickup: {
      team: 'EQUIPE_PROPRIA',
      scheduledDate: day(3),
      windowStart: '09:00',
      ...(kind ? { kind } : {}),
    },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { order: { id: string }; pickup: { id: string } };
}

const orderOf = async (admin: Client, id: string) =>
  (await admin.get(`/api/v1/orders/${id}`)).body as {
    version: number;
    status: string;
    onSite: boolean;
    promisedDate: string;
    receivedPieces: number;
    items: { id: string; inOnSiteVisits: number; receivedQuantity: number }[];
  };

describe('No local', () => {
  it('sem escolher, continua Retirada (nada muda para quem já usa)', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin);
    const p = (await admin.get(`/api/v1/pickups/${res.pickup.id}`)).body;
    expect(p.kind).toBe('RETIRADA');
    const o = await orderOf(admin, res.order.id);
    expect(o.onSite).toBe(false);
    expect(o.items[0]!.inOnSiteVisits).toBe(0);
  });

  it('Fechar serviço "No local": agenda, prazo = dia do serviço e OS liberada antes do dia', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, 'NO_LOCAL');
    const p = (await admin.get(`/api/v1/pickups/${res.pickup.id}`)).body;
    expect(p).toMatchObject({ kind: 'NO_LOCAL', status: 'AGENDADA', scheduledDate: day(3) });
    const o = await orderOf(admin, res.order.id);
    expect(o.onSite).toBe(true);
    expect(o.promisedDate).toBe(day(3));
    expect(o.items[0]!.inOnSiteVisits).toBe(6);
    // aparece na agenda do dia
    const agenda = (await admin.get(`/api/v1/pickups?from=${day(3)}&to=${day(3)}`)).body as {
      id: string;
      kind: string;
    }[];
    expect(agenda.find((x) => x.id === res.pickup.id)?.kind).toBe('NO_LOCAL');
    // a OS pode ser gerada sem a peça "chegar" e mostra o endereço do serviço
    const os = await post(admin, '/api/v1/service-orders', {
      orderId: res.order.id,
      items: [
        {
          orderItemId: o.items[0]!.id,
          quantity: 6,
          description: 'Cadeiras de jantar',
          serviceType: 'TROCA_DE_TECIDO',
        },
      ],
    });
    expect(os.status, JSON.stringify(os.body)).toBe(201);
    expect(os.body.onSite).toMatchObject({ date: day(3), windowStart: '09:00' });
    expect(os.body.onSite.address).toContain(address.street);
  });

  it('"Serviço feito" conta as peças de uma vez e o pedido fica "feito no local"', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, 'NO_LOCAL');
    let p = (await admin.get(`/api/v1/pickups/${res.pickup.id}`)).body;
    p = (
      await admin.post(`/api/v1/pickups/${p.id}/transition`, {
        toStatus: 'EM_EXECUCAO',
        version: p.version,
      })
    ).body;
    expect(p.allowedTransitions).toContain('RETIRADA_REALIZADA');
    const done = await admin.post(`/api/v1/pickups/${p.id}/transition`, {
      toStatus: 'RETIRADA_REALIZADA',
      version: p.version,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.status).toBe('RECEBIDA_NA_OFICINA');
    const o = await orderOf(admin, res.order.id);
    expect(o.receivedPieces).toBe(6);
    expect(o.status).toBe('RECEBIDO');
    expect(o.onSite).toBe(true);
  });

  it('trocar de Retirada para No local fica registrado e o prazo vira o dia do serviço', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin);
    const before = await orderOf(admin, res.order.id);
    expect(before.promisedDate).not.toBe(day(3));
    const p = (await admin.get(`/api/v1/pickups/${res.pickup.id}`)).body;
    const r = await admin.put(`/api/v1/pickups/${p.id}`, {
      kind: 'NO_LOCAL',
      scheduledDate: p.scheduledDate,
      windowStart: p.windowStart,
      team: p.team,
      items: p.items.map((i: { orderItemId: string; quantity: number }) => ({
        orderItemId: i.orderItemId,
        quantity: i.quantity,
      })),
      version: p.version,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.kind).toBe('NO_LOCAL');
    expect(r.body.events.some((e: { kind: string }) => e.kind === 'TIPO_ALTERADO')).toBe(true);
    expect((await orderOf(admin, res.order.id)).promisedDate).toBe(day(3));
    const log = await db().auditLog.findFirst({
      where: { entityId: p.id, action: 'pickup.updated' },
      orderBy: { createdAt: 'desc' },
    });
    expect(log?.changes).toMatchObject({ kind: { from: 'RETIRADA', to: 'NO_LOCAL' } });
  });

  it('automático só no fim do dia do serviço (18h + 1h), não 1h depois da chegada', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, 'NO_LOCAL');
    const tz = 'America/Sao_Paulo';
    expect(
      autoArrivalAt(
        { scheduledDate: new Date(`${day(3)}T00:00:00Z`), windowStart: '09:00', kind: 'NO_LOCAL' },
        tz,
      )?.toISOString(),
    ).toBe(new Date(zonedDateTime(day(3), '18:00', tz).getTime() + 3_600_000).toISOString());
    const at = zonedDateTime(day(3), '09:00', tz);
    const tick = (ms: number) =>
      naEmpresa1(() => autoReceiveDuePickups(app.ctx.prisma, new Date(at.getTime() + ms)));
    expect(await tick(2 * 3_600_000)).toBe(0);
    expect(await tick(10 * 3_600_000)).toBe(1);
    const p = await db().pickupRequest.findUniqueOrThrow({
      where: { id: res.pickup.id },
      include: { events: { orderBy: { occurredAt: 'asc' } } },
    });
    expect(p.status).toBe('RECEBIDA_NA_OFICINA');
    expect(p.events.at(-1)!.note).toMatch(/no local/);
  });

  it('roteiro do dia marca a parada como No local', async () => {
    const admin = await loginAdmin(app);
    const res = await closeService(admin, 'NO_LOCAL');
    const route = (await admin.get(`/api/v1/logistics/route?date=${day(3)}`)).body as {
      stops: { job: { id: string; kind: string; onSite?: boolean } }[];
    };
    const stop = route.stops.find((s) => s.job.id === res.pickup.id);
    expect(stop?.job).toMatchObject({ kind: 'RETIRADA', onSite: true });
  });
});
