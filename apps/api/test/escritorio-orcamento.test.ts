import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OfficeOverviewDto, QuoteCatalogItemDto } from '@cenario/shared';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { type QuotePlan, setQuotePlanner } from '../src/modules/game/office-quote';
import { type Client, createTestApp, db, idemKey, resetDatabase } from './helpers';
import { qualityKit } from './quality-helpers';

/**
 * Orçamento pelo pedido (Escritório, 2026-11-25): a IA monta (aqui, plano fixo) com a tabela da
 * empresa; a API recalcula; aprovar salva o orçamento e devolve o WhatsApp com o link da proposta.
 */
let app: App;
const k = qualityKit(() => app);
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  setClock();
  await db().companySettings.update({ where: { id: 1 }, data: { plan: 'gestao_jogo' } });
});
afterEach(() => setQuotePlanner(null));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const send = (c: Client, method: 'POST' | 'PUT', url: string, body: unknown) =>
  c.req(method, url, body, { 'idempotency-key': idemKey() });
const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const overview = (c: Client) => c.get('/api/v1/office').then((r) => ok<OfficeOverviewDto>(r));

async function item(c: Client, body: Record<string, unknown>) {
  const list = ok<QuoteCatalogItemDto[]>(
    await send(c, 'POST', '/api/v1/quotes/catalog', body),
    201,
  );
  return list.filter((x) => x.kind === body.kind && x.name === body.name).at(-1)!;
}

async function setup() {
  const s = await k.scenario();
  const c = s.admin;
  const linho = await item(c, {
    kind: 'MATERIAL',
    category: 'Tecidos',
    name: 'Linho',
    priceCents: 3500,
    unit: 'm',
  });
  const d33 = await item(c, {
    kind: 'MATERIAL',
    category: 'Espumas',
    name: 'D33',
    priceCents: 138000,
    unit: 'm³',
  });
  const rota = await item(c, { kind: 'LOGISTICA', name: 'Jacareí', km: 30, priceCents: 8000 });
  const sofa = await item(c, { kind: 'MAO_TAPECEIRO', name: 'Sofá 3 lugares', priceCents: 40000 });
  const taxa = await item(c, { kind: 'TAXA_MAQUINA', name: '10X', rateBps: 1000 });
  const st = ok(await c.get('/api/v1/quotes/settings'));
  ok(await c.req('PATCH', '/api/v1/quotes/settings', { version: st.version, taxRateBps: 600 }));
  ok(await send(c, 'POST', '/api/v1/office/hire', { roleKey: 'ORCAMENTOS' }), 201);
  const plan = (over: Partial<QuotePlan> = {}): QuotePlan => ({
    service: 'Reforma de Sofá',
    fabricChange: true,
    foamChange: true,
    sofaCount: 1,
    items: [
      { catalogItemId: linho.id, qty: 9 },
      { catalogItemId: d33.id, qty: 3, heightCm: 10, widthCm: 60, lengthCm: 60 },
      // Ids de fora da tabela e de tipo errado são ignorados.
      { catalogItemId: rota.id, qty: 1 },
      { catalogItemId: '00000000-0000-4000-8000-000000000000', qty: 2 },
    ],
    logisticsId: rota.id,
    upholsteryServiceId: sofa.id,
    helperServiceId: null,
    profitReais: 500,
    deliveryDays: 15,
    feeId: taxa.id,
    summary: 'Sofá 3 lugares: 9 m de linho e 3 assentos em D33; lucro como nos últimos.',
    questions: ['Qual a cor do linho?'],
    ...over,
  });
  return { s, c, plan, linho, rota };
}

const ask = (c: Client, body: Record<string, unknown> = {}) =>
  send(c, 'POST', '/api/v1/office/quote', {
    customerName: 'Mariana Lopes',
    phone: '(12) 99111-0001',
    city: 'Jacareí',
    request: 'Sofá 3 lugares, trocar o tecido por linho e a espuma do assento.',
    ...body,
  });

describe('Orçamento pelo pedido', () => {
  it('monta com a tabela, mostra o valor e, ao aprovar, salva e manda o link no WhatsApp', async () => {
    const { c, plan } = await setup();
    let seen = '';
    setQuotePlanner(async (i) => {
      seen = i.catalog.map((x) => x.name).join(',');
      return plan();
    });
    const r = ok(await ask(c), 201);
    expect(seen).toContain('Linho');
    expect(r.doneAlone).toBe(false);
    const p = (await overview(c)).pending.find((x) => x.task === 'MONTAR_ORCAMENTO')!;
    // 9×35 + 3×0,036×1380 + 80 + 400 = 944,04 de custo; +500 de lucro; 6% embutido → 1537.
    expect(p.payload.totalCents).toBe(153_700);
    expect(p.title).toMatch(/Mariana Lopes/);
    expect((p.payload.draft as { items: unknown[] }).items).toHaveLength(2);
    expect(p.payload.questions).toEqual(['Qual a cor do linho?']);
    expect(p.detail).toMatch(/\{link\}/);
    expect(p.detail).toMatch(/10x de/);

    const d = ok(
      await send(c, 'POST', `/api/v1/game/proposals/${p.id}/decide`, { decision: 'APROVAR' }),
    );
    expect(d.payload.sent).toBe(false);
    const msg = decodeURIComponent(String(d.payload.href));
    expect(msg).toMatch(/\/proposta\//);
    expect(msg).not.toMatch(/\{link\}/);
    const q = await db().quote.findUniqueOrThrow({ where: { id: String(d.payload.quoteId) } });
    expect(q.customerName).toBe('Mariana Lopes');
    expect(q.totalCents).toBe(153_700);
    expect(q.status).toBe('ENVIADO');
  });

  it('preço faltando: o pedido fica, mas aprovar é recusado até completar', async () => {
    const { c, plan } = await setup();
    setQuotePlanner(async () => plan({ helperServiceId: null, profitReais: 0 }));
    const st = ok(await c.get('/api/v1/quotes/settings'));
    ok(await c.req('PATCH', '/api/v1/quotes/settings', { version: st.version, taxRateBps: null }));
    ok(await ask(c), 201);
    const p = (await overview(c)).pending.find((x) => x.task === 'MONTAR_ORCAMENTO')!;
    expect(p.payload.blocker).toMatch(/preços pendentes/);
    const r = await send(c, 'POST', `/api/v1/game/proposals/${p.id}/decide`, {
      decision: 'APROVAR',
    });
    expect(r.status).toBe(422);
    expect(await db().quote.count()).toBe(0);
  });

  it('sem o agente de Orçamentos, sem tabela ou sem nome: recusa', async () => {
    const s = await k.scenario();
    setQuotePlanner(async () => {
      throw new Error('não deveria chamar');
    });
    expect((await ask(s.admin)).status).toBe(409);
    ok(await send(s.admin, 'POST', '/api/v1/office/hire', { roleKey: 'ORCAMENTOS' }), 201);
    expect((await ask(s.admin)).status).toBe(422);
    expect((await ask(s.admin, { customerName: '' })).status).toBe(400);
  });
});
