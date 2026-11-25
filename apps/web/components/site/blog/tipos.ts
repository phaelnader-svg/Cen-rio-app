/** Um artigo do blog. Cada artigo é um arquivo em components/site/blog/artigos/. */
export interface Artigo {
  /** Endereço: /blog/<slug> (letras minúsculas, números e hífens). */
  slug: string;
  titulo: string;
  /** Uma ou duas frases: aparece na lista, no Google e na prévia do WhatsApp (até ~160 letras). */
  resumo: string;
  autor: string;
  /** AAAA-MM-DD */
  publicadoEm: string;
  /** AAAA-MM-DD, quando o artigo for corrigido depois de publicado. */
  atualizadoEm?: string;
  /** Imagem de capa em /public/blog-img/<slug>/ (opcional); imagens do texto também ficam lá. */
  capa?: { src: string; alt: string; width: number; height: number };
  /** Texto em Markdown simples: ## e ### títulos, listas, **negrito**, *itálico*, [link](...), > citação, ![imagem](...). */
  corpo: string;
  /** Rascunho: só aparece no ambiente de desenvolvimento (prints), nunca em homologação ou produção. */
  rascunho?: boolean;
}
