import clsx from 'clsx';
import {
  BadgeCheck,
  ChevronDown,
  ClipboardPlus,
  Hammer,
  ImageOff,
  MessageCircle,
  Ruler,
  ShoppingCart,
  Truck,
} from 'lucide-react';
import { BrandMark } from '@/components/brand';
import { Alert, Badge, Card } from '@/components/ui/misc';
import {
  BUTTON_BASE,
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  type ButtonSize,
  type ButtonVariant,
} from '@/components/ui/button-styles';
import { SCREENS, SITE, whatsappUrl, type ScreenSlot } from './config';

/**
 * Landing comercial (/conheca). Renderizada no servidor, sem sessão e sem chamadas à API: usa só
 * os tokens de globals.css e os componentes do próprio sistema. Os textos descrevem apenas o que
 * existe no código (conferido em out/2026); o que depende de decisão comercial vem de config.ts.
 */

const CTA_LABEL = 'Quero conhecer o Cenário Gestão';

function Pending({ children }: { children: React.ReactNode }) {
  return (
    <Badge tone="warn" className="align-middle">
      {children}
    </Badge>
  );
}

function ContactLink({
  variant = 'primary',
  size = 'lg',
  className,
  children = CTA_LABEL,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children?: React.ReactNode;
}) {
  const href = whatsappUrl();
  return (
    <a
      href={href ?? '#contato'}
      {...(href ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className={clsx(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], className)}
      data-testid="site-cta"
    >
      <MessageCircle className="size-4" aria-hidden />
      {children}
    </a>
  );
}

/** Print real da operação ou, enquanto ele não chega, um espaço reservado do mesmo tamanho. */
function Screen({
  slot,
  priority,
  preview,
}: {
  slot: ScreenSlot;
  priority?: boolean;
  preview: boolean;
}) {
  return (
    <figure>
      <Card className="overflow-hidden p-0">
        {slot.src ? (
          // Arquivo estático local (CSP: img-src 'self'); sem o otimizador de imagens.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={slot.src}
            alt={slot.title}
            width={slot.width}
            height={slot.height}
            loading={priority ? 'eager' : 'lazy'}
            className="block h-auto w-full"
          />
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
      {slot.src && (
        <figcaption className="mt-3 text-sm text-ink-muted">
          {slot.title}, na Cenário Estofados. Dados de clientes desfocados.
        </figcaption>
      )}
    </figure>
  );
}

function SectionTitle({ children, lead }: { children: React.ReactNode; lead?: React.ReactNode }) {
  return (
    <div className="max-w-2xl">
      <h2 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{children}</h2>
      {lead && <p className="mt-3 text-[15px] leading-7 text-ink-soft sm:text-base">{lead}</p>}
    </div>
  );
}

const QUESTIONS: { q: string; a: string; where: string }[] = [
  {
    q: 'Qual sofá precisa sair primeiro?',
    a: 'Você monta a programação da semana e cada tapeceiro vê a própria fila, na ordem, no tablet.',
    where: 'Programação da semana',
  },
  {
    q: 'O tecido desse serviço já chegou?',
    a: 'A prontidão de materiais mostra, por serviço, o que já está separado, o que foi comprado e o que ainda falta.',
    where: 'Prontidão de materiais',
  },
  {
    q: 'Quem está fazendo essa peça?',
    a: 'O quadro de produção mostra cada etapa, quem é o responsável e se ela está andando, pausada ou bloqueada.',
    where: 'Quadro de produção',
  },
  {
    q: 'Esse serviço está atrasado?',
    a: 'O início do painel separa o que já está atrasado do que está em risco de atrasar.',
    where: 'Prazos',
  },
  {
    q: 'Quanto ficou de mão de obra?',
    a: 'A mão de obra é lançada por peça e fechada por semana, com o valor de cada profissional.',
    where: 'Fechamento semanal',
  },
  {
    q: 'Essa peça já pode ser entregue?',
    a: 'Ela só fica pronta para entrega depois de terminar as tarefas, passar na inspeção de qualidade e ser embalada.',
    where: 'Qualidade e entrega',
  },
];

const FLOW: { icon: React.ReactNode; title: string; text: string }[] = [
  {
    icon: <ClipboardPlus className="size-4" aria-hidden />,
    title: 'Pedido',
    text: 'Cliente, serviço e retirada cadastrados numa tela só.',
  },
  {
    icon: <Truck className="size-4" aria-hidden />,
    title: 'Retirada e chegada',
    text: 'A retirada entra no roteiro do dia e a oficina confirma no tablet quando as peças chegam.',
  },
  {
    icon: <Ruler className="size-4" aria-hidden />,
    title: 'Medição',
    text: 'Medidas, tecido e espuma de cada peça, lançados no tablet e aprovados no escritório.',
  },
  {
    icon: <ShoppingCart className="size-4" aria-hidden />,
    title: 'Material',
    text: 'Pedido ao fornecedor, conferência no recebimento e estoque reservado para cada serviço.',
  },
  {
    icon: <Hammer className="size-4" aria-hidden />,
    title: 'Produção',
    text: 'A programação da semana é publicada e cada etapa aparece no tablet de quem vai fazer.',
  },
  {
    icon: <BadgeCheck className="size-4" aria-hidden />,
    title: 'Qualidade e entrega',
    text: 'Inspeção, embalagem e agenda de entregas. O entregador confirma pelo celular.',
  },
];

const OFFICE: string[] = [
  'Uma tela de início com o que pede atenção hoje: prazos, material a comprar, produção bloqueada e peças prontas para entrega.',
  'O valor de cada serviço e o que o cliente já pagou.',
  'Contas a pagar de fornecedores, despesas e frete.',
  'Custo e margem de cada serviço, com relatórios por período.',
  'Cada funcionário entra com o próprio acesso e só vê o que a função dele permite.',
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

export function Landing({ preview }: { preview: boolean }) {
  const price = SITE.monthlyPrice;
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      {preview && (
        <div className="border-b border-warn-600/20 bg-warn-50 px-4 py-2 text-center text-xs font-medium text-warn-600">
          Pré-visualização de desenvolvimento. Em produção esta página só abre com SITE_COMERCIAL=1
          e sem pendências (preço, WhatsApp e prints).
        </div>
      )}

      <header className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-5 sm:px-6">
        <BrandMark />
        <ContactLink variant="secondary" size="sm">
          Quero conhecer
        </ContactLink>
      </header>

      <main>
        {/* Abertura */}
        <section className="mx-auto max-w-6xl px-4 pt-10 pb-16 sm:px-6 sm:pt-16">
          <div className="max-w-3xl">
            <p className="text-sm font-medium text-brand-700">
              Sistema de gestão para tapeçarias e fábricas de estofados
            </p>
            <h1 className="mt-3 text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">
              Feito dentro de uma tapeçaria, para tapeçarias.
            </h1>
            <p className="mt-5 text-lg leading-8 text-ink-soft">
              O Cenário Gestão organiza o serviço de estofado do pedido à entrega. Você sabe quem
              está fazendo cada peça, se o material já chegou, o que está atrasado e quanto ficou de
              mão de obra. No computador do escritório e no tablet da oficina.
            </p>
            <p className="mt-4 text-[15px] leading-7 text-ink-muted">
              O Cenário Gestão nasceu dentro da Cenário Estofados para organizar a nossa própria
              operação, e é o sistema que a gente usa na oficina. Não é um programa genérico
              adaptado para tapeçaria. Agora oferecemos a mesma ferramenta para outras tapeçarias e
              empresas de estofados.
            </p>
            <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-4">
              <ContactLink />
              <p className="text-sm text-ink-muted">
                Você fala direto com a gente pelo WhatsApp.
                {preview && !SITE.whatsappNumber && (
                  <>
                    {' '}
                    <Pending>WhatsApp [PENDENTE]</Pending>
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="mt-12 sm:mt-14">
            <Screen slot={SCREENS.inicio} priority preview={preview} />
          </div>
        </section>

        {/* O problema */}
        <section className="border-t border-line bg-surface">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
            <SectionTitle>As perguntas que você responde o dia inteiro</SectionTitle>
            <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {QUESTIONS.map((item) => (
                <li key={item.q} className="rounded-2xl border border-line bg-canvas/60 p-5">
                  <p className="text-lg font-semibold tracking-tight">{item.q}</p>
                  <p className="mt-2 text-[15px] leading-6 text-ink-soft">{item.a}</p>
                  <Badge tone="brand" className="mt-4">
                    {item.where}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Do pedido à entrega */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <SectionTitle>Um serviço, do começo ao fim, no mesmo lugar</SectionTitle>
          <ol className="mt-10 grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
            {FLOW.map((step, n) => (
              <li key={step.title} className="flex gap-3">
                <span className="mt-0.5 h-fit rounded-lg bg-brand-50 p-1.5 text-brand-700">
                  {step.icon}
                </span>
                <div>
                  <p className="font-semibold">
                    <span className="text-ink-muted tabular-nums">{n + 1}.</span> {step.title}
                  </p>
                  <p className="mt-1 text-[15px] leading-6 text-ink-soft">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-12">
            <Screen slot={SCREENS.producao} preview={preview} />
          </div>
        </section>

        {/* Tablet na oficina */}
        <section className="border-t border-line bg-surface">
          <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-16 sm:px-6 sm:py-20 lg:grid-cols-[2fr_3fr] lg:gap-14">
            <div>
              <SectionTitle>Na oficina, cada um sabe o que fazer</SectionTitle>
              <div className="mt-6 space-y-4 text-[15px] leading-7 text-ink-soft sm:text-base">
                <p>
                  O tapeceiro abre o tablet e vê o dia dele: a próxima tarefa, as medidas, o tecido
                  e as fotos do serviço.
                </p>
                <p>
                  Inicia, pausa e conclui com um toque. Se faltar material ou aparecer um problema,
                  avisa dali mesmo e o escritório vê na hora.
                </p>
                <p>
                  Pode pedir um ajudante ou ajuda urgente. Quem recebe por produção acompanha os
                  próprios ganhos da semana.
                </p>
              </div>
            </div>
            <Screen slot={SCREENS.tablet} preview={preview} />
          </div>
        </section>

        {/* Gestão e financeiro */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <div className="grid gap-10 lg:grid-cols-[2fr_3fr] lg:gap-14">
            <div>
              <SectionTitle>Para quem toca o escritório</SectionTitle>
              <ul className="mt-6 space-y-3 text-[15px] leading-6 text-ink-soft">
                {OFFICE.map((line) => (
                  <li key={line} className="flex gap-3">
                    <span
                      className="mt-2.5 size-1.5 shrink-0 rounded-full bg-brand-500"
                      aria-hidden
                    />
                    {line}
                  </li>
                ))}
              </ul>
              <Alert tone="info" title="O financeiro é de controle" className="mt-6">
                Você registra o que recebeu e o que pagou. Ele não emite nota fiscal nem boleto e
                não se conecta ao banco.
              </Alert>
            </div>
            <Screen slot={SCREENS.financeiro} preview={preview} />
          </div>
        </section>

        {/* Mensalidade */}
        <section className="border-t border-line bg-surface" aria-labelledby="mensalidade">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
            <Card className="mx-auto max-w-xl p-6 sm:p-8">
              <h2 id="mensalidade" className="text-2xl font-semibold tracking-tight">
                Um sistema, uma mensalidade
              </h2>
              <p className="mt-5 flex items-baseline gap-2" data-testid="site-price">
                <span className="text-4xl font-semibold tracking-tight tabular-nums">
                  R$ {price ?? '[VALOR]'}
                </span>
                <span className="text-ink-muted">/ mês</span>
              </p>
              <p className="mt-5 text-[15px] leading-7 text-ink-soft">
                Inclui o sistema inteiro, com tudo o que aparece nesta página: serviços, medição,
                compras e estoque, produção, tablets da oficina, qualidade, entregas e financeiro.
              </p>
              {SITE.onboarding ? (
                <div className="mt-5 border-t border-line pt-5">
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
              <ContactLink className="mt-7 w-full" />
            </Card>
          </div>
        </section>

        {/* Perguntas frequentes */}
        <section className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
          <SectionTitle>Perguntas frequentes</SectionTitle>
          <div className="mt-8 divide-y divide-line rounded-2xl border border-line bg-surface">
            {faq(preview).map((item) => (
              <details key={item.q} className="group px-5 py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold [&::-webkit-details-marker]:hidden">
                  {item.q}
                  <ChevronDown
                    className="size-4 shrink-0 text-ink-muted group-open:rotate-180"
                    aria-hidden
                  />
                </summary>
                <div className="mt-2 text-[15px] leading-7 text-ink-soft">{item.a}</div>
              </details>
            ))}
          </div>
        </section>

        {/* Contato final: o mesmo painel verde da tela de entrada do sistema */}
        <section id="contato" className="bg-brand-800 text-white">
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-16 sm:px-6 sm:py-20 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-xl">
              <h2 className="text-3xl font-semibold tracking-tight">
                Quer ver o sistema funcionando?
              </h2>
              <p className="mt-3 text-white/70">
                Chame no WhatsApp e a gente mostra o Cenário Gestão com calma.
              </p>
            </div>
            <ContactLink
              variant="secondary"
              className="border-transparent text-brand-800 hover:bg-brand-50"
            />
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <BrandMark />
        <p>O Cenário Gestão é feito pela Cenário Estofados.</p>
      </footer>
    </div>
  );
}
