/**
 * LGPD (2026-11-25): textos legais, rodapé com os dados da empresa, consentimento de cookies e
 * contraste. Mesmo estilo dos demais testes do web: sem navegador, pelo HTML e pelo código-fonte.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { LEGAL, legalPending } from '@cenario/shared';
import { describe, expect, it } from 'vitest';
import { Landing } from '../components/site/landing';
import { LegalFooter } from '../components/site/legal/legal';

const src = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');

describe('dados legais da empresa', () => {
  it('nada inventado: sem os dados do dono, tudo fica pendente', () => {
    // Quando o Raphael mandar os dados, este teste muda junto com o LEGAL.
    expect(LEGAL.razaoSocial).toBeNull();
    expect(LEGAL.cnpj).toBeNull();
    expect(legalPending()).toEqual([
      'Razão social',
      'CNPJ',
      'Endereço',
      'E-mail do encarregado de dados',
      'Cidade do foro',
    ]);
  });

  it('o rodapé mostra razão social, CNPJ, endereço e os links das políticas', () => {
    const html = renderToStaticMarkup(<LegalFooter preview mode="preview" />);
    for (const t of ['razão social', 'CNPJ', 'endereço', 'e-mail do encarregado'])
      expect(html).toContain(`[PREENCHER: ${t}]`);
    for (const href of ['/privacidade', '/termos', '/reembolso', '/privacidade/pedido'])
      expect(html).toContain(`href="${href}"`);
  });

  it('em produção com dados faltando, nada de rodapé legal pela metade', () => {
    expect(renderToStaticMarkup(<LegalFooter preview={false} mode="off" />)).toBe('');
    expect(renderToStaticMarkup(<Landing preview={false} legal="off" />)).not.toContain(
      'rodape-legal',
    );
  });

  it('as páginas legais só abrem em produção com tudo preenchido (ou na homologação)', () => {
    const legal = src('components/site/legal/legal.tsx');
    expect(legal).toMatch(/legalPending\(\)\.length === 0\) return 'live'/);
    expect(legal).toMatch(
      /isHomologHost\(\(await headers\(\)\)\.get\('host'\)\) \? 'preview' : 'off'/,
    );
    for (const p of ['privacidade', 'termos', 'reembolso', 'privacidade/pedido'])
      expect(src(`app/(site)/${p}/page.tsx`)).toMatch(/legalMode\(\)\) === 'off'\) notFound\(\)/);
  });
});

describe('cookies e Google Analytics', () => {
  it('a página não traz nenhum script do Google no HTML: ele só carrega depois do aceite', () => {
    const html = renderToStaticMarkup(<Landing preview={false} legal="live" />);
    expect(html).not.toContain('googletagmanager');
    expect(html).not.toContain('gtag(');
    const consent = src('components/site/consent.tsx');
    expect(consent).toMatch(/if \(v === 'aceito'\) loadAnalytics\(safe\)/);
    expect(consent).toMatch(/allow_ad_personalization_signals: false/);
  });

  it('Recusar tem o mesmo peso de Aceitar (mesmo estilo de botão)', () => {
    const consent = src('components/site/consent.tsx');
    const styles = [
      ...consent.matchAll(/onClick=\{\(\) => choose\('(\w+)'\)\}\s+className=\{([^}]+\})/g),
    ];
    expect(styles.map((m) => m[1])).toEqual(['recusado', 'aceito']);
    expect(styles[0]![2]).toBe(styles[1]![2]);
  });
});

describe('acessibilidade', () => {
  it('a landing tem o atalho "Pular para o conteúdo" e o conteúdo principal marcado', () => {
    const html = renderToStaticMarkup(<Landing preview={false} legal="live" />);
    expect(html).toContain('href="#conteudo"');
    expect(html).toContain('<main id="conteudo"');
    expect(html).toContain('Chamar no WhatsApp');
  });

  it('toda imagem da landing tem texto alternativo (ou é decorativa e escondida)', () => {
    const html = renderToStaticMarkup(<Landing preview={false} legal="live" />);
    for (const [tag] of html.matchAll(/<img [^>]*>/g)) {
      expect(tag).toMatch(/alt="/);
      if (/alt=""/.test(tag)) expect(tag).toContain('aria-hidden');
    }
  });

  it('o cinza dos textos de apoio passa no contraste mínimo (4,5:1) sobre os fundos claros', () => {
    const css = src('app/globals.css');
    const hex = (name: string) => new RegExp(`--color-${name}: (#[0-9a-f]{6})`).exec(css)![1]!;
    const lum = (h: string) => {
      const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
      const f = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
    };
    const ratio = (a: string, b: string) => {
      const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
      return (x! + 0.05) / (y! + 0.05);
    };
    for (const bg of ['canvas', 'surface', 'subtle'])
      expect(ratio(hex('ink-muted'), hex(bg))).toBeGreaterThanOrEqual(4.5);
  });
});
