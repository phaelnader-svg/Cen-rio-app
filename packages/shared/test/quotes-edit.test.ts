import { describe, expect, it } from 'vitest';
import {
  buildQuoteSnapshot,
  emptyQuoteDraft,
  quoteDraftFromSnapshot,
  quotePromisedDate,
  quoteServiceToPiece,
  type QuoteCatalogItemDto,
} from '../src';

const item = (over: Partial<QuoteCatalogItemDto>): QuoteCatalogItemDto =>
  ({
    id: crypto.randomUUID(),
    kind: 'MATERIAL',
    category: null,
    name: '',
    priceCents: null,
    unit: null,
    km: null,
    rateBps: null,
    phone: null,
    linkedItemId: null,
    position: 1,
    version: 1,
    ...over,
  }) as QuoteCatalogItemDto;

describe('Orçamento salvo reaberto para editar', () => {
  const linho = item({ category: 'Tecidos', name: 'Linho', priceCents: 3500, unit: 'm' });
  const d33 = item({ category: 'Espumas', name: 'D33', priceCents: 138000, unit: 'm³' });
  const rota = item({ kind: 'LOGISTICA', name: 'Jacareí', km: 30, priceCents: 8000 });
  const sofa = item({ kind: 'MAO_TAPECEIRO', name: 'Sofá reto - 3 lugares', priceCents: 40000 });
  const catalog = [linho, d33, rota, sofa];
  const draft = {
    ...emptyQuoteDraft(),
    customerName: 'Maria',
    phone: '(12) 99999-0000',
    city: 'Jacareí',
    service: 'Serviço especial da casa',
    fabricChange: true,
    foamChange: true,
    items: [
      { id: 'a', catalogItemId: linho.id, qty: 10, heightCm: 0, widthCm: 0, lengthCm: 0 },
      { id: 'b', catalogItemId: d33.id, qty: 2, heightCm: 10, widthCm: 50, lengthCm: 200 },
    ],
    logisticsId: rota.id,
    upholsteryServiceId: sofa.id,
    sofaCount: 2,
    profitCents: 50000,
    deliveryDays: 15,
  };

  it('volta ao mesmo rascunho (mesmos cadastros, quantidades e lucro)', () => {
    const snap = buildQuoteSnapshot(
      draft,
      catalog,
      { taxRateBps: 600, companyName: 'X', logoDataUrl: null },
      new Date(),
    );
    const { draft: back, missing } = quoteDraftFromSnapshot(snap, catalog);
    expect(missing).toEqual([]);
    expect(back.items.map((i) => [i.catalogItemId, i.qty, i.heightCm])).toEqual([
      [linho.id, 10, 0],
      [d33.id, 2, 10],
    ]);
    expect(back).toMatchObject({
      customerName: 'Maria',
      service: 'Outro serviço',
      serviceOther: 'Serviço especial da casa',
      logisticsId: rota.id,
      upholsteryServiceId: sofa.id,
      sofaCount: 2,
      profitCents: 50000,
      deliveryDays: 15,
    });
  });

  it('avisa o que não existe mais na base', () => {
    const snap = buildQuoteSnapshot(
      draft,
      catalog,
      { taxRateBps: 600, companyName: 'X', logoDataUrl: null },
      new Date(),
    );
    const { draft: back, missing } = quoteDraftFromSnapshot(snap, [d33, sofa]);
    expect(back.items).toHaveLength(1);
    expect(back.logisticsId).toBeNull();
    expect([...missing].sort()).toEqual(['material "Linho"', 'rota "Jacareí"']);
  });
});

describe('Fechar serviço a partir do orçamento', () => {
  it('deduz a peça e o tipo de serviço', () => {
    expect(quoteServiceToPiece('Reforma de Sofá')).toEqual({
      pieceType: 'SOFA',
      serviceType: 'REFORMA_COMPLETA',
    });
    expect(quoteServiceToPiece('Fabricação de Almofadas')).toEqual({
      pieceType: 'COLCHAO',
      serviceType: 'FABRICACAO',
    });
    expect(quoteServiceToPiece('Reforma de Cadeiras').pieceType).toBe('CADEIRA');
    expect(quoteServiceToPiece('Troca de Espumas').serviceType).toBe('TROCA_DE_ESPUMA');
    expect(quoteServiceToPiece('Higienização de Estofados')).toEqual({
      pieceType: 'OUTRO',
      serviceType: 'OUTRO',
    });
  });

  it('prazo do orçamento vira a data prometida', () => {
    expect(quotePromisedDate(15, '2026-11-17')).toBe('2026-12-02');
    expect(quotePromisedDate(null, '2026-11-17')).toBe('');
  });
});
