import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { address } from './commercial-helpers';
import { day } from './production-helpers';

/**
 * Ligações (2026-11-26): números e estatísticas não contam o que foi cancelado; cliente e
 * orçamento ligados a serviço em andamento. Dados fictícios.
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

async function service(c: Client, name: string, cents: number, payment?: Record<string, unknown>) {
  const r = await post(c, '/api/v1/services', {
    customer: {
      mode: 'NOVO',
      kind: 'PF',
      name,
      phone: `(11) 9${Math.floor(10000000 + Math.random() * 89999999)}`,
      address: { ...address, isPrimary: true },
    },
    service: {
      contractedService: 'Reforma',
      agreedValueCents: cents,
      promisedDate: day(10),
      items: [
        { pieceType: 'SOFA', description: 'Sofá', quantity: 1, serviceType: 'REFORMA_COMPLETA' },
      ],
      ...(payment ? { payment } : {}),
    },
    pickup: { team: 'EQUIPE_PROPRIA', scheduledDate: day(2), windowStart: '09:00' },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { order: { id: string; customer?: { id: string } }; pickup: { id: string } };
}
async function cancel(c: Client, id: string) {
  const o = (await c.get(`/api/v1/orders/${id}`)).body;
  const r = await c.post(`/api/v1/orders/${id}/cancel`, { reason: 'Desistiu', version: o.version });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

/** Procura, em qualquer profundidade, números iguais a `v` (para achar onde um valor aparece). */
function pathsWithValue(obj: unknown, v: number, prefix = ''): string[] {
  if (obj === null || obj === undefined) return [];
  if (typeof obj === 'number') return obj === v ? [prefix] : [];
  if (Array.isArray(obj)) return obj.flatMap((x, i) => pathsWithValue(x, v, `${prefix}[${i}]`));
  if (typeof obj === 'object')
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, x]) =>
      pathsWithValue(x, v, prefix ? `${prefix}.${k}` : k),
    );
  return [];
}

describe('8. Números não contam o cancelado', () => {
  it('8.1 pedido cancelado fora de faturamento, a receber, previsão de caixa e metas', async () => {
    const admin = await loginAdmin(app);
    await service(admin, 'Cliente Fica', 111100, { model: 'METADE_RETIRADA_ENTREGA' });
    const gone = await service(admin, 'Cliente Sai', 777700, { model: 'METADE_RETIRADA_ENTREGA' });
    await cancel(admin, gone.order.id);
    const urls = [
      '/api/v1/finance/dashboard',
      '/api/v1/management/overview',
      '/api/v1/management/today',
      '/api/v1/management/week',
      '/api/v1/office/forecast',
      '/api/v1/office/cash',
      '/api/v1/office',
      '/api/v1/finance/orders',
      '/api/v1/customers',
    ];
    const problems: string[] = [];
    for (const u of urls) {
      const r = await admin.get(u);
      if (r.status !== 200) {
        problems.push(`${u} → ${r.status}`);
        continue;
      }
      // Valores do pedido cancelado (inteiro, metade, total somado) não podem aparecer.
      for (const v of [777700, 388850, 777700 + 111100, 388850 + 55550]) {
        const hits = pathsWithValue(r.body, v);
        if (hits.length) problems.push(`${u}: ${v} em ${hits.slice(0, 4).join(', ')}`);
      }
      if (JSON.stringify(r.body).includes('Cliente Sai') && u !== '/api/v1/customers')
        problems.push(`${u}: mostra "Cliente Sai"`);
    }
    console.log('8.1', problems);
    expect.soft(problems).toEqual([]);
  });
});

describe('9. Cliente e orçamento ligados a serviço em andamento', () => {
  it('9.1 arquivar (excluir) cliente com serviço em andamento: avisa/recusa', async () => {
    const admin = await loginAdmin(app);
    const s = await service(admin, 'Cliente Ativo', 100000);
    const o = (await admin.get(`/api/v1/orders/${s.order.id}`)).body;
    const cid = o.customer.id as string;
    const cur = (await admin.get(`/api/v1/customers/${cid}`)).body;
    const r = await admin.post(`/api/v1/customers/${cid}/status`, {
      active: false,
      version: cur.version,
    });
    expect.soft(r.status, 'arquivou cliente com retirada agendada e pedido aberto').toBe(422);
  });

  it('9.2 desativar funcionário responsável por retirada agendada: avisa/recusa ou tira dele', async () => {
    const admin = await loginAdmin(app);
    const andre = (await db().user.findFirst({ where: { displayName: { startsWith: 'André' } } }))!;
    const r = await post(admin, '/api/v1/services', {
      customer: {
        mode: 'NOVO',
        kind: 'PF',
        name: 'Cliente Responsável',
        phone: '(11) 98765-4321',
        address: { ...address, isPrimary: true },
      },
      service: {
        contractedService: 'Reforma',
        agreedValueCents: 100000,
        promisedDate: day(10),
        items: [
          { pieceType: 'SOFA', description: 'Sofá', quantity: 1, serviceType: 'REFORMA_COMPLETA' },
        ],
      },
      pickup: {
        team: 'LOGISTICA_TERCEIRIZADA',
        scheduledDate: day(2),
        windowStart: '09:00',
        logisticsUserId: andre.id,
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const emp = await db().employee.findFirst({ where: { userId: andre.id } });
    if (!emp) return;
    const cur = (await admin.get(`/api/employees/${emp.id}`)).body;
    const d = await admin.post(`/api/employees/${emp.id}/status`, {
      active: false,
      version: cur.version,
      reason: 'Saiu da empresa',
    });
    const p = (await admin.get(`/api/v1/pickups/${r.body.pickup.id}`)).body;
    console.log('9.2', d.status, JSON.stringify(d.body).slice(0, 300), 'responsável:', p.executor);
    if (d.status === 200)
      expect.soft(p.executor, 'retirada continua com funcionário desligado').toBeNull();
  });
});

describe('10. Retrabalho e avisos', () => {
  it('10.1 retrabalho cancelado: sai da estatística, da agenda e a retirada é cancelada', async () => {
    const admin = await loginAdmin(app);
    const s = await service(admin, 'Cliente Retrabalho', 100000);
    const o = (await admin.get(`/api/v1/orders/${s.order.id}`)).body;
    const r = await post(admin, '/api/v1/reworks', {
      originalOrderId: s.order.id,
      items: [{ orderItemId: o.items[0].id, quantity: 1 }],
      reason: 'Costura abriu',
      cause: 'ERRO_EXECUCAO',
      deliveryBusinessDays: 5,
      pickup: { team: 'EQUIPE_PROPRIA', scheduledDate: day(4), windowStart: '10:00' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const rw = (await admin.get(`/api/v1/reworks/${r.body.id}`)).body;
    const c = await admin.post(`/api/v1/reworks/${r.body.id}/cancel`, {
      reason: 'Cliente desistiu',
      version: rw.version,
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const stats = (await admin.get(`/api/v1/reworks/stats?from=${day(-1)}&to=${day(1)}`)).body;
    expect.soft(stats.count, 'retrabalho cancelado conta na estatística').toBe(0);
    const pk = await db().pickupRequest.findMany({ where: { orderId: r.body.order.id } });
    expect.soft(pk.map((p) => p.status)).toEqual(['CANCELADA']);
  });

  it('10.2 reagendar a retirada avisa o responsável do novo dia', async () => {
    const admin = await loginAdmin(app);
    const andre = (await db().user.findFirst({ where: { displayName: { startsWith: 'André' } } }))!;
    const r = await post(admin, '/api/v1/services', {
      customer: {
        mode: 'NOVO',
        kind: 'PF',
        name: 'Cliente Aviso',
        phone: '(11) 98765-1111',
        address: { ...address, isPrimary: true },
      },
      service: {
        contractedService: 'Reforma',
        agreedValueCents: 100000,
        promisedDate: day(10),
        items: [
          { pieceType: 'SOFA', description: 'Sofá', quantity: 1, serviceType: 'REFORMA_COMPLETA' },
        ],
      },
      pickup: {
        team: 'LOGISTICA_TERCEIRIZADA',
        scheduledDate: day(2),
        windowStart: '09:00',
        logisticsUserId: andre.id,
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const p = (await admin.get(`/api/v1/pickups/${r.body.pickup.id}`)).body;
    const before = await db().notification.count({ where: { userId: andre.id } });
    const u = await admin.put(`/api/v1/pickups/${p.id}`, {
      version: p.version,
      kind: p.kind,
      scheduledDate: day(6),
      windowStart: '15:00',
      windowEnd: null,
      team: p.team,
      items: p.items.map((i: { orderItemId: string; quantity: number }) => ({
        orderItemId: i.orderItemId,
        quantity: i.quantity,
      })),
    });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    const after = await db().notification.count({ where: { userId: andre.id } });
    expect.soft(after, 'responsável não recebe aviso do novo dia/horário').toBeGreaterThan(before);
    // e cancelar também avisa
    const c = await admin.post(`/api/v1/pickups/${p.id}/transition`, {
      toStatus: 'CANCELADA',
      note: 'Cliente desmarcou',
      version: u.body.version,
    });
    expect(c.status).toBe(200);
    const after2 = await db().notification.count({ where: { userId: andre.id } });
    expect.soft(after2, 'responsável não recebe aviso do cancelamento').toBeGreaterThan(after);
  });
});
