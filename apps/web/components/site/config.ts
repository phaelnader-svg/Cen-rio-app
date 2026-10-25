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
  /** Tela real do sistema com dados de exemplo, servida de /public/site. `null` = ainda não fornecida. */
  src: string | null;
  width: number;
  height: number;
}

export const SITE = {
  /** Mensalidade em reais (ex.: '490,00'). Um único plano. */
  monthlyPrice: '399,00' as string | null,
  /**
   * Condição do pagamento anual, definida pelo proprietário (2026-10-25). Sem o percentual
   * decidido, a página só diz que existe; o valor é combinado na conversa.
   */
  annualNote:
    'No pagamento anual a mensalidade sai com desconto. Fale com a gente para ver o valor.' as
      | string
      | null,
  /** WhatsApp só com dígitos, com DDI e DDD (ex.: '5511999999999'). */
  whatsappNumber: null as string | null,
  whatsappMessage: 'Olá! Quero conhecer o Cenário Gestão.',
  /** Como funciona a implantação. Sem texto definido, o bloco não aparece em produção. */
  onboarding: null as string | null,
  /** Respostas do FAQ que dependem de decisão comercial. */
  usersAnswer: null as string | null,
  dataAnswer: null as string | null,
};

/** As quatro telas do sistema, capturadas com dados de exemplo (clientes, equipe e valores fictícios). */
export const SCREENS = {
  inicio: {
    key: 'inicio',
    title: 'Início do painel do gestor',
    src: '/site/inicio.webp',
    width: 1440,
    height: 900,
  },
  producao: {
    key: 'producao',
    title: 'Quadro de produção por funcionário',
    src: '/site/producao.webp',
    width: 1440,
    height: 900,
  },
  tablet: {
    key: 'tablet',
    title: 'Minha semana do tapeceiro, no tablet da oficina',
    src: '/site/tablet.webp',
    width: 1280,
    height: 800,
  },
  financeiro: {
    key: 'financeiro',
    title: 'Custos e resultado por OS',
    src: '/site/financeiro.webp',
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
