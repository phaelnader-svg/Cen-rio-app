/**
 * Reformulação por REMOÇÃO REAL — catálogo da S0 (docs/REFORMULACAO-REMOCAO-REAL-AUDITORIA-E-PLANO.md).
 *
 * Cada entrada diz em que ETAPA (S1–S8) a rota/permissão/interruptor/tela deixa de existir. Os testes do
 * Grupo B leem este catálogo: enquanto a etapa não estiver em `tests/remocao/etapas-concluidas.json`, o
 * teste roda como "falha esperada" (`it.fails`) — prova que o requisito AINDA não está atendido, sem
 * quebrar a regressão. Quando a etapa for concluída e registrada no JSON, o mesmo teste passa a ser
 * obrigatório. O Grupo A (o que FICA) é sempre obrigatório.
 *
 * Critério de "removido" de uma rota: sem sessão, com origem permitida, ela responde 404 "Rota não
 * encontrada." (o 404 do Fastify). Uma rota que existe responde 401/403 antes de qualquer lógica.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Etapa = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8';
export const ROOT = join(__dirname, '../../../..');

export function etapasConcluidas(): Set<Etapa> {
  const j = JSON.parse(
    readFileSync(join(ROOT, 'tests/remocao/etapas-concluidas.json'), 'utf8'),
  ) as {
    concluidas: Etapa[];
  };
  return new Set(j.concluidas);
}

const U = '00000000-0000-4000-8000-000000000000'; // id fictício para rotas com parâmetro

type Rota = readonly [metodo: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string];

/** Rotas que devem DEIXAR DE EXISTIR (404), por etapa. */
export const ROTAS_REMOVIDAS: Record<Etapa, readonly Rota[]> = {
  // S1 — embalagem obrigatória (e a prontidão de retorno, que só existe por causa dela)
  S1: [
    ['GET', '/api/v1/packaging'],
    ['GET', `/api/v1/packaging/${U}`],
    ['POST', `/api/v1/packaging/${U}/assign`],
    ['POST', `/api/v1/packaging/${U}/complete`],
    ['GET', '/api/v1/system/rollback-readiness'],
  ],
  // S2 — prontidão e bloqueios por material
  S2: [
    ['GET', '/api/v1/material-readiness'],
    ['GET', `/api/v1/service-orders/${U}/material-readiness`],
    ['PUT', `/api/v1/production-tasks/${U}/materials`],
    ['POST', `/api/v1/service-orders/${U}/materials`],
    ['DELETE', `/api/v1/service-orders/${U}/materials/${U}`],
  ],
  // S3 — medições formais, solicitações, aprovações e previsões de material
  S3: [
    ['GET', '/api/v1/measurements'],
    ['POST', '/api/v1/measurements'],
    ['GET', '/api/v1/measurements/awaiting'],
    ['GET', '/api/v1/measurements/mine'],
    ['POST', `/api/v1/measurements/${U}/submit`],
    ['POST', `/api/v1/measurements/${U}/request/approve`],
    ['POST', `/api/v1/material-requirements/${U}/cancel`],
    ['GET', `/api/v1/orders/${U}/material-forecasts`],
    ['POST', `/api/v1/orders/${U}/items/${U}/material-forecasts`],
    ['PUT', `/api/v1/material-forecasts/${U}`],
    ['GET', '/api/v1/materials/consolidated'],
    ['GET', '/api/v1/materials/planning'],
  ],
  // S4 — compras, fornecedores, recebimento formal, estoque formal e reservas (o estoque SIMPLES fica: D2)
  S4: [
    ['GET', '/api/v1/suppliers'],
    ['POST', '/api/v1/suppliers'],
    ['GET', '/api/v1/purchasing/needs'],
    ['GET', '/api/v1/purchasing/shortages'],
    ['GET', '/api/v1/purchasing/receiving'],
    ['GET', '/api/v1/purchase-orders'],
    ['POST', '/api/v1/purchase-orders'],
    ['POST', `/api/v1/purchase-orders/${U}/confirm`],
    ['GET', '/api/v1/material-receipts'],
    ['POST', '/api/v1/material-receipts'],
    ['GET', '/api/v1/material-receipts/pending'],
    ['GET', '/api/v1/material-arrivals'],
    ['POST', `/api/v1/arrivals/purchase-orders/${U}/confirm`],
    ['GET', '/api/v1/stock-items'],
    ['POST', `/api/v1/stock-items/${U}/issue`],
    ['GET', '/api/v1/stock-movements'],
    ['GET', '/api/v1/stock-reservations'],
    ['POST', '/api/v1/stock-reservations'],
    ['GET', '/api/v1/material-leftovers'],
    // A conciliação da lista simples com o custo formal (financeiro) FICA: também vale para
    // lançamentos do financeiro, que não saem com Compras.
  ],
  // S5 — OS no fechamento: o módulo formal de recebimentos sai (D1)
  S5: [
    ['GET', '/api/v1/receipts/pending'],
    ['POST', '/api/v1/receipts'],
    ['POST', `/api/v1/receipt-lines/${U}/corrections`],
    ['POST', `/api/v1/arrivals/pickups/${U}/confirm`],
  ],
  // S6 — logística: retiradas, entregas agendadas, roteiro, ocorrências, equipe e custos de viagem
  S6: [
    ['GET', '/api/v1/pickups'],
    ['POST', '/api/v1/pickups'],
    ['POST', `/api/v1/pickups/${U}/transition`],
    ['POST', '/api/v1/deliveries'],
    ['POST', `/api/v1/deliveries/${U}/confirm`],
    ['POST', `/api/v1/deliveries/${U}/depart`],
    ['POST', `/api/v1/deliveries/${U}/complete`],
    ['GET', '/api/v1/logistics/people'],
    ['GET', '/api/v1/logistics/jobs'],
    ['GET', '/api/v1/logistics/route'],
    ['PUT', '/api/v1/logistics/route/sequence'],
    ['POST', '/api/v1/logistics-occurrences'],
    ['GET', '/api/v1/company/own-team'],
    ['GET', '/api/v1/finance/trip-costs'],
    ['POST', '/api/v1/finance/trip-costs/free'],
    ['GET', '/api/v1/finance/logistics-defaults'],
    ['POST', '/api/v1/finance/logistics-costs'],
    // Interruptores: com a logística mantida, o interruptor 'logistica' e suas rotas ficam até a S6.
    ['GET', '/api/v1/modules'],
    ['GET', '/api/company/modules'],
    ['PUT', '/api/company/modules/materiais'],
  ],
  // S7 — pedidos de ajuda (D3: remoção completa)
  S7: [
    ['GET', '/api/v1/help-requests'],
    ['POST', '/api/v1/help-requests'],
    ['GET', '/api/v1/help-requests/mine'],
    ['POST', `/api/v1/help-requests/${U}/assign`],
  ],
  S8: [],
};

/** Rotas que FICAM (Grupo A): sem sessão devem responder 401/403 — nunca 404. */
export const ROTAS_MANTIDAS: readonly Rota[] = [
  ['GET', '/api/v1/customers'],
  ['POST', '/api/v1/services'],
  ['GET', '/api/v1/orders'],
  ['GET', '/api/v1/service-orders'],
  ['GET', `/api/v1/service-orders/${U}`],
  ['PUT', `/api/v1/service-orders/${U}/items/${U}/measurements`], // medidas técnicas opcionais (D8)
  ['GET', `/api/v1/service-orders/${U}/material-list`], // lista simples de materiais
  ['PATCH', `/api/v1/service-orders/${U}/material-list/${U}`],
  ['GET', `/api/v1/service-orders/${U}/direct-delivery`], // entrega direta na OS
  ['POST', `/api/v1/service-orders/${U}/deliver`],
  ['POST', `/api/v1/service-orders/${U}/direct-delivery/revert`],
  ['GET', '/api/v1/inventory/items'], // estoque simples (D2)
  ['POST', `/api/v1/inventory/items/${U}/adjust`],
  ['GET', '/api/v1/inventory/adjustments'],
  ['GET', '/api/v1/workshop-map'], // mapa da oficina (D7)
  ['POST', `/api/v1/pieces/${U}/move`],
  ['GET', '/api/v1/returns'], // devoluções pós-entrega (D4)
  ['POST', '/api/v1/returns'],
  ['GET', '/api/v1/production-plans'],
  ['GET', '/api/v1/production-tasks/mine'],
  ['POST', `/api/v1/production-tasks/${U}/start`],
  ['POST', `/api/v1/production-tasks/${U}/pause`],
  ['POST', `/api/v1/production-tasks/${U}/resume`],
  ['POST', `/api/v1/production-tasks/${U}/complete`],
  ['GET', '/api/v1/quality/inspections'],
  ['POST', `/api/v1/quality/inspections/${U}/approve`],
  ['GET', '/api/v1/finance/dashboard'],
  ['GET', '/api/v1/finance/receivables'],
  ['GET', '/api/v1/finance/payables'],
  ['GET', '/api/v1/finance/weekly-closings'],
  ['GET', '/api/v1/finance/productivity'],
  ['GET', `/api/v1/service-orders/${U}/timeline`], // histórico (leitura)
  ['GET', '/api/audit'],
];

/** Permissões que devem sair do catálogo, por etapa (D2: estoque.ver/gerenciar FICAM no estoque simples). */
export const PERMISSOES_REMOVIDAS: Record<Etapa, readonly string[]> = {
  S1: [],
  S2: [],
  S3: ['medicoes.gerenciar', 'medicoes.extraordinarias', 'materiais.ver', 'materiais.aprovar'],
  S4: [
    'compras.ver',
    'compras.gerenciar',
    'compras.aprovar',
    'estoque.conferir',
    'estoque.autorizar',
  ],
  S5: ['recebimentos.registrar'],
  S6: ['retiradas.ver', 'retiradas.gerenciar', 'logistica.executar'],
  S7: ['ajuda.solicitar'],
  S8: [],
};
export const PERMISSOES_MANTIDAS = [
  'clientes.ver',
  'pedidos.gerenciar',
  'os.ver',
  'os.gerenciar',
  'producao.executar',
  'producao.planejar',
  'qualidade.gerenciar',
  'entregas.gerenciar', // marcar como entregue / desfazer na OS
  'devolucoes.gerenciar',
  'estoque.ver', // estoque simples (D2)
  'estoque.gerenciar',
  'financeiro.ver',
  'financeiro.gerenciar',
] as const;

/** Interruptores que devem desaparecer (nenhum interruptor operacional fica). */
export const INTERRUPTORES_REMOVIDOS: Record<Etapa, readonly string[]> = {
  S1: ['embalagem'],
  S2: ['materiais'],
  S3: [],
  S4: [],
  S5: [],
  S6: ['logistica'],
  S7: ['ajuda'],
  S8: [],
};
