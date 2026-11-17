/**
 * Plural em português sem o "(s)" no fim das palavras (melhoria 133).
 * plural(1, 'peça', 'peças') → "1 peça"; plural(3, 'peça', 'peças') → "3 peças".
 * Com `zero`, o zero vira a frase dada: plural(0, 'pendência', 'pendências', 'Nenhuma pendência').
 */
export function plural(n: number, one: string, many: string, zero?: string): string {
  if (n === 0 && zero !== undefined) return zero;
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;
}

/** Só a palavra, para quando o número já aparece em outro lugar. */
export function pluralWord(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
