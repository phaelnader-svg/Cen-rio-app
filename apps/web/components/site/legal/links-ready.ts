import { legalPending } from '@cenario/shared';

/**
 * Links para as páginas legais (no navegador): só quando elas existem. Em produção, só com os
 * dados da empresa preenchidos; no desenvolvimento e na homologação (teste.), sempre.
 */
export const legalLinksReady = () =>
  process.env.NODE_ENV !== 'production' ||
  legalPending().length === 0 ||
  (typeof window !== 'undefined' && /^teste\./i.test(window.location.hostname));
