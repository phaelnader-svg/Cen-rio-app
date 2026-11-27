/** Blog público: rascunhos fora do site, links de WhatsApp marcados com a origem, Markdown seguro. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  TODOS_OS_ARTIGOS,
  artigosPublicados,
  blogOrigemDe,
  slugValido,
} from '../components/site/blog/artigos';
import { BlogArticle, articleJsonLd, blogHref } from '../components/site/blog/blog';
import { Markdown } from '../components/site/blog/markdown';
import { SITE, whatsappMessage, whatsappUrl } from '../components/site/config';

const PROD = { NODE_ENV: 'production' };

describe('artigos', () => {
  it('slugs válidos e sem repetição; datas no formato AAAA-MM-DD; resumo curto', () => {
    const slugs = TODOS_OS_ARTIGOS.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const a of TODOS_OS_ARTIGOS) {
      expect(slugValido(a.slug), a.slug).toBe(true);
      expect(a.publicadoEm).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(a.resumo.length, a.slug).toBeLessThanOrEqual(200);
      if (a.capa) expect(a.capa.src.startsWith(`/blog-img/${a.slug}/`)).toBe(true);
    }
  });

  it('rascunhos nunca aparecem em produção (nem na homologação)', () => {
    expect(artigosPublicados(PROD).some((a) => a.rascunho)).toBe(false);
    expect(artigosPublicados({ NODE_ENV: 'development' }).length).toBe(TODOS_OS_ARTIGOS.length);
  });
});

describe('WhatsApp vindo do blog', () => {
  it('a mensagem pronta diz que veio do blog e de qual artigo', () => {
    expect(whatsappMessage(SITE)).toBe(SITE.whatsappMessage);
    expect(whatsappMessage(SITE, { blog: true })).toMatch(/^Olá! Vim pelo blog\./);
    expect(whatsappMessage(SITE, { blog: true, artigo: 'Fila da oficina' })).toBe(
      'Olá! Vim pelo blog, do artigo "Fila da oficina". Quero conhecer o Cenário Gestão.',
    );
    expect(decodeURIComponent(whatsappUrl(SITE, { blog: true })!)).toContain('Vim pelo blog');
  });

  it('todo link de WhatsApp da página do artigo é marcado', () => {
    const a = TODOS_OS_ARTIGOS[0]!;
    const html = renderToStaticMarkup(<BlogArticle a={a} preview />);
    const links = [...html.matchAll(/<a [^>]*href="(https:\/\/wa\.me\/[^"]+)"[^>]*>/g)];
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const [tag, href] of links) {
      expect(decodeURIComponent(href!.replace(/&amp;/g, '&'))).toContain('Vim pelo blog');
      expect(tag).toContain(`data-origem="blog:${a.slug}"`);
    }
    expect(html).toContain(blogHref(a.slug).replace(/&/g, '&amp;'));
  });

  it('a página principal só usa o título de um artigo que existe (nada vem escrito pela URL)', () => {
    const a = TODOS_OS_ARTIGOS[0]!;
    expect(blogOrigemDe({})).toBeNull();
    expect(blogOrigemDe({ utm_source: 'google' })).toBeNull();
    expect(blogOrigemDe({ utm_source: 'blog' })).toEqual({});
    expect(blogOrigemDe({ utm_source: 'blog', utm_campaign: 'Me liga <script>' })).toEqual({});
    expect(blogOrigemDe({ utm_source: 'blog', utm_campaign: a.slug })).toEqual({
      slug: a.slug,
      titulo: a.titulo,
    });
  });
});

describe('texto dos artigos', () => {
  it('Markdown vira títulos, listas e links; link perigoso vira texto', () => {
    const html = renderToStaticMarkup(
      <Markdown
        source={
          '## Título\n\nTexto com **negrito** e [ok](/blog) e [mal](javascript:alert(1)).\n\n- um\n- dois\n\n1. a\n2. b\n\n> citação\n\n<script>x</script>'
        }
      />,
    );
    expect(html).toContain('<h2');
    expect(html).toContain('<strong>negrito</strong>');
    expect(html).toContain('href="/blog"');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<ul');
    expect(html).toContain('<ol');
    expect(html).toContain('<blockquote');
    expect(html).not.toContain('<script>');
  });

  it('dados estruturados do artigo (BlogPosting)', () => {
    const a = TODOS_OS_ARTIGOS[0]!;
    expect(articleJsonLd(a)).toMatchObject({
      '@type': 'BlogPosting',
      headline: a.titulo,
      author: { name: a.autor },
      url: `https://cenariogestao.com.br/blog/${a.slug}`,
    });
  });
});
