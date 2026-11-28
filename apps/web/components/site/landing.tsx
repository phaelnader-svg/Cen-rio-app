import clsx from 'clsx';
import Link from 'next/link';
import { Calculator, ImageOff, LogIn, MessageCircle, UserPlus } from 'lucide-react';
import { BrandMark } from '@/components/brand';
import { jsonLd } from './agentes';
import { artigosPublicados } from './blog/artigos';
import { TopBar } from './top-bar';
import { RememberOrigin } from './remember-origin';
import { WhatsappFloat } from './whatsapp-float';
import { WebMcpTools } from './webmcp';
import { LegalFooter, SiteConsent, SkipLink, type LegalMode } from './legal/legal';
import { Alert, Badge, Card } from '@/components/ui/misc';
import {
  BUTTON_BASE,
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  type ButtonSize,
  type ButtonVariant,
} from '@/components/ui/button-styles';
import {
  PHONE_SCREENS,
  SCREENS,
  SIGNUP_PATH,
  SITE,
  annualOffer,
  trialOffer,
  whatsappUrl,
  type ScreenSlot,
} from './config';

/**
 * Landing comercial (/conheca). Renderizada no servidor, sem sessão e sem chamadas à API: usa só
 * os tokens de globals.css e os componentes do próprio sistema. Os textos descrevem apenas o que
 * existe no código (conferido em out/2026); o que depende de decisão comercial vem de config.ts.
 */

// Melhoria 148: o botão diz o que acontece ao tocar.
const CTA_LABEL = 'Chamar no WhatsApp';

/** Melhoria 145: "399,00" vira "399"; centavos diferentes de zero continuam. */
const shortPrice = (v: string) => v.replace(/,00$/, '');

/** 5512988218472 → (12) 98821-8472. */
export function formatPhone(n: string | null): string {
  const d = (n ?? '').replace(/^55/, '');
  return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d;
}

function Pending({ children }: { children: React.ReactNode }) {
  return (
    <Badge tone="warn" className="align-middle">
      {children}
    </Badge>
  );
}

export function ContactLink({
  variant = 'primary',
  size = 'lg',
  className,
  children = CTA_LABEL,
  href = whatsappUrl(),
  origem,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: React.ReactNode;
  /** Link do WhatsApp (com a mensagem pronta de quem veio do blog, se for o caso). */
  href?: string | null;
  /** Marca de origem para o Analytics (ex.: "blog" ou "blog:nome-do-artigo"). */
  origem?: string;
}) {
  return (
    <a
      href={href ?? '#contato'}
      {...(href ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      {...(origem ? { 'data-origem': origem } : {})}
      className={clsx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
      data-testid="site-cta"
    >
      <MessageCircle className="size-4" aria-hidden />
      {children}
      {href && <span className="sr-only"> (abre o WhatsApp em outra aba)</span>}
    </a>
  );
}

/**
 * Abre a tela de entrar já no modo Criar conta. Ação principal da página (pedido do dono,
 * 26/11/2026): o cadastro pede o WhatsApp, então o contato chega do mesmo jeito.
 */
function SignupLink({
  className,
  size = 'lg',
  children = 'Criar minha conta',
}: {
  className?: string;
  size?: ButtonSize;
  children?: React.ReactNode;
}) {
  return (
    <a
      href={SIGNUP_PATH}
      className={clsx(BUTTON_BASE, BUTTON_VARIANTS.primary, BUTTON_SIZES[size], className)}
      data-testid="site-criar-conta"
    >
      <UserPlus className="size-4" aria-hidden />
      {children}
    </a>
  );
}

/** Entrar, ao lado do Criar conta. */
function LoginLink({ size = 'lg', testId }: { size?: ButtonSize; testId?: string }) {
  return (
    <a
      href="/entrar"
      className={clsx(BUTTON_BASE, BUTTON_VARIANTS.secondary, BUTTON_SIZES[size])}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <LogIn className="size-4" aria-hidden />
      Entrar
    </a>
  );
}

/** Print real da operação ou, enquanto ele não chega, um espaço reservado do mesmo tamanho. */
function Screen({
  slot,
  priority,
  preview,
  mobileCrop,
}: {
  slot: ScreenSlot;
  /** Melhoria 143: no celular, mostra um recorte ampliado (o print inteiro fica ilegível). */
  mobileCrop?: boolean;
  priority?: boolean;
  preview: boolean;
}) {
  return (
    <figure>
      <Card className="overflow-hidden p-0">
        {slot.src ? (
          // Arquivo estático local (CSP: img-src 'self'); sem o otimizador de imagens.
          <>
            {mobileCrop && (
              <div className="aspect-[4/3] overflow-hidden sm:hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={slot.src}
                  alt=""
                  aria-hidden
                  width={slot.width}
                  height={slot.height}
                  loading={priority ? 'eager' : 'lazy'}
                  className="block h-auto w-[230%] max-w-none"
                />
              </div>
            )}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={slot.src}
              alt={slot.title}
              width={slot.width}
              height={slot.height}
              loading={priority ? 'eager' : 'lazy'}
              className={clsx('block h-auto w-full', mobileCrop && 'max-sm:hidden')}
            />
          </>
        ) : (
          <div
            className="flex flex-col items-center justify-center gap-2 bg-subtle/60 p-6 text-center"
            style={{ aspectRatio: `${slot.width} / ${slot.height}` }}
            data-testid={`site-screen-${slot.key}`}
          >
            <ImageOff className="size-6 text-ink-muted" aria-hidden />
            <p className="text-sm font-medium text-ink-soft">{slot.title}</p>
            {preview && (
              <p className="text-xs text-ink-muted">
                Espaço do print real da Cenário Estofados ({slot.width} × {slot.height})
              </p>
            )}
          </div>
        )}
      </Card>
      {slot.src && <figcaption className="mt-3 text-sm text-ink-muted">{slot.title}.</figcaption>}
    </figure>
  );
}

/** Item 27: tela do app do dono, no formato de um celular. */
function Phone({ slot, className }: { slot: ScreenSlot; className?: string }) {
  if (!slot.src) return null;
  return (
    <figure className={clsx('mx-auto w-full max-w-[260px]', className)}>
      <div className="overflow-hidden rounded-[2rem] border-[6px] border-ink/90 bg-ink/90 shadow-lg">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={slot.src}
          alt={slot.title}
          width={slot.width}
          height={slot.height}
          loading="lazy"
          className="block h-auto w-full rounded-[1.6rem]"
        />
      </div>
      <figcaption className="mt-3 text-center text-sm text-ink-muted">{slot.title}.</figcaption>
    </figure>
  );
}

/** Largura e respiro comuns a todas as seções. */
export const WRAP = 'mx-auto max-w-7xl px-4 sm:px-6 lg:px-8';

function SectionTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h2
      className={clsx(
        'text-2xl font-semibold tracking-tight text-balance text-ink sm:text-3xl',
        className,
      )}
    >
      {children}
    </h2>
  );
}

const QUESTIONS: { q: string; a: string }[] = [
  {
    q: 'Qual peça precisa sair primeiro?',
    a: 'Programação da semana e a fila de cada tapeceiro, na ordem, no tablet.',
  },
  {
    q: 'O tecido desse serviço já chegou?',
    a: 'A lista de materiais de cada serviço mostra o que já está na oficina e o que falta.',
  },
  {
    q: 'Quem está fazendo essa peça?',
    a: 'Responsável e andamento de cada etapa da produção.',
  },
  {
    q: 'Esse serviço está atrasado?',
    a: 'O que já atrasou e o que está em risco, logo no início do painel.',
  },
  {
    q: 'Quanto ficou de mão de obra?',
    a: 'Lançada por peça e fechada por semana, funcionário por funcionário.',
  },
  {
    q: 'Essa peça já pode ser entregue?',
    a: 'Só depois de concluir as tarefas, passar na inspeção e ser embalada.',
  },
];

// Revisão geral (2026-11-18, item 11): na ordem real da oficina, como o sistema funciona hoje.
const FLOW: { title: string; text: string }[] = [
  {
    title: 'Orçamento',
    text: 'Material, mão de obra, frete e taxa da maquininha calculados. A proposta sai pronta para mandar ao cliente.',
  },
  {
    title: 'Cliente aprova pelo link',
    text: 'Ele abre a proposta no celular e aprova. Você recebe o aviso na hora e combina a retirada.',
  },
  {
    title: 'Retirada na agenda',
    text: 'O serviço é fechado com o que veio do orçamento e a retirada entra no roteiro do dia.',
  },
  {
    title: 'OS e material',
    text: 'A peça chega, a OS é aberta com medidas e fotos, e o material comprado fica marcado.',
  },
  {
    title: 'Semana no tablet',
    text: 'A semana da oficina vai para o tablet de cada tapeceiro, na ordem.',
  },
  {
    title: 'Entrega',
    text: 'Inspeção, embalagem e entrega confirmada pelo celular.',
  },
];

const WORKSHOP: string[] = [
  'A próxima tarefa e a fila da semana, na ordem.',
  'Medidas, material e fotos do serviço na mesma tela.',
  'Iniciar, pausar e concluir com um toque.',
  'Avisar na hora que falta material para a tarefa.',
];

// Item 27: o app do dono e a IA (o que mais impressiona numa demonstração).
const OWNER_APP: string[] = [
  'Segure o microfone e pergunte: "tem retirada amanhã?", "quanto sobrou este mês?". A resposta vem com os dados da sua oficina.',
  'Aprove orçamentos, veja a oficina e o dinheiro do dia, de onde estiver.',
  'Agentes de IA que fazem tarefas de verdade: avisar o cliente que a peça ficou pronta, agendar a entrega, confirmar a retirada na véspera.',
  'Você decide tarefa por tarefa: a IA só sugere, pede a sua aprovação ou faz sozinha.',
];

// Item 31: como é hoje e como fica, sem exagero.
const BEFORE_AFTER: { hoje: string; cenario: string }[] = [
  {
    hoje: 'O orçamento sai na calculadora e vai por mensagem de texto.',
    cenario:
      'Material, mão de obra e taxa calculados. A proposta vai por link e o cliente aprova no celular.',
  },
  {
    hoje: 'O prazo fica na cabeça de quem atendeu.',
    cenario: 'O prazo sugerido sai da fila real da oficina, e o atraso aparece antes de acontecer.',
  },
  {
    hoje: 'O tapeceiro pergunta o que fazer agora.',
    cenario: 'Cada um abre o tablet e vê a próxima tarefa, na ordem da semana.',
  },
  {
    hoje: 'A medida e a foto da peça ficam espalhadas no WhatsApp.',
    cenario: 'Medidas, fotos e material ficam na OS, com o padrão da casa de cada etapa.',
  },
  {
    hoje: 'No fim do mês, ninguém sabe ao certo quanto sobrou.',
    cenario: 'Quanto entrou, quanto saiu e o que cada serviço deixou, no mesmo dia.',
  },
];

const OFFICE: string[] = [
  'O que precisa de você hoje: prazos, orçamentos aprovados, peças esperando material.',
  'O valor de cada serviço e o que o cliente já pagou.',
  'Contas a pagar de fornecedores, despesas e frete.',
  'Quanto entrou, quanto saiu e quanto sobrou, e o que cada serviço deixou.',
  'Cada funcionário com o próprio acesso, vendo só o que a função dele permite.',
];

function faq(preview: boolean): { q: string; a: React.ReactNode }[] {
  const items: { q: string; a: React.ReactNode | null }[] = [
    {
      q: 'Quem fez o Cenário Gestão?',
      a: 'A Cenário Estofados. O sistema nasceu dentro da nossa oficina para organizar a nossa própria operação, e é ele que a gente usa no dia a dia.',
    },
    {
      q: 'Funciona no tablet e no celular?',
      a: 'Sim, pelo navegador. O escritório usa o computador, a oficina usa tablets e as entregas são confirmadas no celular.',
    },
    {
      q: 'Precisa de internet?',
      a: 'Sim. Se a conexão cair, o tablet avisa e volta a sincronizar quando ela retorna.',
    },
    {
      q: 'Emite nota fiscal ou boleto?',
      a: 'Não. O Cenário Gestão cuida da produção e do controle financeiro da oficina. Ele não emite nota fiscal nem boleto e não se conecta ao banco.',
    },
    { q: 'Quantas pessoas podem usar?', a: SITE.usersAnswer },
    { q: 'Onde ficam os meus dados?', a: SITE.dataAnswer },
  ];
  return items.flatMap((i) =>
    i.a ? [{ q: i.q, a: i.a }] : preview ? [{ q: i.q, a: <Pending>[PENDENTE]</Pending> }] : [],
  );
}

/** Lista simples com divisores, no lugar de cartões. */
function Lines({ items }: { items: string[] }) {
  return (
    <ul className="divide-y divide-line border-y border-line">
      {items.map((line) => (
        <li key={line} className="py-3 text-[15px] leading-6 text-ink-soft">
          {line}
        </li>
      ))}
    </ul>
  );
}

export function Landing({
  preview,
  blogOrigem,
  legal,
}: {
  preview: boolean;
  /** Páginas legais no ar? (await legalMode() na página). */
  legal?: LegalMode;
  /** Veio de um link do blog (utm_source=blog): o WhatsApp já chega com "Vim pelo blog". */
  blogOrigem?: { slug?: string; titulo?: string } | null;
}) {
  const wa = whatsappUrl(SITE, blogOrigem ? { blog: true, artigo: blogOrigem.titulo } : undefined);
  const origem = blogOrigem ? (blogOrigem.slug ? `blog:${blogOrigem.slug}` : 'blog') : undefined;
  const price = SITE.monthlyPrice;
  const annual = annualOffer();
  const gameAnnual = annualOffer(SITE, SITE.gameMonthlyPrice);
  const trial = trialOffer();
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <SkipLink />
      <SiteConsent preview={preview} />
      {/* Assistentes de IA: dados estruturados do produto e ferramentas WebMCP (só info pública). */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd()).replace(/</g, '\\u003c') }}
      />
      <WebMcpTools />
      {preview && (
        <div className="border-b border-warn-600/20 bg-warn-50 px-4 py-2 text-center text-xs font-medium text-warn-600">
          Pré-visualização de desenvolvimento. Em produção esta página só abre com SITE_COMERCIAL=1
          e sem pendências (preço e WhatsApp).
        </div>
      )}

      <TopBar href={wa} origem={origem} />
      <header className={clsx(WRAP, 'flex items-center justify-between gap-4 py-5')}>
        {/* Cenário Gestão e Cenário Estofados são empresas diferentes: o topo mostra só o sistema. */}
        <BrandMark />
        <div className="flex items-center gap-2">
          {/* No celular o Criar conta já aparece logo abaixo, na abertura; o topo fica só com Entrar. */}
          <SignupLink size="sm" className="max-sm:hidden">
            Criar conta
          </SignupLink>
          <LoginLink size="sm" testId="site-entrar" />
        </div>
      </header>

      <main id="conteudo">
        {/* Abertura: texto curto à esquerda, o sistema real à direita */}
        <section
          className={clsx(
            WRAP,
            'grid items-center gap-10 pt-8 pb-16 sm:pt-12 lg:grid-cols-[5fr_7fr] lg:gap-14 lg:pt-14 lg:pb-24',
          )}
        >
          <div>
            <h1 className="text-4xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-5xl">
              Feito dentro de uma tapeçaria, para tapeçarias.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-7 text-pretty text-ink-soft">
              Orçamentos, serviços, produção, prazos e entregas num sistema feito para a rotina de
              uma tapeçaria. E um app no celular do dono, com IA que conversa e faz tarefas.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <SignupLink />
              <LoginLink />
            </div>
            {preview && !SITE.whatsappNumber && (
              <p className="mt-2">
                <Pending>WhatsApp [PENDENTE]</Pending>
              </p>
            )}
            <p className="mt-6 text-sm text-ink-muted">
              Criado a partir da operação real da Cenário Estofados. As telas desta página usam
              dados de exemplo.
            </p>
          </div>
          <Screen slot={SCREENS.inicio} priority preview={preview} mobileCrop />
        </section>

        {/* As perguntas do dia: conteúdo em linhas, não cartões */}
        <section className="border-t border-line bg-surface">
          <div className={clsx(WRAP, 'py-16 sm:py-20')}>
            <SectionTitle>As perguntas que você responde o dia inteiro</SectionTitle>
            <dl className="mt-8 divide-y divide-line border-y border-line">
              {QUESTIONS.map((item) => (
                <div
                  key={item.q}
                  className="grid gap-1 py-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-baseline md:gap-10"
                >
                  <dt className="text-xl font-semibold tracking-tight text-balance sm:text-2xl">
                    {item.q}
                  </dt>
                  <dd className="text-[15px] leading-6 text-ink-soft sm:text-base">{item.a}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* Do pedido à entrega: a tela de produção ao lado das etapas */}
        <section className={clsx(WRAP, 'py-16 sm:py-20')}>
          <SectionTitle>Um serviço, do começo ao fim, no mesmo lugar</SectionTitle>
          <div className="mt-10 grid items-start gap-10 lg:grid-cols-[7fr_5fr] lg:gap-14">
            <div className="order-2 lg:order-1">
              <Screen slot={SCREENS.producao} preview={preview} />
            </div>
            <ol className="order-1 grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:order-2 lg:grid-cols-1 lg:gap-y-4">
              {FLOW.map((step, n) => (
                <li key={step.title} className="grid grid-cols-[2.25rem_1fr] gap-x-2">
                  <span className="text-[15px] font-semibold text-brand-700 tabular-nums">
                    {String(n + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <p className="font-semibold">{step.title}</p>
                    <p className="mt-0.5 text-[15px] leading-6 text-ink-soft">{step.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Tablet na oficina: a maior diferença do sistema, com a tela em destaque */}
        <section className="border-t border-line bg-surface">
          <div
            className={clsx(
              WRAP,
              'grid items-center gap-10 py-16 sm:py-20 lg:grid-cols-[5fr_7fr] lg:gap-14',
            )}
          >
            <div>
              <SectionTitle>Na oficina, cada um sabe o que fazer.</SectionTitle>
              <p className="mt-4 text-[15px] leading-7 text-ink-soft sm:text-base">
                O tapeceiro abre o tablet e vê o dia dele. O que ele faz ali, o escritório vê na
                hora.
              </p>
              <div className="mt-6">
                <Lines items={WORKSHOP} />
              </div>
            </div>
            <Screen slot={SCREENS.tablet} preview={preview} />
          </div>
        </section>

        {/* Gestão e financeiro: a tela à esquerda, o texto à direita */}
        <section className={clsx(WRAP, 'py-16 sm:py-20')}>
          <div className="grid items-center gap-10 lg:grid-cols-[7fr_5fr] lg:gap-14">
            <div className="order-2 lg:order-1">
              <Screen slot={SCREENS.financeiro} preview={preview} />
            </div>
            <div className="order-1 lg:order-2">
              <SectionTitle>Para quem toca o escritório</SectionTitle>
              <div className="mt-6">
                <Lines items={OFFICE} />
              </div>
              <p className="mt-4 text-sm leading-6 text-ink-muted">
                O financeiro é de controle: você registra o que recebeu e o que pagou. Ele não emite
                nota fiscal nem boleto e não se conecta ao banco.
              </p>
            </div>
          </div>
        </section>

        {/* Item 27: o app do dono e a IA, com as telas no formato do celular */}
        <section className="border-t border-line bg-surface" data-testid="site-app-dono">
          <div className={clsx(WRAP, 'py-16 sm:py-20')}>
            <div className="grid items-start gap-10 lg:grid-cols-[5fr_7fr] lg:gap-14">
              <div>
                <SectionTitle>O dono acompanha tudo pelo celular</SectionTitle>
                <p className="mt-4 text-[15px] leading-7 text-ink-soft sm:text-base">
                  Um app só para o dono, que fica na tela do celular. Você conversa com o sistema
                  como conversa com alguém da oficina.
                </p>
                <div className="mt-6">
                  <Lines items={OWNER_APP} />
                </div>
                <p className="mt-4 text-sm leading-6 text-ink-muted">
                  A conversa com o sistema e os agentes de IA vêm no plano Cenário Gestão + Firma
                  Viva.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4 sm:gap-6">
                <Phone slot={PHONE_SCREENS.conversar} />
                <Phone slot={PHONE_SCREENS.ia} className="mt-10" />
              </div>
            </div>
          </div>
        </section>

        {/* Item 31: caderno e WhatsApp lado a lado com o Cenário */}
        <section className={clsx(WRAP, 'py-16 sm:py-20')} data-testid="site-antes-depois">
          <SectionTitle>Caderno e WhatsApp × Cenário</SectionTitle>
          <div className="mt-8 overflow-hidden rounded-2xl border border-line">
            <div className="grid grid-cols-2 border-b border-line bg-subtle/60 text-sm font-semibold">
              <p className="px-4 py-3 text-ink-soft sm:px-6">Como é hoje</p>
              <p className="border-l border-line px-4 py-3 text-brand-700 sm:px-6">Com o Cenário</p>
            </div>
            <dl className="divide-y divide-line">
              {BEFORE_AFTER.map((row) => (
                <div key={row.hoje} className="grid grid-cols-2">
                  <dt className="px-4 py-4 text-[15px] leading-6 text-ink-soft sm:px-6">
                    {row.hoje}
                  </dt>
                  <dd className="border-l border-line px-4 py-4 text-[15px] leading-6 text-ink sm:px-6">
                    {row.cenario}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <p className="mt-6 text-[15px] text-ink-soft">
            Quer saber quanto cobrar por uma reforma?{' '}
            <Link
              href="/calculadora"
              className="inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline"
              data-testid="site-calculadora-link"
            >
              <Calculator className="size-4" aria-hidden />
              Faça a conta na calculadora
            </Link>
          </p>
        </section>

        {/* Mensalidade: os dois planos (melhoria 70), com o período de teste */}
        <section className="border-t border-line bg-surface" aria-labelledby="mensalidade">
          <div
            className={clsx(
              WRAP,
              'grid gap-8 py-16 sm:py-20 lg:grid-cols-[5fr_7fr] lg:items-start lg:gap-14',
            )}
          >
            <div>
              <SectionTitle className="scroll-mt-8">
                <span id="mensalidade">Uma mensalidade, sem surpresa</span>
              </SectionTitle>
              <p className="mt-4 text-[15px] leading-7 text-ink-soft sm:text-base">
                Inclui o sistema inteiro, com tudo o que aparece nesta página: orçamentos, serviços,
                ficha da peça, lista de materiais e estoque, produção, tablets da oficina,
                qualidade, entregas e financeiro.
              </p>
            </div>
            <div className="border-y border-line py-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-2xl border border-line p-5">
                  <p className="font-semibold">Cenário Gestão</p>
                  <p className="mt-1 text-sm text-ink-muted">
                    O sistema completo: painel, tablets da oficina e orçamentos.
                  </p>
                  <p className="mt-4 flex items-baseline gap-2" data-testid="site-price">
                    <span className="text-4xl font-semibold tracking-tight tabular-nums">
                      R$ {price ? shortPrice(price) : '[VALOR]'}
                    </span>
                    <span className="text-ink-muted">/ mês</span>
                  </p>
                  {annual && (
                    <p className="mt-2 text-sm leading-6 text-ink-soft" data-testid="site-annual">
                      {annual}
                    </p>
                  )}
                </div>
                {SITE.gameMonthlyPrice && (
                  <div className="rounded-2xl border border-brand-200 bg-brand-50/50 p-5">
                    {/* Melhoria 146: a oficina em 3D aparece no cartão do plano. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src="/site/firma-viva.webp"
                      alt="A oficina no Firma Viva, em 3D, com as peças e a equipe do sistema"
                      width={960}
                      height={643}
                      loading="lazy"
                      className="mb-4 block h-auto w-full rounded-xl border border-brand-200"
                    />
                    <p className="font-semibold">Cenário Gestão + Firma Viva</p>
                    <p className="mt-1 text-sm text-ink-muted">
                      Tudo do Cenário Gestão e a oficina e o escritório em 3D, com os dados do seu
                      sistema.
                    </p>
                    <p className="mt-4 flex items-baseline gap-2" data-testid="site-price-game">
                      <span className="text-4xl font-semibold tracking-tight tabular-nums">
                        R$ {shortPrice(SITE.gameMonthlyPrice)}
                      </span>
                      <span className="text-ink-muted">/ mês</span>
                    </p>
                    {gameAnnual && (
                      <p className="mt-2 text-sm leading-6 text-ink-soft">{gameAnnual}</p>
                    )}
                  </div>
                )}
              </div>
              {trial && (
                <p className="mt-4 font-medium text-brand-700" data-testid="site-trial">
                  {trial}
                </p>
              )}
              {SITE.onboarding ? (
                <div className="mt-5">
                  <p className="text-sm font-semibold text-ink">Implantação</p>
                  <p className="mt-1 text-[15px] leading-7 text-ink-soft">{SITE.onboarding}</p>
                </div>
              ) : (
                preview && (
                  <Alert tone="warn" title="Implantação: [PENDENTE]" className="mt-5">
                    Prazo, custo, migração de dados, treinamento e suporte ainda não foram
                    definidos. Este bloco não aparece em produção enquanto estiver vazio.
                  </Alert>
                )
              )}
              <div className="mt-6 flex flex-wrap gap-3">
                <SignupLink />
              </div>
            </div>
          </div>
        </section>

        {/* Perguntas frequentes: abertas, com divisores */}
        <section
          className={clsx(WRAP, 'grid gap-8 py-16 sm:py-20 lg:grid-cols-[5fr_7fr] lg:gap-14')}
        >
          <SectionTitle>Perguntas frequentes</SectionTitle>
          <dl className="divide-y divide-line border-y border-line">
            {faq(preview).map((item) => (
              <div key={item.q} className="py-5">
                <dt className="font-semibold">{item.q}</dt>
                <dd className="mt-1.5 text-[15px] leading-7 text-ink-soft">{item.a}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* Fechamento: uma frase e o botão, sem faixa publicitária */}
        <section id="contato" className="border-t border-line bg-surface">
          <div
            className={clsx(
              WRAP,
              'flex flex-col items-start gap-6 py-14 sm:py-16 lg:flex-row lg:items-center lg:justify-between',
            )}
          >
            <div>
              <SectionTitle>Quer ver o sistema funcionando?</SectionTitle>
              <p className="mt-2 text-[15px] text-ink-soft sm:text-base">
                Crie a sua conta e comece agora. Se preferir conversar antes, toque em Chamar no
                WhatsApp, no canto da tela, e a gente mostra.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <SignupLink />
              <LoginLink />
            </div>
          </div>
        </section>
      </main>

      {/* Melhoria 147: rodapé com os caminhos de contato e de acesso. */}
      <footer className="border-t border-line">
        <div
          className={clsx(
            WRAP,
            'flex flex-col gap-5 py-8 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between',
          )}
        >
          <div>
            <BrandMark />
            <p className="mt-3">O Cenário Gestão é feito pela Cenário Estofados.</p>
          </div>
          <nav aria-label="Rodapé" className="flex flex-wrap gap-x-5 gap-y-2 font-medium">
            {artigosPublicados().length > 0 && (
              <Link href="/blog" className="text-ink-soft hover:text-ink hover:underline">
                Blog
              </Link>
            )}
            {wa && (
              <a
                href={wa}
                {...(origem ? { 'data-origem': origem } : {})}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ink-soft hover:text-ink hover:underline"
              >
                WhatsApp {formatPhone(SITE.whatsappNumber)}
                <span className="sr-only"> (abre em outra aba)</span>
              </a>
            )}
            <Link href="/calculadora" className="text-ink-soft hover:text-ink hover:underline">
              Calculadora de preço
            </Link>
            <a href="/entrar" className="text-ink-soft hover:text-ink hover:underline">
              Entrar
            </a>
            <a href={SIGNUP_PATH} className="text-ink-soft hover:text-ink hover:underline">
              Criar conta
            </a>
          </nav>
        </div>
        <LegalFooter preview={preview} mode={legal} />
        {/* Espaço para o botão flutuante não cobrir o fim do rodapé. */}
        <div className="h-20" aria-hidden />
      </footer>
      <WhatsappFloat href={wa} origem={origem} />
      <RememberOrigin />
    </div>
  );
}
