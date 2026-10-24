import clsx from 'clsx';
import { ImageOff, MessageCircle } from 'lucide-react';
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

/** Largura e respiro comuns a todas as seções. */
const WRAP = 'mx-auto max-w-7xl px-4 sm:px-6 lg:px-8';

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
    q: 'Qual sofá precisa sair primeiro?',
    a: 'Programação da semana e a fila de cada tapeceiro, na ordem, no tablet.',
  },
  {
    q: 'O tecido desse serviço já chegou?',
    a: 'Material separado, comprado e pendente, serviço por serviço.',
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
    a: 'Lançada por peça e fechada por semana, profissional por profissional.',
  },
  {
    q: 'Essa peça já pode ser entregue?',
    a: 'Só depois de concluir as tarefas, passar na inspeção e ser embalada.',
  },
];

const FLOW: { title: string; text: string }[] = [
  { title: 'Pedido', text: 'Cliente, serviço e retirada numa tela só.' },
  {
    title: 'Retirada e chegada',
    text: 'A retirada entra no roteiro do dia e a oficina confirma a chegada no tablet.',
  },
  {
    title: 'Medição',
    text: 'Medidas, tecido e espuma lançados no tablet e aprovados no escritório.',
  },
  {
    title: 'Material',
    text: 'Compra, conferência no recebimento e estoque reservado para cada serviço.',
  },
  {
    title: 'Produção',
    text: 'A programação da semana vai direto para o tablet de quem vai fazer.',
  },
  {
    title: 'Qualidade e entrega',
    text: 'Inspeção, embalagem e entrega confirmada pelo celular.',
  },
];

const WORKSHOP: string[] = [
  'A próxima tarefa e a fila da semana, na ordem.',
  'Medidas, material e fotos do serviço na mesma tela.',
  'Iniciar, pausar e concluir com um toque.',
  'Pedir ajudante, pedir ajuda urgente ou avisar que falta material.',
];

const OFFICE: string[] = [
  'O que pede atenção hoje: prazos, material a comprar, produção bloqueada e peças prontas para entrega.',
  'O valor de cada serviço e o que o cliente já pagou.',
  'Contas a pagar de fornecedores, despesas e frete.',
  'Custo e margem de cada serviço, com relatórios por período.',
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

      <header className={clsx(WRAP, 'flex items-center justify-between gap-4 py-5')}>
        <BrandMark />
        <ContactLink variant="secondary" size="sm">
          Quero conhecer
        </ContactLink>
      </header>

      <main>
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
              Serviços, material, produção, prazos e entregas num sistema feito para a rotina de uma
              tapeçaria.
            </p>
            <div className="mt-7">
              <ContactLink />
              {preview && !SITE.whatsappNumber && (
                <p className="mt-2">
                  <Pending>WhatsApp [PENDENTE]</Pending>
                </p>
              )}
            </div>
            <p className="mt-6 text-sm text-ink-muted">
              Criado a partir da operação real da Cenário Estofados.
            </p>
          </div>
          <Screen slot={SCREENS.inicio} priority preview={preview} />
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

        {/* Mensalidade: um preço, sem tabela de planos */}
        <section className="border-t border-line bg-surface" aria-labelledby="mensalidade">
          <div
            className={clsx(
              WRAP,
              'grid gap-8 py-16 sm:py-20 lg:grid-cols-[5fr_7fr] lg:items-start lg:gap-14',
            )}
          >
            <div>
              <SectionTitle className="scroll-mt-8">
                <span id="mensalidade">Um sistema, uma mensalidade</span>
              </SectionTitle>
              <p className="mt-4 text-[15px] leading-7 text-ink-soft sm:text-base">
                Inclui o sistema inteiro, com tudo o que aparece nesta página: serviços, medição,
                compras e estoque, produção, tablets da oficina, qualidade, entregas e financeiro.
              </p>
            </div>
            <div className="border-y border-line py-6">
              <p className="flex items-baseline gap-2" data-testid="site-price">
                <span className="text-4xl font-semibold tracking-tight tabular-nums">
                  R$ {price ?? '[VALOR]'}
                </span>
                <span className="text-ink-muted">/ mês</span>
              </p>
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
              <ContactLink className="mt-6" />
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
                Chame no WhatsApp e a gente mostra o Cenário Gestão com calma.
              </p>
            </div>
            <ContactLink />
          </div>
        </section>
      </main>

      <footer
        className={clsx(
          WRAP,
          'flex flex-col gap-3 py-8 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between',
        )}
      >
        <BrandMark />
        <p>O Cenário Gestão é feito pela Cenário Estofados.</p>
      </footer>
    </div>
  );
}
