import clsx from 'clsx';
import type { Metadata } from 'next';
import { UserPlus } from 'lucide-react';
import { Shell } from '@/components/site/blog/blog';
import { PriceCalculator } from '@/components/site/calculadora/calculadora';
import {
  SIGNUP_PATH,
  SITE,
  SITE_URL,
  siteMode,
  trialOffer,
  whatsappUrl,
} from '@/components/site/config';
import { WRAP } from '@/components/site/landing';
import { legalMode } from '@/components/site/legal/legal';
import { BUTTON_BASE, BUTTON_SIZES, BUTTON_VARIANTS } from '@/components/ui/button-styles';

/**
 * Item 28 da lista de 53: calculadora grátis de preço de reforma. Traz quem procura isso no
 * Google; no fim, o convite para o teste grátis.
 */
export const dynamic = 'force-dynamic';

const TITLE = 'Calculadora de preço de reforma de estofado (grátis) · Cenário Gestão';
const DESCRIPTION =
  'Quanto cobrar pela reforma de um sofá, poltrona ou cadeira: coloque a peça, as horas de trabalho e o material e veja o preço, com lucro e taxa da maquininha.';

export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(SITE_URL),
    title: { absolute: TITLE },
    description: DESCRIPTION,
    alternates: { canonical: '/calculadora' },
    openGraph: {
      type: 'website',
      locale: 'pt_BR',
      url: '/calculadora',
      siteName: 'Cenário Gestão',
      title: TITLE,
      description: DESCRIPTION,
      images: [{ url: '/site/og.png', width: 1200, height: 630 }],
    },
    robots: siteMode() === 'live' ? { index: true, follow: true } : { index: false, follow: false },
  };
}

export default async function CalculadoraPage() {
  const trial = trialOffer();
  return (
    <Shell
      wa={whatsappUrl(SITE)}
      origem="calculadora"
      preview={siteMode() === 'preview'}
      legal={await legalMode()}
    >
      <section className={clsx(WRAP, 'pt-8 pb-6 sm:pt-12')}>
        <h1 className="text-4xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-5xl">
          Quanto cobrar por uma reforma?
        </h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-7 text-ink-soft sm:text-base">
          Coloque a peça, as horas de trabalho e o material. A calculadora mostra o preço para o
          cliente, com o seu lucro e, se for no cartão, a taxa da maquininha.
        </p>
      </section>
      <section className={clsx(WRAP, 'pb-10')}>
        <PriceCalculator />
      </section>
      <section className="border-t border-line bg-surface">
        <div
          className={clsx(
            WRAP,
            'flex flex-col items-start gap-6 py-12 lg:flex-row lg:items-center lg:justify-between',
          )}
        >
          <div className="max-w-2xl">
            <h2 className="text-2xl font-semibold tracking-tight text-balance text-ink sm:text-3xl">
              No Cenário Gestão, essa conta já vem pronta em cada orçamento.
            </h2>
            <p className="mt-2 text-[15px] leading-7 text-ink-soft sm:text-base">
              Com a sua tabela de tecidos, espumas e mão de obra. A proposta vai por link e o
              cliente aprova no celular.{trial ? ` ${trial}` : ''}
            </p>
          </div>
          <a
            href={SIGNUP_PATH}
            className={clsx(BUTTON_BASE, BUTTON_VARIANTS.primary, BUTTON_SIZES.lg)}
            data-testid="calc-criar-conta"
          >
            <UserPlus className="size-4" aria-hidden />
            Criar minha conta
          </a>
        </div>
      </section>
    </Shell>
  );
}
