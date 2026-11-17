const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const day = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'America/Sao_Paulo' });

export const formatCents = (cents: number) => brl.format(cents / 100);
export const formatDay = (iso: string | null | undefined) =>
  iso ? day.format(new Date(iso)) : '—';
/** Dias inteiros que faltam até a data (0 = hoje). */
export function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}
