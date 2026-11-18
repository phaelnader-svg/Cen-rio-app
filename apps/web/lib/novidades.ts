/**
 * Melhoria 110: "Novidades" dentro do sistema. A primeira da lista é a mais recente; quem ainda
 * não viu a primeira vê o ponto no botão. Ao publicar uma versão com mudança visível, acrescentar
 * uma entrada no topo (id novo).
 */
export interface Novidade {
  id: string;
  date: string;
  title: string;
  items: string[];
}

export const NOVIDADES: Novidade[] = [
  {
    id: '2026-11-18-ajustes',
    date: '2026-11-18',
    title: 'Retrabalhos, Receitas e Despesas, gráficos e página da OS',
    items: [
      'Retrabalhos no lugar de Devoluções: escolha o serviço que voltou, o prazo e a retirada. Tudo do retrabalho aparece em vermelho na agenda, nas OS e nos pedidos, com estatística e o gasto no Resumo do financeiro.',
      'Financeiro com as abas Despesas (tudo que foi pago) e Receitas (tudo que entrou), e botões para incluir uma despesa ou receita avulsa.',
      'Produtividade virou item do menu, abaixo de Presença da equipe. Financeiro fica acima de Serviços.',
      'Novo serviço: quando vem de um orçamento, os dados ficam travados. A forma de pagamento é escolhida aqui: à vista (50% na retirada e 50% na entrega) ou parcelado com a taxa da maquininha, que já marca levar a maquininha.',
      'A OS puxa o serviço do tapeceiro e os detalhes do orçamento, sem valores. Tecido e tapeceiro se definem na OS.',
      'Página da OS organizada para a equipe: botão "Abrir OS" no tablet e na OS do painel.',
      'Gráficos no Início (entrou e saiu, peças por etapa e orçamentos), que dá para recolher.',
      'Resumo da semana com mais números (o que saiu, cobranças atrasadas, contas da semana, OS atrasadas, retiradas) e botão Voltar.',
      'Orçamento mais simples: "Quantidade" no lugar de "Quantidade de sofás" e sem os campos do ajudante.',
      'Estoque da oficina com o cadastro e as categorias alinhados.',
    ],
  },
  {
    id: '2026-11-18-fluxo-os',
    date: '2026-11-18',
    title: 'Fluxo da OS, despesas da empresa e prazos em dias úteis',
    items: [
      'Gerar a OS já preenchida com o que veio do pedido e do orçamento, com a foto do orçamento.',
      'Categorias de despesa da própria empresa e aviso das contas que vencem nos próximos dias.',
      'Prazo de entrega em dias úteis, contado do dia da retirada.',
    ],
  },
  {
    id: '2026-11-18-visual',
    date: '2026-11-18',
    title: 'Telas mais limpas e textos mais claros',
    items: [
      'Mais de 40 ajustes de visual e de texto em todo o sistema: nomes iguais em todas as telas ("serviço", "OS", "funcionário"), formulários alinhados e explicações longas recolhidas em "Como usar".',
    ],
  },
  {
    id: '2026-11-melhorias-2',
    date: '2026-11-17',
    title: 'Orçamentos que viram serviço, busca rápida e modo escuro',
    items: [
      'Orçamentos agora têm situação (enviado, aprovado, recusado, sem resposta) e lembrete de cobrar o cliente depois de 3 dias.',
      'Mande o link da proposta pelo WhatsApp: o cliente abre no celular e aprova com um toque.',
      'Orçamento aprovado vira serviço com um clique em "Fechar serviço", já preenchido.',
      'Funil de vendas: quantos orçamentos viraram pedido e por que os outros não fecharam.',
      'Busca rápida: aperte Ctrl+K (ou /) e encontre cliente, pedido, OS, orçamento ou retirada.',
      'Atalhos: N abre um novo serviço e ? mostra todos os atalhos.',
      'Modo escuro: escolha no botão da lua, no topo da tela.',
      'Lixeira: orçamentos e fotos apagados ficam 30 dias para recuperar.',
      'Álbum de fotos da OS (antes, durante e depois) com link para mandar ao cliente.',
      'Link para o cliente escolher o dia e o turno da retirada.',
      'Botão "Enviar sugestão ou problema" com o print da tela, no menu lateral.',
      'Verificação em duas etapas opcional em Minha conta.',
      'Baixar todos os dados da empresa e importar clientes e preços de uma planilha.',
    ],
  },
];

export const NOVIDADES_KEY = 'cenario.novidades.vista';
