import clsx from 'clsx';
import Link from 'next/link';
import { ArrowLeft, LogIn } from 'lucide-react';
import { BrandMark } from '@/components/brand';
import { BUTTON_BASE, BUTTON_SIZES, BUTTON_VARIANTS } from '@/components/ui/button-styles';
import { SIGNUP_PATH, SITE, SITE_URL, whatsappUrl } from '../config';
import { ContactLink, WRAP, formatPhone } from '../landing';
import { LegalFooter, SiteConsent, SkipLink, type LegalMode } from '../legal/legal';
import { type Artigo, dataPorExtenso, minutosDeLeitura } from './artigos';
import { Markdown } from './markdown';

/**
 * Blog público do Cenário Gestão: mesmo visual da landing (cores, fonte, botões, marca).
 * Todo link de WhatsApp daqui sai marcado: a mensagem pronta diz "Vim pelo blog" (e o artigo) e o
 * link leva data-origem para o Analytics. O link para a página principal leva utm_source=blog.
 */

export const blogHref = (slug?: string) =>
  `/?utm_source=blog&utm_medium=artigo${slug ? `&utm_campaign=${slug}` : ''}`;

export function Shell({
  children,
  wa,
  origem,
  preview,
  legal,
}: {
  legal?: LegalMode;
  children: React.ReactNode;
  wa: string | null;
  origem: string;
  preview: boolean;
}) {
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <SkipLink />
      <SiteConsent preview={preview} />
      <header className={clsx(WRAP, 'flex items-center justify-between gap-4 py-5')}>
        <a href={blogHref()} aria-label="Cenário Gestão, página principal">
          <BrandMark subtitle="Cenário Estofados" />
        </a>
        <div className="flex items-center gap-2">
          <ContactLink
            href={wa}
            origem={origem}
            variant="secondary"
            size="sm"
            className="max-sm:hidden"
          />
          <a href="/entrar" className={clsx(BUTTON_BASE, BUTTON_VARIANTS.primary, BUTTON_SIZES.sm)}>
            <LogIn className="size-4" aria-hidden />
            Entrar
          </a>
        </div>
      </header>
      <main id="conteudo">{children}</main>
      <footer className="mt-16 border-t border-line">
        <div
          className={clsx(
            WRAP,
            'flex flex-col gap-5 py-8 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between',
          )}
        >
          <div>
            <BrandMark subtitle="Cenário Estofados" />
            <p className="mt-3">O Cenário Gestão é feito pela Cenário Estofados.</p>
          </div>
          <nav aria-label="Rodapé" className="flex flex-wrap gap-x-5 gap-y-2 font-medium">
            <Link href="/blog" className="text-ink-soft hover:text-ink hover:underline">
              Blog
            </Link>
            {wa && (
              <a
                href={wa}
                target="_blank"
                rel="noopener noreferrer"
                data-origem={origem}
                className="text-ink-soft hover:text-ink hover:underline"
              >
                WhatsApp {formatPhone(SITE.whatsappNumber)}
                <span className="sr-only"> (abre em outra aba)</span>
              </a>
            )}
            <a href={SIGNUP_PATH} className="text-ink-soft hover:text-ink hover:underline">
              Criar conta
            </a>
          </nav>
        </div>
        <LegalFooter preview={preview} mode={legal} />
      </footer>
    </div>
  );
}

function Meta({ a }: { a: Artigo }) {
  return (
    <p className="text-sm text-ink-muted">
      <time dateTime={a.publicadoEm}>{dataPorExtenso(a.publicadoEm)}</time>
      {' · '}
      {a.autor}
      {' · '}
      {minutosDeLeitura(a)} min de leitura
    </p>
  );
}

export function BlogList({
  artigos,
  preview,
  legal,
}: {
  artigos: Artigo[];
  preview: boolean;
  legal?: LegalMode;
}) {
  const wa = whatsappUrl(SITE, { blog: true });
  return (
    <Shell wa={wa} origem="blog" preview={preview} legal={legal}>
      <section className={clsx(WRAP, 'pt-8 pb-4 sm:pt-12')}>
        <h1 className="text-4xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-5xl">
          Blog do Cenário Gestão
        </h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-7 text-ink-soft sm:text-base">
          Artigos sobre o dia a dia e a gestão de uma tapeçaria, escritos por quem vive a oficina.
        </p>
      </section>
      <section className={clsx(WRAP, 'py-8')}>
        <ul className="divide-y divide-line border-y border-line">
          {artigos.map((a) => (
            <li key={a.slug} className="py-6" data-testid="blog-item">
              <a href={`/blog/${a.slug}`} className="group block max-w-3xl">
                {a.rascunho && (
                  <span className="mb-2 inline-block rounded-md bg-warn-50 px-2 py-0.5 text-xs font-medium text-warn-600">
                    Rascunho (só aparece aqui no desenvolvimento)
                  </span>
                )}
                <h2 className="text-xl font-semibold tracking-tight text-ink group-hover:underline sm:text-2xl">
                  {a.titulo}
                </h2>
                <p className="mt-2 text-[15px] leading-7 text-ink-soft">{a.resumo}</p>
                <div className="mt-2">
                  <Meta a={a} />
                </div>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </Shell>
  );
}

/** Dados estruturados do artigo (BlogPosting) para buscadores e assistentes de IA. */
export function articleJsonLd(a: Artigo) {
  const url = `${SITE_URL}/blog/${a.slug}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: a.titulo,
    description: a.resumo,
    datePublished: a.publicadoEm,
    dateModified: a.atualizadoEm ?? a.publicadoEm,
    author: { '@type': 'Person', name: a.autor },
    publisher: {
      '@type': 'Organization',
      name: 'Cenário Estofados',
      logo: { '@type': 'ImageObject', url: `${SITE_URL}/icon-512.png` },
    },
    mainEntityOfPage: url,
    url,
    inLanguage: 'pt-BR',
    ...(a.capa ? { image: `${SITE_URL}${a.capa.src}` } : {}),
  };
}

export function BlogArticle({
  a,
  preview,
  legal,
}: {
  a: Artigo;
  preview: boolean;
  legal?: LegalMode;
}) {
  const wa = whatsappUrl(SITE, { blog: true, artigo: a.titulo });
  const origem = `blog:${a.slug}`;
  return (
    <Shell wa={wa} origem={origem} preview={preview} legal={legal}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(articleJsonLd(a)).replace(/</g, '\\u003c'),
        }}
      />
      <article className="mx-auto max-w-2xl px-4 pt-6 sm:px-6 sm:pt-10">
        <Link
          href="/blog"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft hover:text-ink"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Blog
        </Link>
        {a.rascunho && (
          <p className="mt-4 rounded-lg bg-warn-50 px-3 py-2 text-sm font-medium text-warn-600">
            Rascunho: só aparece aqui no desenvolvimento, nunca na homologação nem no site.
          </p>
        )}
        <h1 className="mt-4 text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl">
          {a.titulo}
        </h1>
        <p className="mt-4 text-lg leading-8 text-ink-soft">{a.resumo}</p>
        <div className="mt-4">
          <Meta a={a} />
        </div>
        {a.capa && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={a.capa.src}
            alt={a.capa.alt}
            width={a.capa.width}
            height={a.capa.height}
            className="mt-8 block h-auto w-full rounded-2xl border border-line"
          />
        )}
        <div className="mt-4 text-[17px] leading-8 text-ink-soft" data-testid="blog-corpo">
          <Markdown source={a.corpo} />
        </div>

        <aside className="mt-12 rounded-2xl border border-brand-200 bg-brand-50/50 p-6">
          <p className="text-lg font-semibold text-ink">
            Quer ver isso funcionando na sua tapeçaria?
          </p>
          <p className="mt-2 text-[15px] leading-7 text-ink-soft">
            O Cenário Gestão nasceu dentro da Cenário Estofados. Chame no WhatsApp e a gente mostra
            o sistema com calma.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <ContactLink href={wa} origem={origem} />
            <a
              href={blogHref(a.slug)}
              className={clsx(BUTTON_BASE, BUTTON_VARIANTS.secondary, BUTTON_SIZES.lg)}
            >
              Conhecer o Cenário Gestão
            </a>
          </div>
        </aside>
      </article>
    </Shell>
  );
}
