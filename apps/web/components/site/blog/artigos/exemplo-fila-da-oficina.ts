import type { Artigo } from '../tipos';

/**
 * RASCUNHO de exemplo, só para os prints do blog. Nunca aparece em homologação nem em produção.
 * Pode ser apagado quando o primeiro artigo de verdade for publicado.
 */
export const artigo: Artigo = {
  slug: 'exemplo-fila-da-oficina',
  titulo: 'Qual peça sai primeiro? Como organizar a fila da oficina',
  resumo:
    'Um jeito simples de decidir a ordem do trabalho na tapeçaria, sem depender da memória de ninguém. (Artigo de exemplo.)',
  autor: 'Autor do exemplo',
  publicadoEm: '2026-11-25',
  rascunho: true,
  corpo: `Este é um **artigo de exemplo**, feito só para mostrar como o blog fica. O texto de verdade vem do PDF que vocês mandarem.

## O problema de sempre

Toda tapeçaria conhece a cena: o cliente liga perguntando da poltrona, ninguém sabe dizer em que pé ela está, e a peça que era para ontem ainda está esperando tecido.

## Três perguntas para começar o dia

1. Qual peça tem o prazo mais perto?
2. O material dela já chegou?
3. Quem vai fazer?

Se as três respostas estiverem anotadas num lugar só, a fila praticamente se organiza sozinha.

## O que ajuda no dia a dia

- Deixar a fila de cada tapeceiro à vista, na ordem.
- Marcar na hora quando falta material.
- Avisar o cliente quando a peça fica pronta.

> Organizar a fila não é trabalhar mais: é parar de procurar informação.

Quer ver como o [Cenário Gestão](/) faz isso? Chame a gente no WhatsApp pelo botão abaixo.`,
};
