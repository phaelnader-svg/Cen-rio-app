/** Funções iniciais dos agentes do escritório (modelos editáveis pela interface). */
import type { AgentRoleTemplate } from '@cenario/shared';

export const AGENT_TEMPLATES: AgentRoleTemplate[] = [
  {
    roleKey: 'GERENTE',
    roleLabel: 'Gerente',
    name: 'Gerente',
    instructions:
      'Cruze fila, capacidade, materiais, entregas e financeiro para propor um plano semanal. Diga o que cada pessoa está fazendo, quais OS correm risco, o que comprar e quanto receber para cobrir as contas da semana. Cite os registros.',
    dataScopes: ['producao', 'os', 'estoque', 'compras', 'financeiro', 'presenca'],
    actionPolicies: { atribuir_tarefa: 'PROPOR', criar_compra: 'PROPOR' },
    color: '#b45309',
    integrations: [],
  },
  {
    roleKey: 'COMPRAS',
    roleLabel: 'Compras',
    name: 'Compras',
    instructions:
      'Reúna as faltas de material e priorize as compras que liberam OS ou evitam atraso. Nunca confirme pedido: proponha e deixe o gestor aprovar.',
    dataScopes: ['compras', 'estoque', 'os', 'producao'],
    actionPolicies: { criar_compra: 'PROPOR', reservar_estoque: 'PROPOR' },
    color: '#0f766e',
    integrations: [],
  },
  {
    roleKey: 'WHATSAPP',
    roleLabel: 'WhatsApp',
    name: 'Atendimento WhatsApp',
    instructions:
      'Consulte as conversas autorizadas, organize fotos e medidas enviadas pelos clientes e prepare respostas e seguimentos para aprovação.',
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
      'Use o padrão da Cenário para preparar orçamentos e reaproveite o que o cliente aprovou para montar a OS e o contrato.',
    dataScopes: ['clientes', 'os'],
    actionPolicies: { preparar_orcamento: 'PROPOR' },
    color: '#4338ca',
    integrations: ['MODELO_ORCAMENTO'],
  },
  {
    roleKey: 'FINANCEIRO',
    roleLabel: 'Financeiro e fiscal',
    name: 'Financeiro',
    instructions:
      'Acompanhe contas e recebimentos e prepare os dados para emissão de nota pelo sistema fiscal integrado.',
    dataScopes: ['financeiro', 'os', 'fiscal'],
    actionPolicies: { registrar_pagamento: 'PROPOR', emitir_nota: 'PROPOR' },
    color: '#be123c',
    integrations: ['FISCAL'],
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
];

