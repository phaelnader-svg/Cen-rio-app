/**
 * Configuração comercial da landing (/conheca). Tudo o que ainda depende de decisão do
 * proprietário fica aqui, com `null` enquanto estiver pendente — nunca um valor inventado.
 *
 * Regra de ativação (siteMode):
 * - desenvolvimento: a página aparece com os campos pendentes marcados, sem indexação;
 * - produção: só aparece com SITE_COMERCIAL=1 E nenhuma pendência; caso contrário, 404.
 */

export interface ScreenSlot {
  key: string;
  /** O que a tela mostra (vai para a legenda e para o texto alternativo). */
  title: string;
  /** Print real, já desfocado, servido de /public/site. `null` = ainda não fornecido. */
  src: string | null;
  width: number;
  height: number;
}

export const SITE = {
  /** Mensalidade em reais (ex.: '490'). Um único plano. */
  monthlyPrice: null as string | null,
  /** WhatsApp só com dígitos, com DDI e DDD (ex.: '5511999999999'). */
  whatsappNumber: null as string | null,
  whatsappMessage: 'Olá! Quero conhecer o Cenário Gestão.',
  /** Como funciona a implantação. Sem texto definido, o bloco não aparece em produção. */
  onboarding: null as string | null,
  /** Respostas do FAQ que dependem de decisão comercial. */
  usersAnswer: null as string | null,
  dataAnswer: null as string | null,
};

/** As quatro telas reais da operação da Cenário Estofados (prints a fornecer). */
export const SCREENS = {
  inicio: {
    key: 'inicio',
    title: 'Início do painel do gestor',
    src: null,
    width: 1440,
    height: 900,
  },
  producao: {
    key: 'producao',
    title: 'Produção: serviços a planejar e quadro de produção',
    src: null,
    width: 1440,
    height: 900,
  },
  tablet: {
    key: 'tablet',
    title: 'Meu dia do tapeceiro, no tablet da oficina',
    src: null,
    width: 1280,
    height: 800,
  },
  financeiro: {
    key: 'financeiro',
    title: 'Fechamento semanal da mão de obra',
    src: null,
    width: 1440,
    height: 900,
  },
} satisfies Record<string, ScreenSlot>;

/** Itens que impedem a ativação em produção. */
export function pendingItems(
  site: typeof SITE = SITE,
  screens: Record<string, ScreenSlot> = SCREENS,
): string[] {
  const out: string[] = [];
  if (!site.monthlyPrice) out.push('Valor da mensalidade');
  if (!site.whatsappNumber) out.push('Número do WhatsApp');
  for (const s of Object.values(screens)) if (!s.src) out.push(`Print: ${s.title}`);
  return out;
}

export type SiteMode = 'off' | 'preview' | 'live';

export function siteMode(
  env: Record<string, string | undefined> = process.env,
  pending: string[] = pendingItems(),
): SiteMode {
  if (env.NODE_ENV !== 'production') return 'preview';
  return env.SITE_COMERCIAL === '1' && pending.length === 0 ? 'live' : 'off';
}

export function whatsappUrl(site: typeof SITE = SITE): string | null {
  if (!site.whatsappNumber) return null;
  return `https://wa.me/${site.whatsappNumber}?text=${encodeURIComponent(site.whatsappMessage)}`;
}
