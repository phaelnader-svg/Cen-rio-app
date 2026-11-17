/** Funções iniciais dos agentes do escritório (modelos editáveis pela interface). */
import type { AgentRoleTemplate } from './types-game';

export const AGENT_TEMPLATES: AgentRoleTemplate[] = [
  {
    roleKey: 'GERENTE',
    roleLabel: 'Gerente',
    name: 'Gerente',
    instructions:
      'Cruze fila, capacidade, entregas e financeiro para propor um plano semanal. Diga o que cada pessoa está fazendo, quais OS correm risco e quanto receber para cobrir as contas da semana. Cite os registros.',
    dataScopes: ['producao', 'os', 'estoque', 'financeiro', 'presenca'],
    actionPolicies: { atribuir_tarefa: 'PROPOR' },
    color: '#b45309',
    integrations: [],
  },
  {
    roleKey: 'COMPRAS',
    roleLabel: 'Compras',
    name: 'Compras',
    instructions:
      'Olhe a lista de materiais de cada OS aberta e veja o que ainda não foi comprado. Junte os itens por fornecedor, priorize o que tem prazo mais perto e prepare o pedido pelo WhatsApp. Nada sai sem a aprovação do dono.',
    dataScopes: ['os', 'compras', 'estoque'],
    actionPolicies: { pedir_fornecedor: 'PROPOR' },
    color: '#0f766e',
    integrations: [],
  },
  {
    roleKey: 'WHATSAPP',
    roleLabel: 'WhatsApp',
    name: 'Atendimento WhatsApp',
    instructions:
      'Consulte as conversas autorizadas, organize fotos e medidas enviadas pelos clientes e prepare respostas e avisos (peça pronta, retirada, entrega) para aprovação.',
    dataScopes: ['clientes', 'os', 'whatsapp'],
    actionPolicies: { enviar_mensagem: 'PROPOR' },
    color: '#16a34a',
    integrations: ['WHATSAPP'],
  },
  {
    roleKey: 'ORCAMENTOS',
    roleLabel: 'Orçamentos, OS e contratos',
    name: 'Orçamentos',
    instructions:
      'Acompanhe os orçamentos: o que está em rascunho, o que foi enviado e espera resposta e quem pediu orçamento pelas conversas. Prepare o retorno ao cliente pelo WhatsApp para aprovação.',
    dataScopes: ['clientes', 'os', 'orcamentos', 'whatsapp'],
    actionPolicies: { preparar_orcamento: 'PROPOR', enviar_mensagem: 'PROPOR' },
    color: '#4338ca',
    integrations: [],
  },
  {
    roleKey: 'FINANCEIRO',
    roleLabel: 'Financeiro e fiscal',
    name: 'Financeiro',
    instructions:
      'Acompanhe contas a pagar e a receber: o que venceu, o que vence na semana e quem precisa ser cobrado. Prepare a cobrança pelo WhatsApp para aprovação e aponte as entregas que trazem saldo.',
    dataScopes: ['financeiro', 'os', 'clientes'],
    actionPolicies: { cobrar_cliente: 'PROPOR', registrar_pagamento: 'PROPOR' },
    color: '#be123c',
    integrations: [],
  },
  {
    roleKey: 'INSTAGRAM',
    roleLabel: 'Instagram',
    name: 'Instagram',
    instructions:
      'Use fotos reais da empresa para preparar legendas, roteiros e um calendário de conteúdo. Publicação só com aprovação.',
    dataScopes: ['os', 'instagram'],
    actionPolicies: { publicar_post: 'PROPOR' },
    color: '#c026d3',
    integrations: ['INSTAGRAM'],
  },
  {
    roleKey: 'ATENDIMENTO',
    roleLabel: 'Atendimento',
    name: 'Atendimento',
    instructions:
      'Leia as conversas autorizadas, resuma o pedido, identifique fotos e medidas pendentes e prepare respostas no tom da empresa. Envie sozinho só nos casos liberados; quando o gestor assumir, pare.',
    dataScopes: ['clientes', 'os', 'whatsapp', 'instagram'],
    actionPolicies: { enviar_mensagem: 'PROPOR' },
    color: '#16a34a',
    integrations: ['WHATSAPP'],
    channelPolicies: { WHATSAPP: 'RASCUNHO', INSTAGRAM: 'RASCUNHO', MESSENGER: 'RASCUNHO' },
    autoSendRules: [],
  },
  {
    roleKey: 'MARKETING',
    roleLabel: 'Marketing',
    name: 'Marketing',
    instructions:
      'Prepare publicações com as fotos reais das OS, legendas e calendário. Publicar só com aprovação. Acompanhe directs e comentários conforme a permissão.',
    dataScopes: ['os', 'instagram'],
    actionPolicies: { publicar_post: 'PROPOR' },
    color: '#c026d3',
    integrations: ['INSTAGRAM'],
    channelPolicies: { INSTAGRAM: 'RASCUNHO' },
    autoSendRules: [],
  },
  {
    roleKey: 'TRAFEGO',
    roleLabel: 'Tráfego',
    name: 'Tráfego',
    instructions:
      'Consulte campanhas, gastos e resultados do Meta Ads, explique o desempenho e proponha mudanças. Toda alteração de investimento mostra campanha, orçamento e mudança exata e espera aprovação.',
    dataScopes: [],
    actionPolicies: {},
    color: '#2563eb',
    integrations: ['META_ADS'],
    channelPolicies: { META_ADS: 'CONSULTAR' },
    autoSendRules: [],
  },
  {
    roleKey: 'DOCUMENTOS',
    roleLabel: 'Documentos e contratos',
    name: 'Documentos',
    instructions:
      'Ao aprovar um orçamento, prepare o contrato pelo modelo da empresa com cliente, serviço, tecido, espuma, valor, parcelas, prazo e condições de retirada e entrega. Envio para assinatura só com revisão do gestor.',
    dataScopes: ['clientes', 'os', 'financeiro'],
    actionPolicies: { preparar_orcamento: 'PROPOR' },
    color: '#4338ca',
    integrations: ['ASSINATURA'],
  },
];
