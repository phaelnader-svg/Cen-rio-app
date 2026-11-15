/** Painel oficial do Cenário Gestão (OS, compras, recebimento) — abre em outra aba. */
export const CENARIO_WEB_URL = (
  process.env.NEXT_PUBLIC_CENARIO_WEB_URL ?? 'http://localhost:3000'
).replace(/\/$/, '');
export const cenarioUrl = (path: string) => `${CENARIO_WEB_URL}${path}`;
