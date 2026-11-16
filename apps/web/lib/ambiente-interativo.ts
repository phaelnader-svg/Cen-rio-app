/** Endereço público padrão do Firma Viva (o "ambiente interativo" do Cenário Gestão). */
export const FIRMA_WEB_URL_PADRAO = 'https://firmaviva.com.br';

/** Caminho do Cenário que abre o jogo já conectado (redireciona para o Firma Viva). */
export const AMBIENTE_INTERATIVO_PATH = '/ambiente-interativo';

/**
 * Entrada do Firma Viva com a conta do Cenário Gestão. Só aceita https (ou http em localhost,
 * para desenvolvimento); qualquer outro valor cai no endereço padrão.
 */
export function firmaEntryUrl(env: Record<string, string | undefined>): string {
  const raw = (env.FIRMA_WEB_URL ?? '').trim();
  let base = FIRMA_WEB_URL_PADRAO;
  try {
    const u = new URL(raw);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) base = u.origin;
  } catch {
    // vazio ou inválido: endereço padrão
  }
  return `${base}/api/entrar/cenario`;
}
