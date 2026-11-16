/**
 * Feriados nacionais do Brasil, calculados (sem lista anual para manter).
 * Fixos (Lei 662/1949, 6.802/1980, 14.759/2023) + Sexta-feira Santa (Páscoa − 2).
 * Carnaval e Corpus Christi são pontos facultativos nacionais: aparecem marcados,
 * com o nome indicando "ponto facultativo".
 * Datas no formato "AAAA-MM-DD".
 */

export interface Holiday {
  date: string;
  name: string;
  /** Ponto facultativo (não é feriado obrigatório). */
  optional?: boolean;
}

const FIXED: [string, string][] = [
  ['01-01', 'Confraternização Universal'],
  ['04-21', 'Tiradentes'],
  ['05-01', 'Dia do Trabalho'],
  ['09-07', 'Independência do Brasil'],
  ['10-12', 'Nossa Senhora Aparecida'],
  ['11-02', 'Finados'],
  ['11-15', 'Proclamação da República'],
  ['11-20', 'Dia Nacional de Zumbi e da Consciência Negra'],
  ['12-25', 'Natal'],
];

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher), "AAAA-MM-DD". */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const cache = new Map<number, Map<string, Holiday>>();

export function holidaysOfYear(year: number): Map<string, Holiday> {
  const hit = cache.get(year);
  if (hit) return hit;
  const easter = easterSunday(year);
  const list: Holiday[] = [
    ...FIXED.map(([md, name]) => ({ date: `${year}-${md}`, name })),
    { date: shift(easter, -48), name: 'Carnaval (ponto facultativo)', optional: true },
    { date: shift(easter, -47), name: 'Carnaval (ponto facultativo)', optional: true },
    { date: shift(easter, -2), name: 'Sexta-feira Santa' },
    { date: shift(easter, 60), name: 'Corpus Christi (ponto facultativo)', optional: true },
  ];
  const map = new Map(list.map((h) => [h.date, h]));
  cache.set(year, map);
  return map;
}

export function holidayOf(iso: string): Holiday | null {
  return holidaysOfYear(Number(iso.slice(0, 4))).get(iso) ?? null;
}
