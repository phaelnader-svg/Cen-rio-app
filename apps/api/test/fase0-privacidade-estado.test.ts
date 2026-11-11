import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import type { Client } from './helpers';
import { WsClient, createTestApp, db, resetDatabase } from './helpers';
import { FAKE_CPF } from './commercial-helpers';
import { post, qualityKit } from './quality-helpers';

/**
 * Reformulação, Fase 0.
 *
 * 1) Privacidade dos tablets por VARREDURA: todas as rotas GET acessíveis a tablet (catálogo de
 *    rotas da própria API, não uma lista escrita à mão) são chamadas por cada tablet com os ids do
 *    cenário; nenhuma resposta de produção pode trazer nome completo, telefone, e-mail, documento
 *    ou endereço do cliente, nem campos de valores. O motorista (logística) recebe o contato só
 *    nas rotas de logística. O painel mantém o nome completo.
 * 2) Estado operacional da OS: derivado, coerente com a etapa gravada e sem efeito colateral.
 */
let app: App;
const kit = qualityKit(() => app);
const sockets: WsClient[] = [];
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

const FULL = 'Helena Beatriz Sigilosa';
const SHORT = 'Helena S.';
/** Marcadores do cliente fictício que nunca podem chegar a um tablet de produção. */
const PII = [
  'Sigilosa',
  'Beatriz',
  '98765',
  'sigilosa@',
  FAKE_CPF[1]!,
  'Confidencial',
  'Azul Sigiloso',
  '04567',
];

async function workshop() {
  const s = await kit.scenario();
  const customerId = await kit.customerOf(s);
  await db().customer.update({
    where: { id: customerId },
    data: {
      name: FULL,
      phone: '11987654321',
      whatsapp: '11987654321',
      email: 'helena.sigilosa@exemplo.test',
      document: FAKE_CPF[1],
    },
  });
  await db().customerAddress.updateMany({
    where: { customerId },
    data: {
      street: 'Rua Confidencial Teste',
      postalCode: '04567890',
      reference: 'Portão Azul Sigiloso',
    },
  });
  return { s, customerId };
}

type Catalog = { method: string; url: string; access: { session?: string } }[];

/** Chama toda rota GET de tablet com cada id do cenário; devolve [rota, corpo] das respostas 200. */
async function sweep(c: Client, ids: string[], date: string) {
  const catalog = (app.app as unknown as { routeCatalog: Catalog }).routeCatalog;
  const routes = catalog.filter(
    (r) => r.method === 'GET' && r.access.session !== 'WEB' && !r.url.includes('/realtime'),
  );
  const out: { url: string; body: string }[] = [];
  for (const r of routes) {
    const urls = r.url.includes(':')
      ? ids.map((id) => r.url.replace(/:[a-zA-Z]+/g, id))
      : [r.url, `${r.url}?date=${date}`];
    for (const u of urls) {
      const res = await c.get(u);
      if (res.status === 200) out.push({ url: r.url, body: JSON.stringify(res.body) });
    }
  }
  return out;
}

describe('Privacidade do cliente nos tablets (varredura de todas as rotas de tablet)', () => {
  it('produção: nenhum dado pessoal nem valor em nenhuma rota, aviso ou tempo real; motorista só na logística; painel completo', async () => {
    const { s } = await workshop();
    for (const t of Object.values(s.tablets)) sockets.push(await WsClient.connect(app, t));
    await kit.ready(s, 'sofa');
    await kit.finish(s.tablets.Márcio!, s.poltronaTask.id);
    const open = (await kit.openOf(s.poltronas.id))!;
    expect(
      (
        await post(s.tablets.Thiago!, `/api/v1/quality/inspections/${open.id}/start`, {
          version: open.version,
        })
      ).status,
    ).toBe(200);
    const andre = await kit.andreTablet(s);
    expect((await kit.schedule(s)).status).toBe(201);

    const ids = new Set<string>([s.so.id, s.sofa.id, s.poltronas.id, open.id]);
    for (const m of [
      db().productionTask,
      db().receipt,
      db().qualityInspection,
      db().packagingRecord,
      db().delivery,
      db().commercialOrder,
    ] as unknown as { findMany: () => Promise<{ id: string }[]> }[])
      for (const r of await m.findMany()) ids.add(r.id);
    const date = new Date().toISOString().slice(0, 10);

    // Tablets de produção (tapeceiros, inspetor, embalador).
    let checked = 0;
    const routesSeen = new Set<string>();
    for (const [name, t] of Object.entries(s.tablets))
      for (const r of await sweep(t, [...ids], date)) {
        checked += 1;
        routesSeen.add(r.url);
        for (const marker of PII)
          expect(r.body, `${name} ${r.url} vazou "${marker}"`).not.toContain(marker);
        expect(r.body, `${name} ${r.url} trouxe valores`).not.toMatch(/"[a-zA-Z]*Cents"/);
      }
    expect(checked).toBeGreaterThan(40);
    // A varredura alcançou as telas onde o vazamento existia (qualidade e avisos) e a produção.
    for (const must of [
      '/api/v1/quality/inspections',
      '/api/v1/quality/inspections/:id',
      '/api/v1/notifications',
      '/api/v1/production-tasks/:id',
    ])
      expect(routesSeen, must).toContain(must);
    // O inspetor ainda reconhece a peça pela forma reduzida.
    const insp = (await s.tablets.Thiago!.get(`/api/v1/quality/inspections/${open.id}`)).body;
    expect(insp.piece.customer).toBe(SHORT);
    const notes = (await s.tablets.Thiago!.get('/api/v1/notifications')).body.items as {
      kind: string;
      body: string;
    }[];
    expect(notes.find((n) => n.kind === 'INSPECAO_ATRIBUIDA')?.body).toContain(SHORT);
    // Tempo real: nada pessoal nos eventos recebidos pelos tablets.
    for (const ws of sockets)
      for (const marker of PII) expect(JSON.stringify(ws.messages)).not.toContain(marker);

    // Motorista: contato completo só nas rotas de logística (necessidade da entrega).
    const andreRoutes = await sweep(andre, [...ids], date);
    for (const r of andreRoutes) {
      const logistics = r.url.startsWith('/api/v1/logistics/');
      if (!logistics && r.url !== '/api/v1/notifications')
        for (const marker of PII) expect(r.body, `André ${r.url}`).not.toContain(marker);
    }
    expect(
      andreRoutes.some((r) => r.url === '/api/v1/logistics/jobs' && r.body.includes(FULL)),
    ).toBe(true);

    // Painel (gestor): dados completos.
    expect((await s.admin.get(`/api/v1/quality/inspections/${open.id}`)).body.piece.customer).toBe(
      FULL,
    );
    const panelNotes = await db().notification.findMany({ where: { kind: 'INSPECAO_ATRIBUIDA' } });
    expect(panelNotes.some((n) => n.body.includes(FULL))).toBe(true);
  });
});

describe('Estado operacional da OS (derivado, somente leitura)', () => {
  it('coerente com a etapa gravada e as tarefas; não grava nada; só no painel', async () => {
    const { s } = await workshop();
    const read = async () =>
      (await s.admin.get(`/api/v1/service-orders/${s.so.id}/operational-state`)).body;
    const snapshot = async () =>
      JSON.stringify([
        await db().serviceOrderItem.findMany({
          orderBy: { id: 'asc' },
          select: { id: true, fulfillmentStage: true, version: true },
        }),
        await db().productionTask.findMany({
          orderBy: { id: 'asc' },
          select: { id: true, status: true, blockers: true, version: true },
        }),
        await db().serviceOrder.findMany({
          select: { id: true, version: true, materialsReadiness: true },
        }),
        await db().domainEvent.count(),
        await db().auditLog.count(),
      ]);

    const before = await snapshot();
    const r0 = await read();
    expect(await snapshot()).toBe(before);
    expect(r0.items.map((i: { stage: string }) => i.stage)).toEqual(['EM_PRODUCAO', 'EM_PRODUCAO']);
    expect(r0.items.map((i: { state: string }) => i.state)).toEqual([
      'PRONTA_PARA_PRODUCAO',
      'PRONTA_PARA_PRODUCAO',
    ]);
    expect(r0.state).toBe('PRONTA_PARA_PRODUCAO');

    // Sofá produzido, aprovado e embalado; poltronas iniciadas.
    await kit.ready(s, 'sofa');
    expect(
      (await post(s.tablets.Márcio!, `/api/v1/production-tasks/${s.poltronaTask.id}/start`)).status,
    ).toBe(200);
    const r1 = await read();
    const byId = Object.fromEntries(
      r1.items.map((i: { serviceOrderItemId: string }) => [i.serviceOrderItemId, i]),
    );
    expect(byId[s.sofa.id]).toMatchObject({
      stage: 'PRONTA_ENTREGA',
      state: 'PRONTA_PARA_ENTREGA',
    });
    expect(byId[s.poltronas.id]).toMatchObject({ stage: 'EM_PRODUCAO', state: 'EM_PRODUCAO' });
    expect(r1).toMatchObject({ state: 'EM_PRODUCAO', activeItems: 2, totalItems: 2 });
    expect(r1.counts).toEqual({ PRONTA_PARA_ENTREGA: 1, EM_PRODUCAO: 1 });
    // A etapa gravada continua sendo a fonte: o estado não difere dela fora de "em produção".
    const items = await db().serviceOrderItem.findMany({ where: { serviceOrderId: s.so.id } });
    expect(items.find((i) => i.id === s.sofa.id)!.fulfillmentStage).toBe('PRONTA_ENTREGA');

    // Acesso: só painel com os.ver; tablet recusado; OS inexistente = 404.
    expect(
      (await s.tablets.Márcio!.get(`/api/v1/service-orders/${s.so.id}/operational-state`)).status,
    ).toBe(403);
    expect(
      (
        await s.admin.get(
          '/api/v1/service-orders/00000000-0000-4000-8000-000000000000/operational-state',
        )
      ).status,
    ).toBe(404);
  });
});
