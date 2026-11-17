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
    id: '2026-11-melhorias-2',
    date: '2026-11-17',
    title: 'Orçamentos que viram serviço, busca rápida e modo escuro',
    items: [
      'Orçamentos agora têm situação (enviado, aprovado, recusado, sem resposta) e lembrete de cobrar o cliente depois de 3 dias.',
      'Mande o link da proposta pelo WhatsApp: o cliente abre no celular e aprova com um toque.',
      'Orçamento aprovado vira serviço com um clique em "Fechar serviço", já preenchido.',
      'Funil de vendas: quantos orçamentos viraram pedido e por que os outros não fecharam.',
      'Busca rápida: aperte Ctrl+K (ou /) e encontre cliente, pedido, O.S., orçamento ou retirada.',
      'Atalhos: N abre um novo serviço e ? mostra todos os atalhos.',
      'Modo escuro: escolha no botão da lua, no topo da tela.',
      'Lixeira: orçamentos e fotos apagados ficam 30 dias para recuperar.',
      'Álbum de fotos da O.S. (antes, durante e depois) com link para mandar ao cliente.',
      'Link para o cliente escolher o dia e o turno da retirada.',
      'Botão "Enviar sugestão ou problema" com o print da tela, no menu lateral.',
      'Verificação em duas etapas opcional em Minha conta.',
      'Baixar todos os dados da empresa e importar clientes e preços de uma planilha.',
    ],
  },
];

export const NOVIDADES_KEY = 'cenario.novidades.vista';
