/**
 * Item 45 (2026-11-27): de onde veio quem cria a conta. Na primeira visita o site guarda a origem
 * (link com ?origem=, ?indicacao=, utm_source, anúncio do Google/Facebook ou o blog) e o Criar conta
 * e a demonstração mandam junto. Sem acesso ao armazenamento do navegador, vale só nesta visita.
 */
const KEY = 'cenario:origem';
let memory: string | null = null;

function fromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const q = new URLSearchParams(window.location.search);
  const origem = q.get('origem');
  if (origem) return origem.slice(0, 200);
  const ind = q.get('indicacao');
  if (ind) return `indicacao:${ind}`.slice(0, 200);
  if (q.get('gclid')) return 'anuncio:google';
  if (q.get('fbclid')) return 'anuncio:facebook';
  const utm = q.get('utm_source');
  if (utm) {
    const camp = q.get('utm_campaign') || q.get('utm_content');
    if (utm === 'blog') return `blog${camp ? `:${camp}` : ''}`.slice(0, 200);
    return `${utm}${camp ? `:${camp}` : ''}`.slice(0, 200);
  }
  if (window.location.pathname.startsWith('/blog')) {
    const slug = window.location.pathname.split('/')[2];
    return slug ? `blog:${slug}` : 'blog';
  }
  return null;
}

/** Guarda a origem da primeira visita (a que trouxe a pessoa). */
export function rememberOrigin() {
  const now = fromUrl();
  try {
    if (!window.localStorage.getItem(KEY) && now) window.localStorage.setItem(KEY, now);
  } catch {
    /* só nesta visita */
  }
  if (!memory && now) memory = now;
}

export function currentOrigin(): string | null {
  try {
    return window.localStorage.getItem(KEY) ?? memory ?? fromUrl();
  } catch {
    return memory ?? fromUrl();
  }
}
