import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OfficeMaterialPricesDto, OfficeOverviewDto } from '@cenario/shared';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { type ReceiptReading, setReceiptReader } from '../src/modules/game/office-receipt';
import { type Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { openServiceOrder } from './measurement-helpers';

/**
 * Preço dos materiais (Escritório, 2026-11-25): a nota da compra lida pela foto guarda o preço de
 * cada material; o Orçamentos propõe atualizar a tabela quando o material subiu e o Compras mostra
 * no pedido quem cobrou menos da última vez.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  setClock(() => new Date('2026-11-25T15:00:00Z'));
  await db().companySettings.update({ where: { id: 1 }, data: { plan: 'gestao_jogo' } });
});
afterEach(() => setReceiptReader(null));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const send = (c: Client, method: 'POST' | 'PUT', url: string, body: unknown) =>
  c.req(method, url, body, { 'idempotency-key': idemKey() });
const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const sp = (s: string) => s.replace(/\u00a0/g, ' ');
const overview = (c: Client) => c.get('/api/v1/office').then((r) => ok<OfficeOverviewDto>(r));
const round = (c: Client) => send(c, 'POST', '/api/v1/office/round', {}).then((r) => ok(r));

const nota = (
  beneficiary: string,
  date: string,
  items: ReceiptReading['items'],
): ReceiptReading => ({
  ok: true,
  amountCents: items!.reduce((a, i) => a + i.unitPriceCents * (i.quantity ?? 1), 0),
  date,
  beneficiary,
  description: 'Material da oficina',
  category: 'MATERIAL',
  paid: true,
  method: 'PIX',
  items,
  problem: null,
});

async function photo(c: Client) {
  const boundary = '----nota';
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="nota.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.app.inject({
    method: 'POST',
    url: '/api/v1/office/receipt',
    headers: {
      origin: 'http://localhost:3000',
      cookie: c.cookieHeader,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
  expect(res.statusCode, res.body).toBe(201);
}

async function launch(c: Client, r: ReceiptReading) {
  setReceiptReader(async () => r);
  await photo(c);
  const p = (await overview(c)).pending.find((x) => x.task === 'LANCAR_DESPESA')!;
  const d = ok(
    await send(c, 'POST', `/api/v1/game/proposals/${p.id}/decide`, { decision: 'APROVAR' }),
  );
  return d.payload;
}

describe('Preço dos materiais', () => {
  it('a nota guarda o preço; Orçamentos propõe subir a tabela e Compras compara fornecedores', async () => {
    const admin = await loginAdmin(app);
    for (const roleKey of ['FINANCEIRO', 'ORCAMENTOS', 'COMPRAS'])
      ok(await send(admin, 'POST', '/api/v1/office/hire', { roleKey }), 201);
    const linho = await db().quoteCatalogItem.create({
      data: { kind: 'MATERIAL', category: 'Tecidos', name: 'Linho', priceCents: 3500, unit: 'm' },
    });

    // Duas compras do linho, em fornecedores diferentes.
    await launch(
      admin,
      nota('CASA DO ESTOFADOR LTDA', '2026-11-10', [
        { description: 'Tecido linho bege', quantity: 10, unit: 'metros', unitPriceCents: 3600 },
      ]),
    );
    const last = await launch(
      admin,
      nota('Tecidos Vale', '2026-11-24', [
        { description: 'TECIDO LINHO CRU 1,40', quantity: 12, unit: 'm', unitPriceCents: 3900 },
        { description: 'Cola de contato', quantity: 1, unit: 'l', unitPriceCents: 5500 },
      ]),
    );
    expect(last.pricesSaved).toBe(2);
    const rows = await db().materialPrice.findMany({ orderBy: { purchasedOn: 'asc' } });
    expect(rows.map((r) => r.catalogItemId)).toEqual([linho.id, linho.id, null]);

    // Comparação: o linho com os dois fornecedores, o mais barato primeiro.
    const prices = ok<OfficeMaterialPricesDto>(await admin.get('/api/v1/office/material-prices'));
    expect(prices.materials[0]).toMatchObject({
      name: 'Linho',
      unit: 'm',
      suppliers: [
        { supplierName: 'CASA DO ESTOFADOR LTDA', unitPriceCents: 3600 },
        { supplierName: 'Tecidos Vale', unitPriceCents: 3900 },
      ],
    });

    // O pedido ao fornecedor mostra quem cobrou menos.
    const so = await openServiceOrder(admin, 'Cliente Preço');
    ok(
      await send(admin, 'POST', `/api/v1/service-orders/${so.id}/material-list`, {
        description: 'Linho bege',
        quantity: 8,
        unit: 'm',
      }),
      201,
    );
    ok(
      await send(admin, 'POST', '/api/v1/game/suppliers', {
        name: 'Tecidos Vale',
        phone: '(12) 99999-0001',
        categories: ['TECIDO'],
      }),
      201,
    );

    await round(admin);
    const pending = (await overview(admin)).pending;
    const order = pending.find((x) => x.task === 'PEDIR_FORNECEDOR')!;
    expect((order.payload.cheaperElsewhere as string[]).map(sp)).toEqual([
      'Linho bege: na CASA DO ESTOFADOR LTDA saiu R$ 36,00 o metro e na Tecidos Vale R$ 39,00.',
    ]);

    // Subiu 11% sobre a tabela (R$ 35): propõe, e aprovar com outro valor muda a tabela.
    const adj = pending.find((x) => x.task === 'AJUSTAR_TABELA')!;
    expect(sp(adj.title)).toBe('Linho subiu 11%: atualizar a tabela para R$ 39,00 o metro');
    expect(adj.detail).toMatch(/Tecidos Vale, 24\/11\/2026/);
    const d = ok(
      await send(admin, 'POST', `/api/v1/game/proposals/${adj.id}/decide`, {
        decision: 'APROVAR',
        edits: { priceCents: 3800 },
      }),
    );
    expect(d.status).toBe('APROVADA');
    expect(
      (await db().quoteCatalogItem.findUniqueOrThrow({ where: { id: linho.id } })).priceCents,
    ).toBe(3800);

    // Mudar preço sempre pede: o nível não passa de 2.
    const orc = (await overview(admin)).agents.find((a) => a.roleKey === 'ORCAMENTOS')!;
    const t = orc.tasks.find((x) => x.key === 'AJUSTAR_TABELA')!;
    expect(t.maxLevel).toBe(2);
  });
});
