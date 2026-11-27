import clsx from 'clsx';
import { LogIn } from 'lucide-react';
import Link from 'next/link';
import { headers } from 'next/headers';
import { LEGAL, LEGAL_VERSION, legalPending } from '@cenario/shared';
import { BrandMark } from '@/components/brand';
import { Badge } from '@/components/ui/misc';
import { BUTTON_BASE, BUTTON_SIZES, BUTTON_VARIANTS } from '@/components/ui/button-styles';
import { SITE, siteMode, whatsappUrl } from '../config';
import { Analytics, CookieBanner, CookiePrefsButton } from '../consent';

/**
 * Páginas legais (LGPD, 2026-11-25): política de privacidade, termos de uso, política de reembolso
 * e o pedido sobre dados. Mesmo visual da landing. Os dados da empresa vêm de LEGAL (pacote
 * shared); faltando algum, desenvolvimento e homologação mostram "[PREENCHER]" e a produção não
 * publica as páginas (nem os links do rodapé).
 */

export const WRAP = 'mx-auto max-w-7xl px-4 sm:px-6 lg:px-8';

/** Endereço da homologação (teste.cenariogestao.com.br): mostra as pendências para conferir. */
export const isHomologHost = (host: string | null | undefined) => /^teste\./i.test(host ?? '');

/**
 * As páginas legais estão no ar? No desenvolvimento e na homologação, sempre (com "[PREENCHER]"
 * no que falta); em produção, só com todos os dados da empresa preenchidos.
 */
export type LegalMode = 'preview' | 'live' | 'off';

export async function legalMode(): Promise<LegalMode> {
  const mode = siteMode();
  if (mode === 'preview') return 'preview';
  if (mode === 'off') return 'off';
  if (legalPending().length === 0) return 'live';
  return isHomologHost((await headers()).get('host')) ? 'preview' : 'off';
}

/** O aviso de cookies só faz sentido com algo opcional (o Analytics); na pré-visualização, aparece. */
export function consentEnabled(preview: boolean) {
  return Boolean(SITE.analyticsId) || preview;
}

/** Um dado da empresa, ou a marca de que falta preencher. */
export function Dado({ v, nome }: { v: string | null; nome: string }) {
  return v ? <>{v}</> : <Badge tone="warn">[PREENCHER: {nome}]</Badge>;
}

const LINK = 'text-ink-soft underline-offset-4 hover:text-ink hover:underline';

/**
 * Bloco legal do rodapé: quem vende (razão social, CNPJ, endereço) e os links das políticas.
 * `mode` vem da página (await legalMode()); sem ele, só aparece na pré-visualização.
 */
export function LegalFooter({ preview, mode }: { preview: boolean; mode?: LegalMode }) {
  if ((mode ?? (preview ? 'preview' : 'off')) === 'off') return null;
  return (
    <div className="border-t border-line" data-testid="rodape-legal">
      <div
        className={clsx(
          WRAP,
          'flex flex-col gap-4 py-6 text-sm text-ink-muted lg:flex-row lg:items-start lg:justify-between',
        )}
      >
        <p className="max-w-xl leading-6">
          <Dado v={LEGAL.razaoSocial} nome="razão social" /> · CNPJ{' '}
          <Dado v={LEGAL.cnpj} nome="CNPJ" />
          <br />
          <Dado v={LEGAL.endereco} nome="endereço" />
          <br />
          Privacidade: <Dado v={LEGAL.emailPrivacidade} nome="e-mail do encarregado" />
        </p>
        <nav aria-label="Políticas e dados" className="flex flex-wrap gap-x-5 gap-y-2 font-medium">
          <a href="/privacidade" className={LINK}>
            Política de privacidade
          </a>
          <a href="/termos" className={LINK}>
            Termos de uso
          </a>
          <a href="/reembolso" className={LINK}>
            Cancelamento e reembolso
          </a>
          <a href="/privacidade/pedido" className={LINK}>
            Pedir sobre os seus dados
          </a>
          {consentEnabled(preview) && <CookiePrefsButton className={clsx(LINK, 'font-medium')} />}
        </nav>
      </div>
    </div>
  );
}

/** Link "Pular para o conteúdo" (teclado e leitor de tela). */
export function SkipLink() {
  return (
    <a
      href="#conteudo"
      className="sr-only rounded-lg bg-surface px-4 py-2 font-medium text-ink shadow-pop focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50"
    >
      Pular para o conteúdo
    </a>
  );
}

/** Analytics (só depois do aceite) + aviso de cookies, nas páginas públicas. */
export function SiteConsent({ preview }: { preview: boolean }) {
  return (
    <>
      {!preview && SITE.analyticsId && <Analytics id={SITE.analyticsId} />}
      <CookieBanner enabled={consentEnabled(preview)} />
    </>
  );
}

/** Moldura das páginas legais: topo com a marca, o texto, e o rodapé legal. */
export async function LegalShell({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: React.ReactNode;
  children: React.ReactNode;
}) {
  const mode = await legalMode();
  const preview = mode === 'preview';
  const pending = legalPending();
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <SkipLink />
      <SiteConsent preview={preview} />
      <header className={clsx(WRAP, 'flex items-center justify-between gap-4 py-5')}>
        <Link href="/" aria-label="Cenário Gestão, página principal">
          <BrandMark subtitle="Cenário Estofados" />
        </Link>
        <a href="/entrar" className={clsx(BUTTON_BASE, BUTTON_VARIANTS.primary, BUTTON_SIZES.sm)}>
          <LogIn className="size-4" aria-hidden />
          Entrar
        </a>
      </header>
      <main id="conteudo" className={clsx(WRAP, 'pt-6 pb-16 sm:pt-10')}>
        {preview && pending.length > 0 && (
          <p className="mb-6 rounded-xl border border-warn-600/20 bg-warn-50 px-4 py-3 text-sm text-warn-600">
            Pré-visualização. Falta preencher: {pending.join(', ')}. Em produção esta página só vai
            ao ar com tudo preenchido.
          </p>
        )}
        <article className="max-w-3xl">
          <h1 className="text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl">
            {title}
          </h1>
          <p className="mt-3 text-sm text-ink-muted">
            Versão de {LEGAL_VERSION.split('-').reverse().join('/')}
          </p>
          {intro && <div className="mt-5 text-lg leading-8 text-ink-soft">{intro}</div>}
          <div className="mt-8">{children}</div>
        </article>
      </main>
      <footer>
        <LegalFooter preview={preview} mode={mode} />
      </footer>
    </div>
  );
}

/** Uma seção numerada do texto legal. */
export function Secao({
  id,
  titulo,
  children,
}: {
  id: string;
  titulo: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6 border-t border-line py-7 first:border-t-0 first:pt-0">
      <h2 className="text-xl font-semibold tracking-tight">{titulo}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-7 text-ink-soft [&_a]:font-medium [&_a]:text-brand-700 [&_a]:underline [&_li]:pl-1 [&_strong]:text-ink [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}

/** WhatsApp de contato (texto do link com o número). */
export function whatsappContato() {
  return whatsappUrl(SITE);
}
