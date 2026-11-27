/**
 * Item 28 da lista de 53: calculadora grátis de preço de reforma (página pública /calculadora).
 * O preço é montado como no orçamento do sistema: mão de obra + material + frete, e em cima disso
 * o lucro e a taxa da maquininha (quando o cliente paga no cartão), os dois sobre o preço final.
 */

export interface CalcPiece {
  key: string;
  label: string;
  /** Horas de trabalho de uma peça, só como ponto de partida (o tapeceiro ajusta). */
  hours: number;
}

export const CALC_PIECES: CalcPiece[] = [
  { key: 'sofa3', label: 'Sofá 3 lugares', hours: 14 },
  { key: 'sofa2', label: 'Sofá 2 lugares', hours: 11 },
  { key: 'poltrona', label: 'Poltrona', hours: 6 },
  { key: 'cadeira', label: 'Cadeira', hours: 1.5 },
  { key: 'cabeceira', label: 'Cabeceira', hours: 4 },
  { key: 'puff', label: 'Puff', hours: 2 },
  { key: 'banco', label: 'Banco de carro', hours: 3 },
  { key: 'outra', label: 'Outra peça', hours: 4 },
];

export interface CalcInput {
  quantity: number;
  hoursEach: number;
  hourCents: number;
  materialCents: number;
  freightCents: number;
  profitPct: number;
  card: boolean;
  cardPct: number;
}

export interface CalcResult {
  laborCents: number;
  costCents: number;
  profitCents: number;
  cardCents: number;
  priceCents: number;
  /** Lucro + taxa passam de 90% do preço: a conta não fecha. */
  invalid: boolean;
}

const pos = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

export function calcPrice(i: CalcInput): CalcResult {
  const qty = Math.max(1, Math.round(pos(i.quantity)) || 1);
  const laborCents = Math.round(qty * pos(i.hoursEach) * pos(i.hourCents));
  const costCents = laborCents + Math.round(pos(i.materialCents)) + Math.round(pos(i.freightCents));
  const profit = Math.min(pos(i.profitPct), 100) / 100;
  const card = i.card ? Math.min(pos(i.cardPct), 100) / 100 : 0;
  const share = profit + card;
  if (share >= 0.9)
    return { laborCents, costCents, profitCents: 0, cardCents: 0, priceCents: 0, invalid: true };
  // Arredonda para cima, de R$ 10 em R$ 10, como se faz no balcão.
  const priceCents = Math.ceil(costCents / (1 - share) / 1000) * 1000;
  const cardCents = Math.round(priceCents * card);
  return {
    laborCents,
    costCents,
    profitCents: priceCents - costCents - cardCents,
    cardCents,
    priceCents,
    invalid: false,
  };
}
