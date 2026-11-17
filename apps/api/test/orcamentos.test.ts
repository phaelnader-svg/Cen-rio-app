import { emptyQuoteDraft, type QuoteCatalogItemDto, type QuoteDraft } from '@cenario/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { panelUserWith } from './commercial-helpers';
import {
  type Client,
  createTestApp,
  db,
  idemKey,
  loginAdmin,
  rawDb,
  resetDatabase,
} from './helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/**
 * Módulo Orçamentos: base de dados própria, cálculo refeito pela API ao salvar (com os preços
 * atuais), numeração a partir de 10200, cópia imutável da proposta, O.S. do orçamento e permissões.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => app.close());
beforeEach(async () => resetDatabase());

const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const post = (c: Client, url: string, body: unknown = {}) =>
  c.req('POST', url, body, { 'idempotency-key': idemKey() });

async function addItem(c: Client, body: Record<string, unknown>) {
  const list = ok<QuoteCatalogItemDto[]>(await post(c, '/api/v1/quotes/catalog', body), 201);
  return list.filter((x) => x.kind === body.kind && x.name === body.name).at(-1)!;
}

async function baseCatalog(c: Client) {
  const linho = await addItem(c, {
    kind: 'MATERIAL',
    category: 'Tecidos',
    name: 'Linho',
    priceCents: 3500,
    unit: 'm',
  });
  const d33 = await addItem(c, {
    kind: 'MATERIAL',
    category: 'Espumas',
    name: 'D33',
    priceCents: 138000,
    unit: 'm³',
  });
  const cola = await addItem(c, {
    kind: 'MATERIAL',
    category: 'Insumos',
    name: 'Cola',
    unit: 'un',
  });
  const rota = await addItem(c, { kind: 'LOGISTICA', name: 'Jacareí', km: 30, priceCents: 8000 });
  const sofa = await addItem(c, {
    kind: 'MAO_TAPECEIRO',
    name: 'Sofá reto - 3 lugares',
    priceCents: 40000,
  });
  const taxa = await addItem(c, { kind: 'TAXA_MAQUINA', name: '10X', rateBps: 1000 });
  const tap = await addItem(c, { kind: 'TAPECEIRO', name: 'João', phone: '(12) 99999-0000' });
  const catalog = ok<QuoteCatalogItemDto[]>(await c.get('/api/v1/quotes/catalog'));
  const ajudante = catalog.find((x) => x.kind === 'MAO_AJUDANTE' && x.linkedItemId === sofa.id)!;
  return { linho, d33, cola, rota, sofa, taxa, tap, ajudante };
}

function draft(over: Partial<QuoteDraft> = {}): QuoteDraft {
  return { ...emptyQuoteDraft(), customerName: 'Maria Silva', service: 'Reforma de Sofá', ...over };
}

describe('Orçamentos', () => {
  it('serviço do tapeceiro cria o do ajudante, renomeia junto e exclui junto', async () => {
    const admin = await loginAdmin(app);
    const { sofa, ajudante } = await baseCatalog(admin);
    expect(ajudante).toMatchObject({ name: 'Sofá reto - 3 lugares', priceCents: null });
    ok(await admin.req('PATCH', `/api/v1/quotes/catalog/${ajudante.id}`, { priceCents: 12000 }));
    let list = ok<QuoteCatalogItemDto[]>(
      await admin.req('PATCH', `/api/v1/quotes/catalog/${sofa.id}`, { name: 'Sofá 3L' }),
    );
    expect(list.find((x) => x.id === ajudante.id)).toMatchObject({
      name: 'Sofá 3L',
      priceCents: 12000,
    });
    list = ok(await post(admin, `/api/v1/quotes/catalog/${sofa.id}/delete`));
    expect(list.some((x) => x.id === ajudante.id)).toBe(false);
  });

  it('calcula como o modelo, recusa preço pendente e numera a partir de 10200', async () => {
    const admin = await loginAdmin(app);
    const c = await baseCatalog(admin);
    ok(await admin.req('PATCH', `/api/v1/quotes/catalog/${c.ajudante.id}`, { priceCents: 10000 }));
    const base = draft({
      fabricChange: true,
      foamChange: true,
      items: [
        { id: 'a', catalogItemId: c.linho.id, qty: 10, heightCm: 0, widthCm: 0, lengthCm: 0 },
        // 10 × 50 × 200 cm × 2 peças = 0,2 m³ × R$ 1.380 = R$ 276
        { id: 'b', catalogItemId: c.d33.id, qty: 2, heightCm: 10, widthCm: 50, lengthCm: 200 },
      ],
      logisticsId: c.rota.id,
      upholsteryServiceId: c.sofa.id,
      helperServiceId: c.ajudante.id,
      sofaCount: 2,
      profitCents: 50000,
      feeId: c.taxa.id,
    });

    // Sem alíquota cadastrada o total é provisório: não salva.
    let r = await post(admin, '/api/v1/quotes', base);
    expect(r.status).toBe(422);
    const s = ok(await admin.get('/api/v1/quotes/settings'));
    ok(
      await admin.req('PATCH', '/api/v1/quotes/settings', { version: s.version, taxRateBps: 600 }),
    );

    // Material sem preço (Cola) também bloqueia.
    r = await post(admin, '/api/v1/quotes', {
      ...base,
      items: [
        ...base.items,
        { id: 'c', catalogItemId: c.cola.id, qty: 1, heightCm: 0, widthCm: 0, lengthCm: 0 },
      ],
    });
    expect(r.status).toBe(422);

    const q = ok(await post(admin, '/api/v1/quotes', base), 201);
    // custo = 350 + 276 + 80 + (400 + 100) × 2 = 1706; + lucro 500 = 2206; ÷ 0,94 = 2346,8 → 2347
    expect(q.number).toBe(10200);
    expect(q.snapshot.totals).toMatchObject({
      materialsCents: 62600,
      logisticsCents: 8000,
      laborCents: 100000,
      costCents: 170600,
      totalCents: 234700,
      installmentTotalCents: Math.round((2347 / 0.9) * 100),
    });
    expect(q.snapshot.fee).toMatchObject({ name: '10X', installments: 10 });
    expect(q.snapshot.fabrics).toEqual(['Linho']);

    // Sem troca de tecido, o tecido sai do cálculo e da proposta.
    const q2 = ok(await post(admin, '/api/v1/quotes', { ...base, fabricChange: false }), 201);
    expect(q2.number).toBe(10201);
    expect(q2.snapshot.fabrics).toEqual([]);
    expect(q2.snapshot.totals.materialsCents).toBe(27600);

    // A proposta salva é uma cópia: mudar preço depois não altera.
    ok(await admin.req('PATCH', `/api/v1/quotes/catalog/${c.linho.id}`, { priceCents: 9900 }));
    const again = ok(await admin.get(`/api/v1/quotes/${q.id}`));
    expect(again.snapshot.totals.totalCents).toBe(234700);
  });

  // Produção 2026-11-17: os itens que vieram prontos na base (migration 20270413) têm id gerado por
  // md5(...)::uuid, que não segue o formato de versão do UUID. A validação estrita recusava esses ids
  // com "Identificador inválido." ao alterar o preço. Os ids precisam ser aceitos em todas as rotas.
  it('itens que vieram prontos na base (id md5) aceitam alterar preço e entram no orçamento', async () => {
    const admin = await loginAdmin(app);
    const c = await baseCatalog(admin);
    const rows = await rawDb().$queryRaw<{ id: string }[]>`
      UPDATE quote_catalog_items SET id = md5('orcamento:MATERIAL:11')::uuid
      WHERE id = ${c.cola.id}::uuid RETURNING id::text`;
    const seedId = rows[0]!.id;
    // Fora do formato estrito (variante 8–b no 4º bloco): era exatamente o que a validação recusava.
    expect(seedId).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab]/);

    const list = ok<QuoteCatalogItemDto[]>(
      await admin.req('PATCH', `/api/v1/quotes/catalog/${seedId}`, { priceCents: 2000 }),
    );
    expect(list.find((x) => x.id === seedId)).toMatchObject({ name: 'Cola', priceCents: 2000 });

    const s = ok(await admin.get('/api/v1/quotes/settings'));
    ok(
      await admin.req('PATCH', '/api/v1/quotes/settings', { version: s.version, taxRateBps: 600 }),
    );
    const q = ok(
      await post(
        admin,
        '/api/v1/quotes',
        draft({
          items: [{ id: 'a', catalogItemId: seedId, qty: 2, heightCm: 0, widthCm: 0, lengthCm: 0 }],
        }),
      ),
      201,
    );
    expect(q.snapshot.totals.materialsCents).toBe(4000);

    ok(await post(admin, `/api/v1/quotes/catalog/${seedId}/delete`));
    const after = ok<QuoteCatalogItemDto[]>(await admin.get('/api/v1/quotes/catalog'));
    expect(after.some((x) => x.id === seedId)).toBe(false);
  });

  it('a empresa escolhe o número do próximo orçamento (nunca abaixo de um já usado)', async () => {
    const admin = await loginAdmin(app);
    const c = await baseCatalog(admin);
    let s = ok(await admin.get('/api/v1/quotes/settings'));
    expect(s.nextNumber).toBe(10200);
    s = ok(
      await admin.req('PATCH', '/api/v1/quotes/settings', {
        version: s.version,
        taxRateBps: 600,
        nextNumber: 8937,
      }),
    );
    expect(s.nextNumber).toBe(8937);
    const linhoDraft = draft({
      items: [{ id: 'a', catalogItemId: c.linho.id, qty: 1, heightCm: 0, widthCm: 0, lengthCm: 0 }],
    });
    expect(ok(await post(admin, '/api/v1/quotes', linhoDraft), 201).number).toBe(8937);
    expect(ok(await post(admin, '/api/v1/quotes', linhoDraft), 201).number).toBe(8938);
    s = ok(await admin.get('/api/v1/quotes/settings'));
    expect(s.nextNumber).toBe(8939);

    // Não pode voltar para um número já usado (o número é único na empresa).
    const r = await admin.req('PATCH', '/api/v1/quotes/settings', {
      version: s.version,
      nextNumber: 8938,
    });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain('8938');

    // Adiantar continua possível.
    s = ok(
      await admin.req('PATCH', '/api/v1/quotes/settings', { version: s.version, nextNumber: 9500 }),
    );
    expect(ok(await post(admin, '/api/v1/quotes', linhoDraft), 201).number).toBe(9500);
  });

  it('O.S. exige tapeceiro responsável; excluir esconde o orçamento', async () => {
    const admin = await loginAdmin(app);
    const c = await baseCatalog(admin);
    const s = ok(await admin.get('/api/v1/quotes/settings'));
    ok(await admin.req('PATCH', '/api/v1/quotes/settings', { version: s.version, taxRateBps: 0 }));
    const q = ok(
      await post(admin, '/api/v1/quotes', draft({ upholsteryServiceId: c.sofa.id })),
      201,
    );
    const wo = {
      date: '2026-11-16',
      upholsteryCents: 40000,
      responsibleId: c.tap.id,
      fabricName: 'Linho bege',
      fabricMeters: 12.5,
      keepOriginal: 'Sim',
      changeFoam: 'Não',
      changeFabric: 'Sim',
      repairStructure: 'Avaliar',
      notes: '',
      photoDataUrl: 'data:image/jpeg;base64,AAAA',
      items: [],
    };
    const bad = await admin.req('PUT', `/api/v1/quotes/${q.id}/work-order`, {
      version: q.version,
      workOrder: { ...wo, responsibleId: c.linho.id },
    });
    expect(bad.status).toBe(422);
    const saved = ok(
      await admin.req('PUT', `/api/v1/quotes/${q.id}/work-order`, {
        version: q.version,
        workOrder: wo,
      }),
    );
    expect(saved.workOrder).toMatchObject({ responsibleName: 'João', fabricMeters: 12.5 });
    expect(ok<J[]>(await admin.get('/api/v1/quotes'))[0].hasWorkOrder).toBe(true);

    ok(await post(admin, `/api/v1/quotes/${q.id}/delete`));
    expect(ok<J[]>(await admin.get('/api/v1/quotes'))).toHaveLength(0);
    expect((await admin.get(`/api/v1/quotes/${q.id}`)).status).toBe(404);
    expect(await db().quote.count()).toBe(1);
  });

  it('backup exporta e importa a base (com vínculo do ajudante)', async () => {
    const admin = await loginAdmin(app);
    await baseCatalog(admin);
    const backup = ok(await admin.get('/api/v1/quotes/catalog/export'));
    const list = ok<QuoteCatalogItemDto[]>(
      await post(admin, '/api/v1/quotes/catalog/import', backup),
    );
    expect(list).toHaveLength(backup.items.length);
    const sofa = list.find((x) => x.kind === 'MAO_TAPECEIRO')!;
    expect(list.find((x) => x.kind === 'MAO_AJUDANTE')?.linkedItemId).toBe(sofa.id);
  });

  it('quem só vê não altera; quem não tem permissão não vê', async () => {
    const admin = await loginAdmin(app);
    const viewer = await panelUserWith(app, admin, 'orc-ver', ['orcamentos.ver']);
    expect((await viewer.get('/api/v1/quotes')).status).toBe(200);
    expect((await post(viewer, '/api/v1/quotes', draft())).status).toBe(403);
    expect(
      (await post(viewer, '/api/v1/quotes/catalog', { kind: 'TAPECEIRO', name: 'X' })).status,
    ).toBe(403);
    const other = await panelUserWith(app, admin, 'orc-nada', ['clientes.ver']);
    expect((await other.get('/api/v1/quotes')).status).toBe(403);
    expect((await other.get('/api/v1/quotes/catalog')).status).toBe(403);
  });
});
