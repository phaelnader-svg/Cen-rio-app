import type { Artigo } from './tipos';
import { artigo as exemploFilaDaOficina } from './artigos/exemplo-fila-da-oficina';

export type { Artigo } from './tipos';

/**
 * Todos os artigos do blog. Para publicar um artigo novo: criar o arquivo em ./artigos/ e
 * acrescentar aqui. A ordem não importa (a lista sai do mais novo para o mais antigo).
 */
const TODOS: Artigo[] = [exemploFilaDaOficina];

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Rascunhos só aparecem fora de produção (desenvolvimento e prints). */
export function artigosPublicados(env: Record<string, string | undefined> = process.env): Artigo[] {
  const comRascunho = env.NODE_ENV !== 'production';
  return TODOS.filter((a) => comRascunho || !a.rascunho).sort((a, b) =>
    b.publicadoEm.localeCompare(a.publicadoEm),
  );
}

export function artigoPorSlug(slug: string, env?: Record<string, string | undefined>) {
  return artigosPublicados(env).find((a) => a.slug === slug) ?? null;
}

/** Todos os artigos, com rascunhos (para os testes conferirem o formato). */
export const TODOS_OS_ARTIGOS: readonly Artigo[] = TODOS;
export const slugValido = (s: string) => SLUG.test(s);

/** Minutos de leitura (cerca de 200 palavras por minuto). */
export function minutosDeLeitura(a: Artigo): number {
  const palavras = a.corpo.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(palavras / 200));
}

/** 2026-11-25 → 25 de novembro de 2026 */
export function dataPorExtenso(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const meses = [
    'janeiro',
    'fevereiro',
    'março',
    'abril',
    'maio',
    'junho',
    'julho',
    'agosto',
    'setembro',
    'outubro',
    'novembro',
    'dezembro',
  ];
  return `${d} de ${meses[(m ?? 1) - 1]} de ${y}`;
}

/**
 * Quem chega à página principal por um link do blog (utm_source=blog) chama no WhatsApp já
 * dizendo de onde veio. O título vem da lista de artigos, nunca do endereço.
 */
export function blogOrigemDe(
  q: Record<string, string | string[] | undefined>,
): { slug?: string; titulo?: string } | null {
  if (q.utm_source !== 'blog') return null;
  const slug = typeof q.utm_campaign === 'string' ? q.utm_campaign : undefined;
  const artigo = slug ? artigoPorSlug(slug) : null;
  return artigo ? { slug: artigo.slug, titulo: artigo.titulo } : {};
}
