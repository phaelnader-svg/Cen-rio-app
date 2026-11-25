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
  /** Mensalidade em reais (ex.: '490,00') do plano Cenário Gestão. */
  monthlyPrice: '399,00' as string | null,
  /** Melhoria 70: mensalidade do plano com o Firma Viva (definida pelo proprietário em 2026-11-17). */
  gameMonthlyPrice: '599,00' as string | null,
  /** Dias de teste grátis de uma conta nova (definido pelo proprietário em 2026-11-17). */
  trialDays: 7 as number | null,
  /** Desconto do plano anual, em %, definido pelo proprietário (2026-10-25). */
  annualDiscountPct: 15 as number | null,
  /** WhatsApp só com dígitos, com DDI e DDD (ex.: '5511999999999'). */
  whatsappNumber: '5512996520615' as string | null,
  whatsappMessage: 'Olá! Quero conhecer o Cenário Gestão.',
  /** Como funciona a implantação. Sem texto definido, o bloco não aparece em produção. */
  onboarding: null as string | null,
  /** Respostas do FAQ que dependem de decisão comercial. */
  usersAnswer:
    'Sem limite. Cada funcionário tem o próprio acesso, e os tablets da oficina não custam nada a mais.' as
      | string
      | null,
  dataAnswer:
    'Num servidor do Google Cloud em São Paulo, separados dos dados de qualquer outra empresa, com cópia de segurança todos os dias, guardada por 30 dias.' as
      | string
      | null,
  /** ID do Google Analytics (G-XXXXXXX). Vazio: nenhuma medição e nenhum script externo. */
  analyticsId: null as string | null,
};

/** As quatro telas do sistema, capturadas com dados de exemplo (clientes, equipe e valores fictícios). */
export const SCREENS = {
  inicio: {
    key: 'inicio',
    title: 'O que precisa de você hoje, no início do painel',
    src: '/site/inicio.webp',
    width: 1440,
    height: 900,
  },
  producao: {
    key: 'producao',
    title: 'Semana da oficina: o que está em produção e com quem',
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
    title: 'Quanto entrou, quanto saiu e quanto sobrou no mês',
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

/** Tela de entrar já aberta no Criar conta (botões da landing e anúncios). */
export const SIGNUP_PATH = '/entrar?criar=1';

/** Endereço público principal (as duas rotas da landing apontam para ele). */
export const SITE_URL = 'https://cenariogestao.com.br';

export type SiteMode = 'off' | 'preview' | 'live';

/** Título e descrição da landing (usados em / e em /conheca). */
export const SITE_META = {
  title: 'Cenário Gestão · Sistema de gestão para tapeçarias',
  description:
    'O Cenário Gestão nasceu dentro da Cenário Estofados para organizar a nossa própria operação. Do pedido à entrega, no escritório e no tablet da oficina.',
};

/**
 * Metadados da landing nas duas rotas (/ e /conheca): endereço principal único (evita conteúdo
 * duplicado no Google) e a prévia com imagem quando o link é compartilhado no WhatsApp.
 */
export function siteMetadata(live: boolean) {
  return {
    metadataBase: new URL(SITE_URL),
    title: { absolute: SITE_META.title },
    description: SITE_META.description,
    alternates: { canonical: '/' },
    openGraph: {
      type: 'website' as const,
      locale: 'pt_BR',
      url: '/',
      siteName: 'Cenário Gestão',
      title: SITE_META.title,
      description: SITE_META.description,
      images: [{ url: '/site/og.png', width: 1200, height: 630, alt: 'Painel do Cenário Gestão' }],
    },
    // Só a landing publicada é indexável; o resto do sistema segue com noindex (layout raiz).
    robots: live ? { index: true, follow: true } : { index: false, follow: false },
  };
}

export function siteMode(
  env: Record<string, string | undefined> = process.env,
  pending: string[] = pendingItems(),
): SiteMode {
  if (env.NODE_ENV !== 'production') return 'preview';
  return env.SITE_COMERCIAL === '1' && pending.length === 0 ? 'live' : 'off';
}

const brl = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Frase do plano anual, calculada a partir da mensalidade e do desconto (nunca digitada à mão). */
export function annualOffer(
  site: typeof SITE = SITE,
  monthly: string | null = site.monthlyPrice,
): string | null {
  if (!monthly || !site.annualDiscountPct) return null;
  const monthlyCents = Math.round(Number(monthly.replace(/\./g, '').replace(',', '.')) * 100);
  if (!Number.isFinite(monthlyCents) || monthlyCents <= 0) return null;
  const discounted = Math.round((monthlyCents * (100 - site.annualDiscountPct)) / 100);
  // Melhoria 145: uma linha curta, com quanto se economiza no ano.
  return `No anual, R$ ${brl(discounted)} por mês (R$ ${brl((monthlyCents - discounted) * 12)} a menos no ano).`;
}

/** De onde a pessoa veio quando chama no WhatsApp (o blog marca a mensagem pronta). */
export interface WhatsappOrigem {
  /** Veio do blog (lista ou artigo). */
  blog: true;
  /** Título do artigo, quando veio de um artigo. */
  artigo?: string;
}

/** Mensagem pronta do WhatsApp; quem veio do blog já chega dizendo de qual artigo. */
export function whatsappMessage(site: typeof SITE = SITE, origem?: WhatsappOrigem): string {
  if (!origem?.blog) return site.whatsappMessage;
  return origem.artigo
    ? `Olá! Vim pelo blog, do artigo "${origem.artigo}". Quero conhecer o Cenário Gestão.`
    : 'Olá! Vim pelo blog. Quero conhecer o Cenário Gestão.';
}

export function whatsappUrl(site: typeof SITE = SITE, origem?: WhatsappOrigem): string | null {
  if (!site.whatsappNumber) return null;
  return `https://wa.me/${site.whatsappNumber}?text=${encodeURIComponent(whatsappMessage(site, origem))}`;
}

/** WhatsApp do suporte, usado no painel das empresas clientes (botão Ajuda e suporte). */
export function supportUrl(company: string, site: typeof SITE = SITE): string | null {
  if (!site.whatsappNumber) return null;
  const text = `Olá! Preciso de ajuda com o Cenário Gestão (${company}).`;
  return `https://wa.me/${site.whatsappNumber}?text=${encodeURIComponent(text)}`;
}

/** Frase do teste grátis (só com o número de dias definido). */
export function trialOffer(site: typeof SITE = SITE): string | null {
  return site.trialDays
    ? `${site.trialDays} dias grátis para testar, sem cartão. Depois, escolha o plano.`
    : null;
}
