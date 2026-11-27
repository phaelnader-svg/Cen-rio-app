import { describe, expect, it } from 'vitest';
import { calcPrice } from '../components/site/calculadora/calc';

const base = {
  quantity: 1,
  hoursEach: 10,
  hourCents: 4000,
  materialCents: 60000,
  freightCents: 10000,
  profitPct: 30,
  card: false,
  cardPct: 4,
};

describe('calculadora de preço de reforma', () => {
  it('soma mão de obra, material e frete e põe o lucro sobre o preço final', () => {
    const r = calcPrice(base);
    expect(r.laborCents).toBe(40000);
    expect(r.costCents).toBe(110000);
    // 1100 / 0,70 = 1571,43 → arredonda para R$ 1.580,00
    expect(r.priceCents).toBe(158000);
    expect(r.profitCents).toBe(48000);
    expect(r.cardCents).toBe(0);
  });

  it('com cartão, a taxa da maquininha entra no preço', () => {
    const r = calcPrice({ ...base, card: true });
    // 1100 / 0,66 = 1666,67 → R$ 1.670,00; taxa 4% = R$ 66,80
    expect(r.priceCents).toBe(167000);
    expect(r.cardCents).toBe(6680);
    expect(r.profitCents).toBe(167000 - 110000 - 6680);
  });

  it('multiplica a mão de obra pela quantidade de peças', () => {
    expect(calcPrice({ ...base, quantity: 8, hoursEach: 1.5 }).laborCents).toBe(48000);
  });

  it('não fecha a conta quando lucro e taxa passam de 90%', () => {
    expect(calcPrice({ ...base, profitPct: 95 }).invalid).toBe(true);
  });

  it('ignora valores negativos ou vazios', () => {
    const r = calcPrice({ ...base, materialCents: -5, freightCents: Number.NaN, quantity: 0 });
    expect(r.costCents).toBe(40000);
  });
});
