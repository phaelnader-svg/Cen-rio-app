import { zonedDateTime } from '@cenario/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setAttendanceClock } from '../src/modules/attendance/common';
import type { Client } from './helpers';
import { createTestApp, db, idemKey, resetDatabase } from './helpers';
import { day, today } from './production-helpers';
import { post, qualityKit } from './quality-helpers';

/**
 * Ligações (2026-11-26): o que foi cancelado some de todas as telas onde não deveria mais
 * aparecer — Início, agenda, roteiro, semana, tablet, celular, financeiro, alertas, escritório
 * (agentes) e Firma Viva — e o que é reagendado muda em todas. Dados fictícios.
 */
let app: App;
const TZ = 'America/Sao_Paulo';
const k = qualityKit(() => app);
beforeAll(async () => {
  app = await createTestApp();
  await app.startBackground();
});
afterAll(async () => {
  setAttendanceClock();
  await app.close();
});
beforeEach(async () => {
  await resetDatabase();
  await db().companySettings.update({
    where: { id: 1 },
    data: { workingDays: [0, 1, 2, 3, 4, 5, 6] },
  });
  setAttendanceClock(() => zonedDateTime(today(), '09:00', TZ));
});
afterEach(() => setAttendanceClock());

/** Telas que listam o que está "vivo" (nenhuma deveria mostrar o que foi cancelado). */
const SCREENS = (d: string): [string, string][] => [
  ['Início (hoje)', '/api/v1/management/today'],
  ['Início (visão geral)', '/api/v1/management/overview'],
  ['Semana (resumo)', '/api/v1/management/week'],
  ['Roteiro do dia', `/api/v1/logistics/route?date=${d}`],
  ['Celular de entregas (serviços)', '/api/v1/logistics/jobs'],
  ['Programação (fila)', '/api/v1/production/pipeline'],
  // Quadro da produção e Entregas: a API traz o histórico; a tela esconde o cancelado (26/11).
  ['Chão de fábrica', '/api/v1/shop-floor'],
  ['Comprar (materiais)', '/api/v1/os-materials/to-buy'],
  ['Escritório (agentes)', '/api/v1/office'],
  ['Escritório: entregas', '/api/v1/office/deliveries'],
  ['Escritório: previsão de caixa', '/api/v1/office/forecast'],
  ['Escritório: caixa', '/api/v1/office/cash'],
  ['Financeiro (painel)', '/api/v1/finance/dashboard'],
  // A tela "A receber" pede só as abertas/recebidas (como o painel faz).
  ['A receber', '/api/v1/finance/receivables?status=ABERTO,PARCIAL,RECEBIDO'],
  ['Mão de obra', '/api/v1/finance/labor'],
  ['Firma Viva: onde está cada peça', '/api/v1/game/item-locations'],
  ['Firma Viva: espaços', '/api/v1/game/spaces-summary'],
  ['Peças', '/api/v1/pieces'],
];

/** Em que telas (status 200) cada texto ainda aparece. */
async function sweep(c: Client, needles: string[], d = today()) {
  const out: Record<string, string[]> = {};
  const broken: string[] = [];
  for (const [name, url] of SCREENS(d)) {
    const r = await c.get(url);
    if (r.status !== 200) {
      broken.push(`${name} ${url} → ${r.status}`);
      continue;
    }
    // Peças: a tela "Em andamento" esconde entregue, devolvida e cancelada.
    const body =
      name === 'Peças'
        ? (r.body as { stage: string }[]).filter(
            (p) => !['ENTREGUE', 'DEVOLVIDA', 'CANCELADA'].includes(p.stage),
          )
        : r.body;
    const txt = JSON.stringify(body);
    const hits = needles.filter((n) => txt.includes(n));
    if (hits.length) out[name] = hits;
  }
  return { out, broken };
}

type S = Awaited<ReturnType<typeof k.scenario>>;
const soOf = async (s: S) => (await s.admin.get(`/api/v1/service-orders/${s.so.id}`)).body;
async function cancelOs(s: S, reason = 'Cliente desistiu') {
  return s.admin.post(`/api/v1/service-orders/${s.so.id}/cancel`, {
    reason,
    version: (await soOf(s)).version,
  });
}

describe('5. OS cancelada some de todas as telas', () => {
  it('5.1 OS programada, com tarefas no tablet: depois de cancelar, ninguém mais vê', async () => {
    const s = await k.scenario();
    const code = (await soOf(s)).code as string;
    const before = await sweep(s.admin, [code, s.so.id]);
    expect(Object.keys(before.out).length, 'antes de cancelar a OS aparece').toBeGreaterThan(0);
    const tabletBefore = JSON.stringify(
      (await s.tablets.Ricardo!.get('/api/v1/production-tasks/mine')).body,
    );
    expect(tabletBefore).toContain(code);
    const r = await cancelOs(s);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await sweep(s.admin, [code, s.so.id]);
    const tablet = JSON.stringify(
      (await s.tablets.Ricardo!.get('/api/v1/production-tasks/mine')).body,
    );
    expect.soft(after.broken, 'telas que falharam').toEqual([]);
    expect.soft(after.out, 'telas que ainda mostram a OS cancelada').toEqual({});
    expect.soft(tablet.includes(code), 'tablet do tapeceiro ainda mostra a OS').toBe(false);
  });

  it('5.2 OS com entrega agendada: cancelar a OS tira a peça da entrega e do roteiro', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const d = await k.schedule(s);
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    const code = d.body.code as string;
    const r = await cancelOs(s);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const del = (await s.admin.get(`/api/v1/deliveries/${d.body.id}`)).body;
    expect.soft(del.status, 'entrega só daquela peça fica cancelada').toBe('CANCELADA');
    const after = await sweep(s.admin, [code], day(1));
    expect.soft(after.out).toEqual({});
  });

  it('5.3 OS com peça JÁ ENTREGUE ao cliente não pode ser cancelada sem aviso', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const d = (await k.schedule(s, { scheduledDate: today() })).body;
    const c = await k.andreTablet(s);
    const v = await k.toDestination(c, d);
    const del = await post(c, `/api/v1/deliveries/${d.id}/deliver`, {
      version: v,
      items: [{ serviceOrderItemId: s.sofa.id, status: 'ENTREGUE' }],
    });
    if (del.status === 200) {
      const r = await cancelOs(s);
      expect
        .soft(r.status, `cancelou OS com peça entregue: ${JSON.stringify(r.body).slice(0, 300)}`)
        .toBe(422);
    } else expect.fail(`entregar falhou: ${del.status} ${JSON.stringify(del.body).slice(0, 300)}`);
  });
});

describe('6. Entrega: reagendar e cancelar', () => {
  it('6.1 reagendar a entrega muda roteiro, celular e escritório', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const d = (await k.schedule(s)).body;
    const cur = (await s.admin.get(`/api/v1/deliveries/${d.id}`)).body;
    const r = await s.admin.put(
      `/api/v1/deliveries/${d.id}`,
      {
        version: cur.version,
        scheduledDate: day(4),
        windowStart: '14:00',
        team: cur.team,
        responsibleUserId: s.ids.andre,
        itemIds: [s.sofa.id],
        reason: 'Cliente pediu outro dia',
      },
      { 'idempotency-key': idemKey() },
    );
    expect(r.status, JSON.stringify(r.body).slice(0, 400)).toBe(200);
    const old = JSON.stringify((await s.admin.get(`/api/v1/logistics/route?date=${day(1)}`)).body);
    const neu = JSON.stringify((await s.admin.get(`/api/v1/logistics/route?date=${day(4)}`)).body);
    expect.soft(old.includes(d.code), 'roteiro do dia antigo ainda mostra').toBe(false);
    expect.soft(neu.includes(d.code), 'roteiro do dia novo mostra').toBe(true);
  });

  it('6.2 cancelar a entrega: peça volta a "pronta para entregar" e some do roteiro', async () => {
    const s = await k.scenario();
    await k.ready(s, 'sofa');
    const d = (await k.schedule(s)).body;
    const cur = (await s.admin.get(`/api/v1/deliveries/${d.id}`)).body;
    const r = await post(s.admin, `/api/v1/deliveries/${d.id}/cancel`, {
      version: cur.version,
      reason: 'Cliente viajou',
    });
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    expect.soft(await k.stage(s.sofa.id)).toBe('PRONTA_ENTREGA');
    const after = await sweep(s.admin, [d.code], day(1));
    expect.soft(after.out['Roteiro do dia'] ?? []).toEqual([]);
  });
});

describe('7. Pedido cancelado some de tudo (celular, Início, escritório, financeiro, Firma Viva)', () => {
  it('7.1 No local com responsável, OS, material e cobrança: cancelar o pedido limpa todas as telas', async () => {
    const s = await k.scenario(); // cria a equipe, tablets e uma OS de outro cliente
    const andre = await k.andreTablet(s);
    const r = await post(s.admin, '/api/v1/services', {
      customer: {
        mode: 'NOVO',
        kind: 'PF',
        name: 'Cliente Desistente',
        phone: '(11) 98888-1234',
        address: {
          label: 'Casa',
          street: 'Rua Exemplo',
          number: '100',
          district: 'Centro',
          city: 'São Paulo',
          state: 'SP',
          zipCode: '01001000',
          isPrimary: true,
        },
      },
      service: {
        contractedService: 'Troca de tecido',
        agreedValueCents: 150000,
        promisedDate: day(10),
        items: [
          {
            pieceType: 'CADEIRA',
            description: 'Cadeiras',
            quantity: 4,
            serviceType: 'TROCA_DE_TECIDO',
          },
        ],
        payment: { model: 'METADE_RETIRADA_ENTREGA' },
      },
      pickup: {
        kind: 'NO_LOCAL',
        team: 'LOGISTICA_TERCEIRIZADA',
        scheduledDate: today(),
        windowStart: '14:00',
        logisticsUserId: s.ids.andre,
      },
    });
    expect(r.status, JSON.stringify(r.body).slice(0, 500)).toBe(201);
    const orderId = r.body.order.id as string;
    const pk = (await s.admin.get(`/api/v1/pickups/${r.body.pickup.id}`)).body;
    const o = (await s.admin.get(`/api/v1/orders/${orderId}`)).body;
    const os = await post(s.admin, '/api/v1/service-orders', {
      orderId,
      items: [
        {
          orderItemId: o.items[0].id,
          quantity: 4,
          description: 'Cadeiras',
          serviceType: 'TROCA_DE_TECIDO',
        },
      ],
      materials: [{ description: 'Tecido veludo azul', quantity: 6, unit: 'm' }],
    });
    expect(os.status, JSON.stringify(os.body).slice(0, 300)).toBe(201);
    const needles = [o.code, pk.code, os.body.code, 'Cliente Desistente', 'Tecido veludo azul'];
    const before = await sweep(s.admin, needles);
    expect(Object.keys(before.out).length, 'antes de cancelar o pedido aparece').toBeGreaterThan(0);
    const jobsBefore = JSON.stringify((await andre.get('/api/v1/logistics/jobs')).body);
    expect(jobsBefore.includes(pk.code), 'celular mostra antes').toBe(true);

    const cur = (await s.admin.get(`/api/v1/orders/${orderId}`)).body;
    const c = await s.admin.post(`/api/v1/orders/${orderId}/cancel`, {
      reason: 'Cliente desistiu',
      version: cur.version,
    });
    expect(c.status, JSON.stringify(c.body).slice(0, 300)).toBe(200);
    const after = await sweep(s.admin, needles);
    const jobs = JSON.stringify((await andre.get('/api/v1/logistics/jobs')).body);
    const notes = (await andre.get('/api/v1/notifications')).body as { items: { kind: string }[] };
    expect
      .soft(
        notes.items.map((n) => n.kind),
        'André é avisado',
      )
      .toContain('RETIRADA_CANCELADA');
    expect.soft(after.broken).toEqual([]);
    expect.soft(after.out, 'telas que ainda mostram o pedido cancelado').toEqual({});
    expect
      .soft(jobs.includes(pk.code), 'celular do responsável ainda mostra o serviço')
      .toBe(false);
  });
});
