/**
 * Remediação pós-auditoria, Rodada 4 — travas estruturais contra regressão.
 * IDs: F1-07b (nenhuma permissão enfraquecida), F1-12b (endpoints antigos mantidos), F1-13
 * (nenhuma tela removida, nenhum dado excluído), F7-16 (a interface não define a natureza
 * jurídica do trabalho) e F10-01 (parte da API: "Recebimento de materiais" sem filtro no menu).
 * A estrutura do menu (F10-01) é provada no pacote web: apps/web/test/rodada4-menu.test.ts.
 *
 * Linha de base = commit auditado 9fb1786. Os dados abaixo foram extraídos UMA vez daquele commit
 * (fonte, git ls-tree e o routeCatalog do app de 9fb1786 construído em memória) e ficam gravados
 * aqui: o teste não consulta git em tempo de execução.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ALL_PERMISSIONS, DEFAULT_ROLES, type Permission } from '@cenario/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { loadUserPermissions } from '../src/core/permissions';
import type { AccessRule } from '../src/core/types';
import { panelUserWith } from './commercial-helpers';
import {
  ADMIN,
  type Client,
  createTestApp,
  db,
  idemKey,
  loginAdmin,
  resetDatabase,
} from './helpers';

const ROOT = resolve(__dirname, '../../..');

// ── Linha de base gerada UMA VEZ a partir de 9fb1786 (não depende de git em tempo de execução) ──
/** ALL_PERMISSIONS em 9fb1786 (packages/shared/src/permissions.ts). */
const BASELINE_PERMISSIONS = [
  'painel.acessar',
  'producao.acessar',
  'funcionarios.ver',
  'funcionarios.gerenciar',
  'funcoes.ver',
  'funcoes.gerenciar',
  'dispositivos.ver',
  'dispositivos.gerenciar',
  'sessoes.ver',
  'sessoes.revogar',
  'empresa.ver',
  'empresa.configurar',
  'clientes.ver',
  'clientes.gerenciar',
  'pedidos.ver',
  'pedidos.gerenciar',
  'pedidos.valores',
  'pedidos.cancelar',
  'retiradas.ver',
  'retiradas.gerenciar',
  'recebimentos.registrar',
  'os.ver',
  'os.gerenciar',
  'medicoes.extraordinarias',
  'medicoes.gerenciar',
  'materiais.ver',
  'materiais.aprovar',
  'compras.ver',
  'compras.gerenciar',
  'compras.aprovar',
  'estoque.ver',
  'estoque.gerenciar',
  'estoque.autorizar',
  'producao.ver',
  'producao.planejar',
  'producao.executar',
  'ajuda.solicitar',
  'ocorrencias.registrar',
  'ocorrencias.ver',
  'ocorrencias.gerenciar',
  'qualidade.inspecionar',
  'qualidade.gerenciar',
  'entregas.ver',
  'entregas.gerenciar',
  'logistica.executar',
  'devolucoes.gerenciar',
  'presenca.registrar',
  'presenca.ver',
  'presenca.gerenciar',
  'financeiro.ver',
  'financeiro.gerenciar',
  'financeiro.ajustes',
  'financeiro.producao_propria',
  'auditoria.ver',
  'sincronizacao.diagnosticar',
] as const;
/** DEFAULT_ROLES em 9fb1786: chave da função → permissões. */
const BASELINE_ROLES: Record<string, readonly string[]> = {
  gestor: BASELINE_PERMISSIONS,
  tapeceiro: [
    'producao.acessar',
    'producao.executar',
    'recebimentos.registrar',
    'ocorrencias.registrar',
    'ajuda.solicitar',
    'presenca.registrar',
    'sincronizacao.diagnosticar',
    'financeiro.producao_propria',
  ],
  cabeceiras_qualidade: [
    'producao.acessar',
    'producao.executar',
    'recebimentos.registrar',
    'qualidade.inspecionar',
    'ocorrencias.registrar',
    'ajuda.solicitar',
    'presenca.registrar',
    'sincronizacao.diagnosticar',
  ],
  ajudante: [
    'producao.acessar',
    'producao.executar',
    'recebimentos.registrar',
    'ocorrencias.registrar',
    'presenca.registrar',
    'sincronizacao.diagnosticar',
  ],
  logistica_terceirizada: ['producao.acessar', 'logistica.executar', 'financeiro.producao_propria'],
};
/**
 * Rotas de 9fb1786: varredura de app.get/post/put/patch/delete('…') em apps/api/src (381), com a
 * regra de acesso efetiva lida do routeCatalog do app daquele commit. null = rota só registrada
 * com ENABLE_TEST_CLOCK (relógio do E2E), fora do catálogo do app padrão.
 */
const BASELINE_ROUTES: Record<string, AccessRule | null> = {
  'DELETE /api/devices/:id': { session: 'WEB', permissions: ['dispositivos.gerenciar'] },
  'DELETE /api/employees/:id/admin-access': {
    session: 'WEB',
    permissions: ['funcionarios.gerenciar'],
  },
  'DELETE /api/employees/:id/photo': { session: 'WEB', permissions: ['funcionarios.gerenciar'] },
  'DELETE /api/employees/:id/pin': { session: 'WEB', permissions: ['funcionarios.gerenciar'] },
  'DELETE /api/roles/:id': { session: 'WEB', permissions: ['funcoes.gerenciar'] },
  'DELETE /api/v1/attachments/:id': { session: 'any' },
  'DELETE /api/v1/customers/:id/addresses/:addressId': {
    session: 'WEB',
    permissions: ['clientes.gerenciar'],
  },
  'DELETE /api/v1/service-orders/:id/materials/:materialId': {
    session: 'WEB',
    permissions: ['os.gerenciar'],
  },
  'GET /api/audit': { session: 'WEB', permissions: ['auditoria.ver'] },
  'GET /api/auth/me': { session: 'any', surfaceExempt: true },
  'GET /api/company/settings': { session: 'WEB', permissions: ['empresa.ver'] },
  'GET /api/devices': { session: 'WEB', permissions: ['dispositivos.ver'] },
  'GET /api/employees': { session: 'WEB', permissions: ['funcionarios.ver'] },
  'GET /api/employees/:id': { session: 'WEB', permissions: ['funcionarios.ver'] },
  'GET /api/files/:id': { session: 'any' },
  'GET /api/health': { public: true },
  'GET /api/permissions': { session: 'WEB', permissions: ['funcoes.ver'] },
  'GET /api/ready': { public: true },
  'GET /api/realtime': { session: 'any' },
  'GET /api/roles': { session: 'WEB', permissions: ['funcoes.ver'] },
  'GET /api/sessions': { session: 'WEB', permissions: ['sessoes.ver'] },
  'GET /api/sync/events': { session: 'any' },
  'GET /api/sync/status': { session: 'any' },
  'GET /api/tablet/status': { public: true },
  'GET /api/v1/arrivals': { session: 'any' },
  'GET /api/v1/attachments': { session: 'any' },
  'GET /api/v1/attendance/history': {
    session: 'WEB',
    anyPermissions: ['presenca.ver', 'presenca.gerenciar'],
  },
  'GET /api/v1/attendance/holidays': {
    session: 'WEB',
    anyPermissions: ['presenca.ver', 'presenca.gerenciar'],
  },
  'GET /api/v1/attendance/impacts': {
    session: 'WEB',
    anyPermissions: ['presenca.ver', 'presenca.gerenciar'],
  },
  'GET /api/v1/attendance/leaves': {
    session: 'WEB',
    anyPermissions: ['presenca.ver', 'presenca.gerenciar'],
  },
  'GET /api/v1/attendance/me': { session: 'any', permissions: ['presenca.registrar'] },
  'GET /api/v1/attendance/open-shifts': {
    session: 'WEB',
    anyPermissions: ['presenca.ver', 'presenca.gerenciar'],
  },
  'GET /api/v1/attendance/team': {
    session: 'WEB',
    anyPermissions: ['presenca.ver', 'presenca.gerenciar'],
  },
  'GET /api/v1/attention': {
    session: 'WEB',
    anyPermissions: ['ocorrencias.ver', 'ocorrencias.gerenciar'],
  },
  'GET /api/v1/company/own-team': {
    session: 'WEB',
    anyPermissions: ['empresa.ver', 'retiradas.gerenciar'],
  },
  'GET /api/v1/customers': { session: 'WEB', permissions: ['clientes.ver'] },
  'GET /api/v1/customers/:id': { session: 'WEB', permissions: ['clientes.ver'] },
  'GET /api/v1/customers/:id/addresses': {
    session: 'WEB',
    anyPermissions: ['clientes.ver', 'pedidos.gerenciar', 'retiradas.gerenciar'],
  },
  'GET /api/v1/customers/:id/history': { session: 'WEB', permissions: ['clientes.ver'] },
  'GET /api/v1/customers/lookup': {
    session: 'WEB',
    anyPermissions: ['clientes.ver', 'pedidos.gerenciar'],
  },
  'GET /api/v1/deliveries': {
    session: 'WEB',
    anyPermissions: ['entregas.ver', 'entregas.gerenciar'],
  },
  'GET /api/v1/deliveries/:id': {
    session: 'WEB',
    anyPermissions: ['entregas.ver', 'entregas.gerenciar'],
  },
  'GET /api/v1/finance/balances': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/dashboard': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/expenses': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/labor': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/labor-reviews': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/labor-reviews/:id': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/labor-weekly': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/labor/:id': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/logistics-costs': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/logistics-defaults': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/logistics-weekly': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/my-earnings': {
    session: 'DEVICE',
    permissions: ['financeiro.producao_propria'],
  },
  'GET /api/v1/finance/my-production': {
    session: 'any',
    permissions: ['financeiro.producao_propria'],
  },
  'GET /api/v1/finance/orders': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/orders/:id': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/payables': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/payables/:id': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/payment-reports': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/people': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/productivity': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/receivables': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/receivables/:id': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/recurring-expenses': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/reports/:kind': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/service-orders': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/service-orders/:id': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/service-orders/:id/labor': {
    session: 'WEB',
    permissions: ['financeiro.ver'],
  },
  'GET /api/v1/finance/settings': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/team-costs': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/trip-costs': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/value-requests': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/weekly-closings': { session: 'WEB', permissions: ['financeiro.ver'] },
  'GET /api/v1/finance/weekly-closings/:weekStart': {
    session: 'WEB',
    permissions: ['financeiro.ver'],
  },
  'GET /api/v1/help-requests': {
    session: 'WEB',
    anyPermissions: ['producao.ver', 'producao.planejar'],
  },
  'GET /api/v1/help-requests/:id': {
    session: 'any',
    anyPermissions: ['ajuda.solicitar', 'producao.executar', 'producao.ver', 'producao.planejar'],
  },
  'GET /api/v1/help-requests/:id/candidates': {
    session: 'WEB',
    permissions: ['producao.planejar'],
  },
  'GET /api/v1/help-requests/mine': {
    session: 'any',
    anyPermissions: ['ajuda.solicitar', 'producao.executar'],
  },
  'GET /api/v1/issues': {
    session: 'WEB',
    anyPermissions: ['ocorrencias.ver', 'ocorrencias.gerenciar'],
  },
  'GET /api/v1/issues/:id': {
    session: 'any',
    anyPermissions: [
      'ocorrencias.registrar',
      'ocorrencias.ver',
      'ocorrencias.gerenciar',
      'producao.executar',
    ],
  },
  'GET /api/v1/issues/:id/impacts': {
    session: 'any',
    anyPermissions: [
      'ocorrencias.registrar',
      'ocorrencias.ver',
      'ocorrencias.gerenciar',
      'producao.executar',
    ],
  },
  'GET /api/v1/issues/mine': {
    session: 'any',
    anyPermissions: [
      'ocorrencias.registrar',
      'ocorrencias.ver',
      'ocorrencias.gerenciar',
      'producao.executar',
    ],
  },
  'GET /api/v1/locations': {
    session: 'any',
    anyPermissions: [
      'producao.executar',
      'qualidade.inspecionar',
      'qualidade.gerenciar',
      'entregas.ver',
      'entregas.gerenciar',
      'logistica.executar',
    ],
  },
  'GET /api/v1/logistics-occurrences': {
    session: 'WEB',
    anyPermissions: ['entregas.ver', 'entregas.gerenciar'],
  },
  'GET /api/v1/logistics-occurrences/:id': {
    session: 'any',
    anyPermissions: ['entregas.gerenciar', 'logistica.executar'],
  },
  'GET /api/v1/logistics/jobs': { session: 'any', permissions: ['logistica.executar'] },
  'GET /api/v1/logistics/people': {
    session: 'WEB',
    anyPermissions: ['entregas.ver', 'entregas.gerenciar'],
  },
  'GET /api/v1/logistics/route': {
    session: 'any',
    anyPermissions: ['entregas.ver', 'retiradas.ver', 'logistica.executar', 'producao.executar'],
  },
  'GET /api/v1/logistics/route/history': {
    session: 'WEB',
    anyPermissions: ['entregas.ver', 'retiradas.ver'],
  },
  'GET /api/v1/management/overview': {
    session: 'WEB',
    anyPermissions: ['os.ver', 'entregas.ver', 'entregas.gerenciar', 'financeiro.ver'],
  },
  'GET /api/v1/material-arrivals': {
    session: 'WEB',
    anyPermissions: ['estoque.ver', 'compras.ver', 'estoque.gerenciar'],
  },
  'GET /api/v1/material-leftovers': {
    session: 'WEB',
    anyPermissions: ['estoque.ver', 'estoque.gerenciar', 'compras.ver'],
  },
  'GET /api/v1/material-readiness': {
    session: 'WEB',
    anyPermissions: ['os.ver', 'estoque.ver', 'compras.ver', 'materiais.ver'],
  },
  'GET /api/v1/material-receipts': {
    session: 'WEB',
    anyPermissions: ['compras.ver', 'estoque.ver', 'estoque.gerenciar', 'estoque.autorizar'],
  },
  'GET /api/v1/material-receipts/:id': {
    session: 'WEB',
    anyPermissions: ['compras.ver', 'estoque.ver', 'estoque.gerenciar', 'estoque.autorizar'],
  },
  'GET /api/v1/material-receipts/pending': { session: 'any' },
  'GET /api/v1/materials/consolidated': {
    session: 'WEB',
    anyPermissions: ['materiais.ver', 'materiais.aprovar', 'medicoes.gerenciar'],
  },
  'GET /api/v1/materials/consolidated.csv': {
    session: 'WEB',
    anyPermissions: ['materiais.ver', 'materiais.aprovar', 'medicoes.gerenciar'],
  },
  'GET /api/v1/materials/planning': {
    session: 'WEB',
    anyPermissions: ['materiais.ver', 'materiais.aprovar', 'medicoes.gerenciar'],
  },
  'GET /api/v1/measurements': {
    session: 'WEB',
    anyPermissions: ['medicoes.gerenciar', 'materiais.ver', 'materiais.aprovar'],
  },
  'GET /api/v1/measurements/:id': {
    session: 'any',
    anyPermissions: [
      'medicoes.gerenciar',
      'medicoes.extraordinarias',
      'materiais.ver',
      'materiais.aprovar',
    ],
  },
  'GET /api/v1/measurements/assignees': { session: 'WEB', permissions: ['medicoes.gerenciar'] },
  'GET /api/v1/measurements/awaiting': {
    session: 'WEB',
    anyPermissions: ['medicoes.gerenciar', 'materiais.ver', 'materiais.aprovar'],
  },
  'GET /api/v1/measurements/mine': {
    session: 'any',
    anyPermissions: ['medicoes.gerenciar', 'medicoes.extraordinarias'],
  },
  'GET /api/v1/notifications': { session: 'any' },
  'GET /api/v1/orders': { session: 'WEB', permissions: ['pedidos.ver'] },
  'GET /api/v1/orders/:id': { session: 'WEB', permissions: ['pedidos.ver'] },
  'GET /api/v1/orders/:id/material-forecasts': {
    session: 'WEB',
    anyPermissions: ['materiais.aprovar', 'materiais.ver', 'compras.ver'],
  },
  'GET /api/v1/packaging': {
    session: 'any',
    anyPermissions: ['producao.executar', 'qualidade.gerenciar'],
  },
  'GET /api/v1/packaging/:id': {
    session: 'any',
    anyPermissions: ['producao.executar', 'qualidade.gerenciar'],
  },
  'GET /api/v1/pickups': { session: 'WEB', permissions: ['retiradas.ver'] },
  'GET /api/v1/pickups/:id': { session: 'WEB', permissions: ['retiradas.ver'] },
  'GET /api/v1/pieces': {
    session: 'WEB',
    anyPermissions: ['qualidade.gerenciar', 'entregas.ver', 'entregas.gerenciar'],
  },
  'GET /api/v1/pieces/:id': {
    session: 'WEB',
    anyPermissions: ['qualidade.gerenciar', 'entregas.ver', 'entregas.gerenciar'],
  },
  'GET /api/v1/pieces/by-label': {
    session: 'any',
    anyPermissions: ['producao.executar', 'qualidade.gerenciar', 'entregas.gerenciar'],
  },
  'GET /api/v1/planning-actions': {
    session: 'WEB',
    anyPermissions: ['producao.ver', 'producao.planejar'],
  },
  'GET /api/v1/production-board': {
    session: 'WEB',
    anyPermissions: ['producao.ver', 'producao.planejar'],
  },
  'GET /api/v1/production-plans': {
    session: 'WEB',
    anyPermissions: ['producao.ver', 'producao.planejar'],
  },
  'GET /api/v1/production-plans/:id': {
    session: 'WEB',
    anyPermissions: ['producao.ver', 'producao.planejar'],
  },
  'GET /api/v1/production-plans/:id/candidates': {
    session: 'WEB',
    anyPermissions: ['producao.ver', 'producao.planejar'],
  },
  'GET /api/v1/production-plans/:id/distribution': {
    session: 'WEB',
    anyPermissions: ['producao.ver', 'producao.planejar'],
  },
  'GET /api/v1/production-plans/:id/publication-preview': {
    session: 'WEB',
    anyPermissions: ['producao.ver', 'producao.planejar'],
  },
  'GET /api/v1/production-queue/:userId': {
    session: 'WEB',
    anyPermissions: ['producao.ver', 'producao.planejar'],
  },
  'GET /api/v1/production-tasks/:id': {
    session: 'any',
    anyPermissions: ['producao.ver', 'producao.planejar', 'producao.executar'],
  },
  'GET /api/v1/production-tasks/alternatives': {
    session: 'any',
    permissions: ['producao.executar'],
  },
  'GET /api/v1/production-tasks/mine': { session: 'any', permissions: ['producao.executar'] },
  'GET /api/v1/production-tasks/mine/queue': { session: 'any', permissions: ['producao.executar'] },
  'GET /api/v1/production-templates': {
    session: 'WEB',
    anyPermissions: ['producao.ver', 'producao.planejar'],
  },
  'GET /api/v1/production/distribution-settings': {
    session: 'WEB',
    anyPermissions: ['producao.ver', 'producao.planejar'],
  },
  'GET /api/v1/production/pipeline': {
    session: 'WEB',
    anyPermissions: ['producao.ver', 'producao.planejar'],
  },
  'GET /api/v1/production/workers': {
    session: 'WEB',
    anyPermissions: ['producao.ver', 'producao.planejar'],
  },
  'GET /api/v1/purchase-orders': {
    session: 'WEB',
    anyPermissions: ['compras.ver', 'compras.gerenciar', 'compras.aprovar'],
  },
  'GET /api/v1/purchase-orders/:id': {
    session: 'WEB',
    anyPermissions: ['compras.ver', 'compras.gerenciar', 'compras.aprovar'],
  },
  'GET /api/v1/purchasing/needs': {
    session: 'WEB',
    anyPermissions: ['compras.ver', 'compras.gerenciar', 'compras.aprovar'],
  },
  'GET /api/v1/purchasing/shortages': {
    session: 'WEB',
    anyPermissions: ['compras.ver', 'compras.gerenciar', 'compras.aprovar'],
  },
  'GET /api/v1/quality/inspections': {
    session: 'any',
    anyPermissions: ['qualidade.inspecionar', 'qualidade.gerenciar'],
  },
  'GET /api/v1/quality/inspections/:id': {
    session: 'any',
    anyPermissions: ['qualidade.inspecionar', 'qualidade.gerenciar'],
  },
  'GET /api/v1/quality/inspectors': { session: 'WEB', permissions: ['qualidade.gerenciar'] },
  'GET /api/v1/quality/settings': { session: 'WEB', permissions: ['qualidade.gerenciar'] },
  'GET /api/v1/quality/templates': { session: 'WEB', permissions: ['qualidade.gerenciar'] },
  'GET /api/v1/receipts': {
    session: 'any',
    anyPermissions: ['pedidos.ver', 'recebimentos.registrar'],
  },
  'GET /api/v1/receipts/:id': {
    session: 'any',
    anyPermissions: ['pedidos.ver', 'recebimentos.registrar'],
  },
  'GET /api/v1/receipts/:id/corrections': {
    session: 'WEB',
    anyPermissions: ['pedidos.ver', 'recebimentos.registrar', 'devolucoes.gerenciar'],
  },
  'GET /api/v1/receipts/pending': { session: 'any', permissions: ['recebimentos.registrar'] },
  'GET /api/v1/reschedule-proposals': {
    session: 'WEB',
    anyPermissions: ['producao.ver', 'producao.planejar'],
  },
  'GET /api/v1/reschedule-proposals/:id': {
    session: 'WEB',
    anyPermissions: ['producao.ver', 'producao.planejar'],
  },
  'GET /api/v1/returns': {
    session: 'WEB',
    anyPermissions: ['devolucoes.gerenciar', 'pedidos.ver'],
  },
  'GET /api/v1/returns/:id': {
    session: 'WEB',
    anyPermissions: ['devolucoes.gerenciar', 'pedidos.ver'],
  },
  'GET /api/v1/service-orders': { session: 'any', permissions: ['os.ver'] },
  'GET /api/v1/service-orders/:id': { session: 'any', permissions: ['os.ver'] },
  'GET /api/v1/service-orders/:id/material-readiness': {
    session: 'WEB',
    anyPermissions: ['os.ver', 'estoque.ver', 'compras.ver', 'materiais.ver'],
  },
  'GET /api/v1/service-orders/:id/production': {
    session: 'WEB',
    anyPermissions: ['producao.ver', 'producao.planejar', 'os.ver'],
  },
  'GET /api/v1/service-orders/:id/revisions': { session: 'any', permissions: ['os.ver'] },
  'GET /api/v1/service-orders/:id/timeline': { session: 'WEB', permissions: ['os.ver'] },
  'GET /api/v1/service-orders/available': { session: 'WEB', permissions: ['os.gerenciar'] },
  'GET /api/v1/services/new-defaults': {
    session: 'WEB',
    permissions: ['pedidos.gerenciar', 'retiradas.gerenciar'],
  },
  'GET /api/v1/skills': { session: 'WEB', anyPermissions: ['producao.ver', 'producao.planejar'] },
  'GET /api/v1/stock-items': {
    session: 'WEB',
    anyPermissions: ['estoque.ver', 'estoque.gerenciar', 'compras.ver'],
  },
  'GET /api/v1/stock-movements': {
    session: 'WEB',
    anyPermissions: ['estoque.ver', 'estoque.gerenciar', 'compras.ver'],
  },
  'GET /api/v1/stock-reservations': {
    session: 'WEB',
    anyPermissions: ['estoque.ver', 'estoque.gerenciar', 'compras.ver'],
  },
  'GET /api/v1/suppliers': {
    session: 'WEB',
    anyPermissions: ['compras.ver', 'compras.gerenciar', 'compras.aprovar'],
  },
  'POST /api/auth/login': { public: true },
  'POST /api/auth/logout': { session: 'any', surfaceExempt: true },
  'POST /api/auth/password': { session: 'WEB' },
  'POST /api/devices': { session: 'WEB', permissions: ['dispositivos.gerenciar'] },
  'POST /api/devices/:id/pairing-code': { session: 'WEB', permissions: ['dispositivos.gerenciar'] },
  'POST /api/devices/:id/revoke': { session: 'WEB', permissions: ['dispositivos.gerenciar'] },
  'POST /api/employees': { session: 'WEB', permissions: ['funcionarios.gerenciar'] },
  'POST /api/employees/:id/photo': { session: 'WEB', permissions: ['funcionarios.gerenciar'] },
  'POST /api/employees/:id/status': { session: 'WEB', permissions: ['funcionarios.gerenciar'] },
  'POST /api/roles': { session: 'WEB', permissions: ['funcoes.gerenciar'] },
  'POST /api/sessions/:id/revoke': { session: 'WEB', permissions: ['sessoes.revogar'] },
  'POST /api/sync/signal': { session: 'any', permissions: ['sincronizacao.diagnosticar'] },
  'POST /api/tablet/login': { device: true },
  'POST /api/tablet/pair': { public: true },
  'POST /api/test/attendance/check': null,
  'POST /api/test/clock': null,
  'POST /api/v1/arrivals/pickups/:id/confirm': {
    session: 'any',
    permissions: ['recebimentos.registrar'],
  },
  'POST /api/v1/arrivals/purchase-orders/:id/confirm': { session: 'any' },
  'POST /api/v1/attachments': { session: 'any' },
  'POST /api/v1/attendance/actions': { session: 'WEB', permissions: ['presenca.gerenciar'] },
  'POST /api/v1/attendance/holidays': { session: 'WEB', permissions: ['presenca.gerenciar'] },
  'POST /api/v1/attendance/impacts/:id/resolve': {
    session: 'WEB',
    permissions: ['presenca.gerenciar'],
  },
  'POST /api/v1/attendance/leaves': { session: 'WEB', permissions: ['presenca.gerenciar'] },
  'POST /api/v1/attendance/leaves/:id/cancel': {
    session: 'WEB',
    permissions: ['presenca.gerenciar'],
  },
  'POST /api/v1/attendance/me/arrive': { session: 'any', permissions: ['presenca.registrar'] },
  'POST /api/v1/attendance/me/depart': { session: 'any', permissions: ['presenca.registrar'] },
  'POST /api/v1/customers': { session: 'WEB', permissions: ['clientes.gerenciar'] },
  'POST /api/v1/customers/:id/addresses': { session: 'WEB', permissions: ['clientes.gerenciar'] },
  'POST /api/v1/customers/:id/status': { session: 'WEB', permissions: ['clientes.gerenciar'] },
  'POST /api/v1/deliveries': { session: 'WEB', permissions: ['entregas.gerenciar'] },
  'POST /api/v1/deliveries/:id/arrive': {
    session: 'any',
    anyPermissions: ['entregas.gerenciar', 'logistica.executar', 'producao.executar'],
  },
  'POST /api/v1/deliveries/:id/cancel': { session: 'WEB', permissions: ['entregas.gerenciar'] },
  'POST /api/v1/deliveries/:id/complete': {
    session: 'any',
    anyPermissions: ['entregas.gerenciar', 'logistica.executar', 'producao.executar'],
  },
  'POST /api/v1/deliveries/:id/confirm': { session: 'WEB', permissions: ['entregas.gerenciar'] },
  'POST /api/v1/deliveries/:id/depart': {
    session: 'any',
    anyPermissions: ['entregas.gerenciar', 'logistica.executar', 'producao.executar'],
  },
  'POST /api/v1/deliveries/:id/frustrate': {
    session: 'any',
    anyPermissions: ['entregas.gerenciar', 'logistica.executar', 'producao.executar'],
  },
  'POST /api/v1/deliveries/:id/install': {
    session: 'any',
    anyPermissions: ['entregas.gerenciar', 'logistica.executar', 'producao.executar'],
  },
  'POST /api/v1/deliveries/:id/items': {
    session: 'any',
    anyPermissions: ['entregas.gerenciar', 'logistica.executar', 'producao.executar'],
  },
  'POST /api/v1/finance/closing-payments/:id/reverse': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.ajustes'],
  },
  'POST /api/v1/finance/costs': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.ajustes'],
  },
  'POST /api/v1/finance/expenses': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/expenses/:id/cancel': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/labor': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/labor-reviews/:id/resolve': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.ajustes'],
  },
  'POST /api/v1/finance/labor/:id/adjustments': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.ajustes'],
  },
  'POST /api/v1/finance/labor/:id/agreed': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.ajustes'],
  },
  'POST /api/v1/finance/labor/:id/cancel': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/labor/:id/payments': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/labor/:id/payments/:paymentId/reverse': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.ajustes'],
  },
  'POST /api/v1/finance/logistics-costs': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/logistics-costs/:id/adjustments': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.ajustes'],
  },
  'POST /api/v1/finance/logistics-costs/:id/cancel': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/logistics-costs/:id/constitute': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/my-earnings/confirm': {
    session: 'DEVICE',
    permissions: ['financeiro.producao_propria'],
  },
  'POST /api/v1/finance/my-earnings/requests': {
    session: 'DEVICE',
    permissions: ['financeiro.producao_propria'],
  },
  'POST /api/v1/finance/my-earnings/unlock': {
    session: 'DEVICE',
    permissions: ['financeiro.producao_propria'],
  },
  'POST /api/v1/finance/my-production/unlock': {
    session: 'any',
    permissions: ['financeiro.producao_propria'],
  },
  'POST /api/v1/finance/orders/:id/adjustments': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.ajustes'],
  },
  'POST /api/v1/finance/orders/:id/refunds': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/payables': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/payables/:id/cancel': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/payables/:id/payments': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/payables/:id/payments/:paymentId/reverse': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.ajustes'],
  },
  'POST /api/v1/finance/payment-reports/:id/confirm': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/payment-reports/:id/discard': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/receivables': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/receivables/:id/cancel': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/receivables/:id/payments': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/receivables/:id/payments/:paymentId/reverse': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/recurring-expenses': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/recurring-expenses/generate': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/trip-costs/fee': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.ajustes'],
  },
  'POST /api/v1/finance/trip-costs/free': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/value-requests/:id/approve': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.ajustes'],
  },
  'POST /api/v1/finance/value-requests/:id/reject': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.ajustes'],
  },
  'POST /api/v1/finance/weekly-closings/:weekStart/confirm': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/weekly-closings/:weekStart/exceptions': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/weekly-closings/:weekStart/payments': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'POST /api/v1/finance/weekly-closings/:weekStart/reopen': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.ajustes'],
  },
  'POST /api/v1/help-requests': { session: 'any', permissions: ['ajuda.solicitar'] },
  'POST /api/v1/help-requests/:id/assign': { session: 'WEB', permissions: ['producao.planejar'] },
  'POST /api/v1/help-requests/:id/cancel': {
    session: 'any',
    anyPermissions: ['ajuda.solicitar', 'producao.executar', 'producao.ver', 'producao.planejar'],
  },
  'POST /api/v1/help-requests/process': { session: 'WEB', permissions: ['producao.planejar'] },
  'POST /api/v1/help-requests/prolonged': { session: 'any', permissions: ['ajuda.solicitar'] },
  'POST /api/v1/issues': { session: 'any', permissions: ['ocorrencias.registrar'] },
  'POST /api/v1/issues/:id/actions': {
    session: 'any',
    anyPermissions: [
      'ocorrencias.registrar',
      'ocorrencias.ver',
      'ocorrencias.gerenciar',
      'producao.executar',
    ],
  },
  'POST /api/v1/issues/:id/assign': { session: 'WEB', permissions: ['ocorrencias.gerenciar'] },
  'POST /api/v1/issues/:id/cancel': {
    session: 'any',
    anyPermissions: [
      'ocorrencias.registrar',
      'ocorrencias.ver',
      'ocorrencias.gerenciar',
      'producao.executar',
    ],
  },
  'POST /api/v1/issues/:id/reopen': { session: 'WEB', permissions: ['ocorrencias.gerenciar'] },
  'POST /api/v1/issues/:id/request-verification': {
    session: 'any',
    anyPermissions: [
      'ocorrencias.registrar',
      'ocorrencias.ver',
      'ocorrencias.gerenciar',
      'producao.executar',
    ],
  },
  'POST /api/v1/issues/:id/verify': { session: 'WEB', permissions: ['ocorrencias.gerenciar'] },
  'POST /api/v1/locations': { session: 'WEB', permissions: ['qualidade.gerenciar'] },
  'POST /api/v1/logistics-occurrences': {
    session: 'any',
    anyPermissions: ['entregas.gerenciar', 'logistica.executar'],
  },
  'POST /api/v1/logistics-occurrences/:id/assign': {
    session: 'WEB',
    permissions: ['entregas.gerenciar'],
  },
  'POST /api/v1/logistics-occurrences/:id/cancel': {
    session: 'WEB',
    permissions: ['entregas.gerenciar'],
  },
  'POST /api/v1/logistics-occurrences/:id/resolve': {
    session: 'any',
    anyPermissions: ['entregas.gerenciar', 'logistica.executar'],
  },
  'POST /api/v1/logistics/:kind/:id/payment-report': {
    session: 'any',
    anyPermissions: ['entregas.gerenciar', 'logistica.executar'],
  },
  'POST /api/v1/logistics/pickups/:id/step': {
    session: 'any',
    anyPermissions: ['entregas.gerenciar', 'logistica.executar'],
  },
  'POST /api/v1/material-forecasts/:id/link': {
    session: 'WEB',
    permissions: ['materiais.aprovar'],
  },
  'POST /api/v1/material-leftovers': { session: 'WEB', permissions: ['estoque.gerenciar'] },
  'POST /api/v1/material-leftovers/:id/discard': {
    session: 'WEB',
    permissions: ['estoque.gerenciar'],
  },
  'POST /api/v1/material-leftovers/:id/transfer': {
    session: 'WEB',
    permissions: ['estoque.autorizar'],
  },
  'POST /api/v1/material-receipts': { session: 'any' },
  'POST /api/v1/material-receipts/lines/:id/rejection-decision': {
    session: 'WEB',
    permissions: ['compras.aprovar'],
  },
  'POST /api/v1/material-receipts/lines/:id/reverse': {
    session: 'WEB',
    permissions: ['estoque.autorizar'],
  },
  'POST /api/v1/material-requirements/:id/cancel': {
    session: 'WEB',
    permissions: ['materiais.aprovar'],
  },
  'POST /api/v1/measurements': { session: 'WEB', permissions: ['medicoes.gerenciar'] },
  'POST /api/v1/measurements/:id/assign': { session: 'WEB', permissions: ['medicoes.gerenciar'] },
  'POST /api/v1/measurements/:id/cancel': { session: 'WEB', permissions: ['medicoes.gerenciar'] },
  'POST /api/v1/measurements/:id/request/approve': {
    session: 'WEB',
    permissions: ['materiais.aprovar'],
  },
  'POST /api/v1/measurements/:id/request/reopen': {
    session: 'WEB',
    permissions: ['materiais.aprovar'],
  },
  'POST /api/v1/measurements/:id/request/return': {
    session: 'WEB',
    permissions: ['materiais.aprovar'],
  },
  'POST /api/v1/measurements/:id/request/review': {
    session: 'WEB',
    permissions: ['materiais.aprovar'],
  },
  'POST /api/v1/measurements/:id/start': {
    session: 'any',
    anyPermissions: ['medicoes.gerenciar', 'medicoes.extraordinarias'],
  },
  'POST /api/v1/measurements/:id/submit': {
    session: 'any',
    anyPermissions: ['medicoes.gerenciar', 'medicoes.extraordinarias'],
  },
  'POST /api/v1/notifications/:id/read': { session: 'any' },
  'POST /api/v1/notifications/read-all': { session: 'any' },
  'POST /api/v1/orders': { session: 'WEB', permissions: ['pedidos.gerenciar'] },
  'POST /api/v1/orders/:id/cancel': { session: 'WEB', permissions: ['pedidos.cancelar'] },
  'POST /api/v1/orders/:id/items/:itemId/material-forecasts': {
    session: 'WEB',
    permissions: ['materiais.aprovar'],
  },
  'POST /api/v1/packaging/:id/assign': { session: 'WEB', permissions: ['qualidade.gerenciar'] },
  'POST /api/v1/packaging/:id/complete': {
    session: 'any',
    anyPermissions: ['producao.executar', 'qualidade.gerenciar'],
  },
  'POST /api/v1/pickups': { session: 'WEB', permissions: ['retiradas.gerenciar'] },
  'POST /api/v1/pickups/:id/transition': { session: 'WEB', permissions: ['retiradas.gerenciar'] },
  'POST /api/v1/pieces/:id/move': {
    session: 'any',
    anyPermissions: ['producao.executar', 'qualidade.gerenciar', 'entregas.gerenciar'],
  },
  'POST /api/v1/production-plans': { session: 'WEB', permissions: ['producao.planejar'] },
  'POST /api/v1/production-plans/:id/carry-over': {
    session: 'WEB',
    permissions: ['producao.planejar'],
  },
  'POST /api/v1/production-plans/:id/items': { session: 'WEB', permissions: ['producao.planejar'] },
  'POST /api/v1/production-plans/:id/items/:itemId/distribute': {
    session: 'WEB',
    permissions: ['producao.planejar'],
  },
  'POST /api/v1/production-plans/:id/items/:itemId/remove': {
    session: 'WEB',
    permissions: ['producao.planejar'],
  },
  'POST /api/v1/production-plans/:id/publish': {
    session: 'WEB',
    permissions: ['producao.planejar'],
  },
  'POST /api/v1/production-plans/:id/tasks': { session: 'WEB', permissions: ['producao.planejar'] },
  'POST /api/v1/production-tasks/:id/block': { session: 'WEB', permissions: ['producao.planejar'] },
  'POST /api/v1/production-tasks/:id/cancel': {
    session: 'WEB',
    permissions: ['producao.planejar'],
  },
  'POST /api/v1/production-tasks/:id/complete': {
    session: 'any',
    permissions: ['producao.executar'],
  },
  'POST /api/v1/production-tasks/:id/pause': { session: 'any', permissions: ['producao.executar'] },
  'POST /api/v1/production-tasks/:id/progress': {
    session: 'any',
    permissions: ['producao.executar'],
  },
  'POST /api/v1/production-tasks/:id/resume': {
    session: 'any',
    permissions: ['producao.executar'],
  },
  'POST /api/v1/production-tasks/:id/start': { session: 'any', permissions: ['producao.executar'] },
  'POST /api/v1/production-tasks/:id/transfer-request': {
    session: 'any',
    permissions: ['producao.executar'],
  },
  'POST /api/v1/production-tasks/:id/unblock': {
    session: 'WEB',
    permissions: ['producao.planejar'],
  },
  'POST /api/v1/production-templates': { session: 'WEB', permissions: ['producao.planejar'] },
  'POST /api/v1/production/plan-services': { session: 'WEB', permissions: ['producao.planejar'] },
  'POST /api/v1/purchase-orders': { session: 'WEB', permissions: ['compras.gerenciar'] },
  'POST /api/v1/purchase-orders/:id/cancel': { session: 'WEB', permissions: ['compras.aprovar'] },
  'POST /api/v1/purchase-orders/:id/close-balance': {
    session: 'WEB',
    permissions: ['compras.aprovar'],
  },
  'POST /api/v1/purchase-orders/:id/confirm': { session: 'WEB', permissions: ['compras.aprovar'] },
  'POST /api/v1/purchase-orders/:id/items/:itemId/authorize-extra': {
    session: 'WEB',
    permissions: ['compras.aprovar'],
  },
  'POST /api/v1/quality/inspections/:id/approve': {
    session: 'any',
    anyPermissions: ['qualidade.inspecionar', 'qualidade.gerenciar'],
  },
  'POST /api/v1/quality/inspections/:id/assign': {
    session: 'WEB',
    permissions: ['qualidade.gerenciar'],
  },
  'POST /api/v1/quality/inspections/:id/reject': {
    session: 'any',
    anyPermissions: ['qualidade.inspecionar', 'qualidade.gerenciar'],
  },
  'POST /api/v1/quality/inspections/:id/start': {
    session: 'any',
    anyPermissions: ['qualidade.inspecionar', 'qualidade.gerenciar'],
  },
  'POST /api/v1/quality/templates': { session: 'WEB', permissions: ['qualidade.gerenciar'] },
  'POST /api/v1/receipt-lines/:id/corrections': {
    session: 'WEB',
    permissions: ['devolucoes.gerenciar'],
  },
  'POST /api/v1/receipts': { session: 'any', permissions: ['recebimentos.registrar'] },
  'POST /api/v1/reschedule-proposals/:id/adjust': {
    session: 'WEB',
    permissions: ['producao.planejar'],
  },
  'POST /api/v1/reschedule-proposals/:id/approve': {
    session: 'WEB',
    permissions: ['producao.planejar'],
  },
  'POST /api/v1/reschedule-proposals/:id/reject': {
    session: 'WEB',
    permissions: ['producao.planejar'],
  },
  'POST /api/v1/returns': { session: 'WEB', permissions: ['devolucoes.gerenciar'] },
  'POST /api/v1/returns/:id/cancel': { session: 'WEB', permissions: ['devolucoes.gerenciar'] },
  'POST /api/v1/returns/:id/confirm': { session: 'WEB', permissions: ['devolucoes.gerenciar'] },
  'POST /api/v1/service-orders': { session: 'WEB', permissions: ['os.gerenciar'] },
  'POST /api/v1/service-orders/:id/cancel': { session: 'WEB', permissions: ['os.gerenciar'] },
  'POST /api/v1/service-orders/:id/materials': { session: 'WEB', permissions: ['os.gerenciar'] },
  'POST /api/v1/services': {
    session: 'WEB',
    permissions: ['pedidos.gerenciar', 'retiradas.gerenciar'],
  },
  'POST /api/v1/stock-items': { session: 'WEB', permissions: ['estoque.gerenciar'] },
  'POST /api/v1/stock-items/:id/adjust': { session: 'WEB', permissions: ['estoque.gerenciar'] },
  'POST /api/v1/stock-items/:id/issue': { session: 'WEB', permissions: ['estoque.gerenciar'] },
  'POST /api/v1/stock-reservations': { session: 'WEB', permissions: ['estoque.gerenciar'] },
  'POST /api/v1/stock-reservations/:id/consume': {
    session: 'WEB',
    permissions: ['estoque.gerenciar'],
  },
  'POST /api/v1/stock-reservations/:id/release': {
    session: 'WEB',
    permissions: ['estoque.gerenciar'],
  },
  'POST /api/v1/suppliers': { session: 'WEB', permissions: ['compras.gerenciar'] },
  'PUT /api/company/settings': { session: 'WEB', permissions: ['empresa.configurar'] },
  'PUT /api/devices/:id': { session: 'WEB', permissions: ['dispositivos.gerenciar'] },
  'PUT /api/employees/:id': { session: 'WEB', permissions: ['funcionarios.gerenciar'] },
  'PUT /api/employees/:id/admin-access': {
    session: 'WEB',
    permissions: ['funcionarios.gerenciar'],
  },
  'PUT /api/employees/:id/pin': { session: 'WEB', permissions: ['funcionarios.gerenciar'] },
  'PUT /api/roles/:id': { session: 'WEB', permissions: ['funcoes.gerenciar'] },
  'PUT /api/v1/attendance/holidays/:id': { session: 'WEB', permissions: ['presenca.gerenciar'] },
  'PUT /api/v1/attendance/leaves/:id': { session: 'WEB', permissions: ['presenca.gerenciar'] },
  'PUT /api/v1/company/own-team': { session: 'WEB', permissions: ['empresa.configurar'] },
  'PUT /api/v1/customers/:id': { session: 'WEB', permissions: ['clientes.gerenciar'] },
  'PUT /api/v1/customers/:id/addresses/:addressId': {
    session: 'WEB',
    permissions: ['clientes.gerenciar'],
  },
  'PUT /api/v1/deliveries/:id': { session: 'WEB', permissions: ['entregas.gerenciar'] },
  'PUT /api/v1/employees/:id/skills': { session: 'WEB', permissions: ['producao.planejar'] },
  'PUT /api/v1/finance/logistics-defaults': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'PUT /api/v1/finance/orders/:id/revenue-split': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.ajustes'],
  },
  'PUT /api/v1/finance/recurring-expenses/:id': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'PUT /api/v1/finance/settings': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.ajustes'],
  },
  'PUT /api/v1/finance/team-costs': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'PUT /api/v1/finance/trip-costs': {
    session: 'WEB',
    permissions: ['financeiro.ver', 'financeiro.gerenciar'],
  },
  'PUT /api/v1/locations/:id': { session: 'WEB', permissions: ['qualidade.gerenciar'] },
  'PUT /api/v1/logistics/route/sequence': {
    session: 'WEB',
    anyPermissions: ['entregas.gerenciar', 'retiradas.gerenciar'],
  },
  'PUT /api/v1/material-forecasts/:id': { session: 'WEB', permissions: ['materiais.aprovar'] },
  'PUT /api/v1/measurements/:id/draft': {
    session: 'any',
    anyPermissions: ['medicoes.gerenciar', 'medicoes.extraordinarias'],
  },
  'PUT /api/v1/measurements/:id/request/items': {
    session: 'WEB',
    permissions: ['materiais.aprovar'],
  },
  'PUT /api/v1/orders/:id': { session: 'WEB', permissions: ['pedidos.gerenciar'] },
  'PUT /api/v1/orders/:id/planned-intent': { session: 'WEB', permissions: ['pedidos.gerenciar'] },
  'PUT /api/v1/orders/:id/promised-date': { session: 'WEB', permissions: ['pedidos.gerenciar'] },
  'PUT /api/v1/pickups/:id': { session: 'WEB', permissions: ['retiradas.gerenciar'] },
  'PUT /api/v1/pickups/:id/logistics': {
    session: 'WEB',
    anyPermissions: ['retiradas.gerenciar', 'entregas.gerenciar'],
  },
  'PUT /api/v1/production-plans/:id/items/:itemId': {
    session: 'WEB',
    permissions: ['producao.planejar'],
  },
  'PUT /api/v1/production-plans/:id/queue': { session: 'WEB', permissions: ['producao.planejar'] },
  'PUT /api/v1/production-tasks/:id': { session: 'WEB', permissions: ['producao.planejar'] },
  'PUT /api/v1/production-tasks/:id/dependencies': {
    session: 'WEB',
    permissions: ['producao.planejar'],
  },
  'PUT /api/v1/production-tasks/:id/materials': {
    session: 'WEB',
    permissions: ['producao.planejar'],
  },
  'PUT /api/v1/production-templates/:id': { session: 'WEB', permissions: ['producao.planejar'] },
  'PUT /api/v1/production/distribution-settings': {
    session: 'WEB',
    permissions: ['producao.planejar'],
  },
  'PUT /api/v1/production/planned/:id': { session: 'WEB', permissions: ['producao.planejar'] },
  'PUT /api/v1/purchase-orders/:id': { session: 'WEB', permissions: ['compras.gerenciar'] },
  'PUT /api/v1/quality/inspections/:id/items/:itemId': {
    session: 'any',
    anyPermissions: ['qualidade.inspecionar', 'qualidade.gerenciar'],
  },
  'PUT /api/v1/quality/settings': { session: 'WEB', permissions: ['qualidade.gerenciar'] },
  'PUT /api/v1/quality/templates/:id': { session: 'WEB', permissions: ['qualidade.gerenciar'] },
  'PUT /api/v1/service-order-items/:id/upholsterer': {
    session: 'WEB',
    permissions: ['producao.planejar'],
  },
  'PUT /api/v1/service-orders/:id': { session: 'WEB', permissions: ['os.gerenciar'] },
  'PUT /api/v1/service-orders/:id/items/:itemId': { session: 'WEB', permissions: ['os.gerenciar'] },
  'PUT /api/v1/service-orders/:id/items/:itemId/measurements': {
    session: 'WEB',
    permissions: ['os.gerenciar'],
  },
  'PUT /api/v1/stock-items/:id': { session: 'WEB', permissions: ['estoque.gerenciar'] },
  'PUT /api/v1/suppliers/:id': { session: 'WEB', permissions: ['compras.gerenciar'] },
};
/** apps/web/app/(…)/page.tsx em 9fb1786 (54). */
const BASELINE_PAGES = [
  'apps/web/app/entrar/page.tsx',
  'apps/web/app/page.tsx',
  'apps/web/app/painel/ajuda/page.tsx',
  'apps/web/app/painel/atencao/page.tsx',
  'apps/web/app/painel/auditoria/page.tsx',
  'apps/web/app/painel/clientes/[id]/page.tsx',
  'apps/web/app/painel/clientes/page.tsx',
  'apps/web/app/painel/competencias/page.tsx',
  'apps/web/app/painel/compras/[id]/page.tsx',
  'apps/web/app/painel/compras/novo/page.tsx',
  'apps/web/app/painel/compras/page.tsx',
  'apps/web/app/painel/conta/page.tsx',
  'apps/web/app/painel/devolucoes/page.tsx',
  'apps/web/app/painel/dispositivos/page.tsx',
  'apps/web/app/painel/empresa/page.tsx',
  'apps/web/app/painel/entregas/[id]/page.tsx',
  'apps/web/app/painel/entregas/ocorrencias/[id]/page.tsx',
  'apps/web/app/painel/entregas/page.tsx',
  'apps/web/app/painel/estoque/page.tsx',
  'apps/web/app/painel/financeiro/page.tsx',
  'apps/web/app/painel/fornecedores/page.tsx',
  'apps/web/app/painel/funcionarios/page.tsx',
  'apps/web/app/painel/funcoes/page.tsx',
  'apps/web/app/painel/materiais/page.tsx',
  'apps/web/app/painel/medicoes/[id]/page.tsx',
  'apps/web/app/painel/medicoes/page.tsx',
  'apps/web/app/painel/ocorrencias/[id]/page.tsx',
  'apps/web/app/painel/os/[id]/page.tsx',
  'apps/web/app/painel/os/nova/page.tsx',
  'apps/web/app/painel/os/page.tsx',
  'apps/web/app/painel/page.tsx',
  'apps/web/app/painel/pedidos/[id]/editar/page.tsx',
  'apps/web/app/painel/pedidos/[id]/page.tsx',
  'apps/web/app/painel/pedidos/novo/page.tsx',
  'apps/web/app/painel/pedidos/page.tsx',
  'apps/web/app/painel/planejamento/page.tsx',
  'apps/web/app/painel/presenca/page.tsx',
  'apps/web/app/painel/producao/a-planejar/page.tsx',
  'apps/web/app/painel/producao/modelos/page.tsx',
  'apps/web/app/painel/producao/page.tsx',
  'apps/web/app/painel/producao/planejamento/page.tsx',
  'apps/web/app/painel/producao/tarefas/[id]/page.tsx',
  'apps/web/app/painel/prontidao/page.tsx',
  'apps/web/app/painel/qualidade/inspecoes/[id]/page.tsx',
  'apps/web/app/painel/qualidade/page.tsx',
  'apps/web/app/painel/recebimento-materiais/page.tsx',
  'apps/web/app/painel/recebimentos/novo/page.tsx',
  'apps/web/app/painel/recebimentos/page.tsx',
  'apps/web/app/painel/reprogramacao/page.tsx',
  'apps/web/app/painel/retiradas/page.tsx',
  'apps/web/app/painel/roteiro/page.tsx',
  'apps/web/app/painel/servicos/novo/page.tsx',
  'apps/web/app/painel/sincronizacao/page.tsx',
  'apps/web/app/tablet/page.tsx',
];
/** Migrations de 9fb1786 (31) com o SHA-256 do migration.sql — não podem sumir nem mudar. */
const BASELINE_MIGRATIONS: Record<string, string> = {
  '20261008000000_fundacao': '276303fba1fb79b6b712849258e92c63bc388c310d8901319d9a7c9f7bf0cc3b',
  '20261008100000_comercial_oficina':
    '95088b9dcdb668cf54c19b0fc3b8d88bfc9ba05251fe6a31a25f5af32251a6f5',
  '20261008200000_medicoes_materiais':
    'b3b074c822d21c7e59f31a84b21c69fd9ae20337e71004da7f48c9d972bb19d8',
  '20261009000000_compras_estoque':
    '2f6bb9f41eea237532e0623f209f788fee23eafb7d895cd2f9f780f49038b3b4',
  '20261010000000_producao': '8f9609c45775df1b2cc1755f42e60642d4364c6535378b4a7775c3d776769870',
  '20261011000000_tablets_notificacoes':
    'c13dc577178f5f14a828c83ff1142614df22c5f86993009b8f5ff46999d650c8',
  '20261012000000_presenca_operacional':
    '23e5e73666c6e851715db9f3e2ac9bf62c75d542ad9637849b6f48550bc86976',
  '20261013000000_ajuda_reprogramacao':
    '07322fa9691a40f5520e7771bcdf9a563b6c6badd75a15a94c99800fb1c926e6',
  '20261014000000_central_atencao':
    '703e47fc3b0c10e119c4921db5aba5012de63216df76595b8fd4e4940d0b748b',
  '20261015000000_qualidade_logistica':
    '3df8ffb94912b9479c818edc336b1f5b04a4d3faf69f398ac7a82951a1f6b15e',
  '20261016000000_financeiro_operacional':
    'ca7c554630d74417827afcdf7a2b59099e1b44d5448e08002a2d5144ae632c6a',
  '20261017000000_auditoria_final':
    '4a97024e9562d934ea1c4e5aabb6d83b2386f2c01041eccb941bee62cb624fa2',
  '20261018000000_fila_semanal': 'cda670e2edacea687d3f7b4e899282839151b547dbbe9a6095d19fdf0643a8e9',
  '20261025000000_distribuicao_automatica':
    'f6bbf4ddc39b0f3125632ecdc585d0983c99a6348da218b1b3fbc2d3cce7ab3a',
  '20261101000000_mao_de_obra_revisao':
    'd9266fb6aa9f26771adc4245272cca3b25ac4a23205889c0bad16d254c501a89',
  '20261108000000_custos_logistica':
    '9e61f24312314b8ef1dbcf714a747c771287f157bafa038234cddda4f1a5701e',
  '20261115000000_fechamento_semanal':
    'f79eefc463682883c43e1e4fc57f9d3752c93544d8fca61bc6ffa82cc070bdb4',
  '20261122000000_roteiro_logistica':
    '47d78fa78f7e73fa201b04cedc7824551a8a8e34dc5102e17581eac0d68c822c',
  '20261129000000_novo_servico': 'e9574ad5f177a9e0492a6dd0d66d2fcd738bc98ac0db5e38230c43d757ff8891',
  '20261206000000_recebimentos_compartilhados':
    'ecdd779e014fdd801aad4469d0a0a2b707c0859be932a9fb1a6d7c80bb72fc5a',
  '20261213000000_pre_planejamento':
    '8e2568744c1925080b1a7e4b052e7bd8837ccde832513689c551af63bc24877a',
  '20261220000000_recebimentos_permissao_funcoes':
    '545ad8c3a06709e5bb7aeef4274460c6edd9bdedd95b06e2b0d5686819e19540',
  '20261227000000_servico_sem_retirada':
    '30890133942c28ba156d6c655dce903e546f1e11bccd682ac338fb5c023dc618',
  '20261228000000_titular_mao_de_obra_prevista':
    '6f3f492275c74f826ac62eb1ec97a5f3f62b9e77ad2fd38deeef8ac3bde36a3e',
  '20261230000000_modelos_simplificados':
    '32ed4a4ed54df802eecd8185908ad2e019e678d4aaea60c26dc0f84734e1f57b',
  '20270105000000_necessidade_substituicao':
    'ccba32455614941cb4d6a3fbc7f451fb4a2095904fec0acf668b7aa1bc03bc2b',
  '20270112000000_compra_antes_da_chegada':
    '3c2d7165c3e2da65fd2da44a81cd3e0d4c771e976233322b38aba845863db512',
  '20270119000000_cobranca_cliente':
    'e4ca182d8698f95360248cdd38807682aac31f7293c6d4f4d570c73507dbb247',
  '20270126000000_meus_ganhos_permissao':
    '18f5548e53cbc4f9d0ffa613adfc51f8e211416db3f253ba0881dd1d03880bfe',
  '20270202000000_negociacao_confirmacao_semanal':
    '04fcab8196a49ab96a55347e4a1b0ecfb1e67ec02323697c930c33e4d018337d',
  '20270209000000_presenca_apoio_simplificados':
    '07d3d629014bd02a4b3e3649d45ab063445cef4bb9456b848c6a5319da0a3481',
};

// ───────────────────────────────────── Utilidades ─────────────────────────────────────

const UUID = '00000000-0000-4000-8000-000000000000';
const concrete = (url: string) => url.replace(/:[A-Za-z]+/g, UUID);
type Route = { method: string; url: string; access: AccessRule };
const catalog = (a: App) => (a.app.routeCatalog as Route[]).filter((r) => r.method !== 'HEAD');
const split = (key: string) => {
  const i = key.indexOf(' ');
  return { method: key.slice(0, i), url: key.slice(i + 1) };
};

/** O que a regra permite para uma sessão de painel (mesma lógica do plugin de autenticação). */
function webAllows(access: AccessRule, perms: ReadonlySet<string>): boolean {
  if ('public' in access || 'device' in access) return true;
  if (access.session !== 'any' && access.session !== 'WEB') return false;
  const required = [
    ...(access.surfaceExempt ? [] : ['painel.acessar']),
    ...(access.permissions ?? []),
  ];
  if (!required.every((p) => perms.has(p))) return false;
  return !access.anyPermissions?.length || access.anyPermissions.some((p) => perms.has(p));
}

/** Arquivos-fonte de um diretório (sem node_modules, saídas do Next e testes). */
function sourceFiles(dir: string, exts: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.next') || name === 'test') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full, exts));
    else if (exts.test(name)) out.push(full);
  }
  return out;
}

/** Remove comentários de bloco/linha (não são texto de interface); preserva "http://" em strings. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await resetDatabase();
});
afterAll(() => app.close());

// ─────────────────────────────────────── F1-07b ───────────────────────────────────────

/** Acréscimos permitidos desde 9fb1786 (Rodada 1, decisão do proprietário — F3-17). */
const ALLOWED_NEW_PERMISSIONS = ['estoque.conferir'];
const ALLOWED_ROLE_ADDITIONS: Record<string, string[]> = {
  gestor: ['estoque.conferir'], // o gestor sempre recebe o catálogo completo
  tapeceiro: [],
  cabeceiras_qualidade: [],
  ajudante: [],
  logistica_terceirizada: [],
};
/** Regras de acesso de rotas antigas que mudaram desde 9fb1786 (nenhuma). */
const ALLOWED_ACCESS_CHANGES: Record<string, AccessRule> = {};

describe('F1-07b — nenhuma permissão existente enfraquecida (linha de base 9fb1786)', () => {
  it('o catálogo de permissões é superconjunto do de 9fb1786; único acréscimo: estoque.conferir', () => {
    const now = new Set<string>(ALL_PERMISSIONS);
    expect(BASELINE_PERMISSIONS.filter((p) => !now.has(p))).toEqual([]);
    const base = new Set<string>(BASELINE_PERMISSIONS);
    expect(ALL_PERMISSIONS.filter((p) => !base.has(p))).toEqual(ALLOWED_NEW_PERMISSIONS);
  });

  it('DEFAULT_ROLES: toda função padrão de 9fb1786 continua com todas as permissões (acréscimos listados)', () => {
    const now = new Map(DEFAULT_ROLES.map((r) => [r.key, new Set<string>(r.permissions)]));
    expect([...now.keys()].sort()).toEqual(Object.keys(BASELINE_ROLES).sort());
    for (const [key, perms] of Object.entries(BASELINE_ROLES)) {
      const cur = now.get(key)!;
      expect(
        perms.filter((p) => !cur.has(p)),
        `${key} perdeu`,
      ).toEqual([]);
      const base = new Set(perms);
      expect(
        [...cur].filter((p) => !base.has(p)),
        `${key} ganhou`,
      ).toEqual(ALLOWED_ROLE_ADDITIONS[key]);
    }
  });

  it('no banco após o seed (fonte real das sessões): role_permissions ⊇ linha de base, e o gestor efetivo tem tudo', async () => {
    const roles = await db().role.findMany({
      where: { key: { in: Object.keys(BASELINE_ROLES) } },
      include: { permissions: true },
    });
    expect(roles.map((r) => r.key).sort()).toEqual(Object.keys(BASELINE_ROLES).sort());
    for (const role of roles) {
      const cur = new Set(role.permissions.map((p) => p.permission));
      const base = BASELINE_ROLES[role.key!]!;
      expect(
        base.filter((p) => !cur.has(p)),
        `${role.key} perdeu no banco`,
      ).toEqual([]);
      expect(
        [...cur].filter((p) => !base.includes(p)).sort(),
        `${role.key} ganhou no banco`,
      ).toEqual(ALLOWED_ROLE_ADDITIONS[role.key!]);
    }
    // Permissões efetivas de quem entra como gestor (o que o servidor realmente checa).
    const gestor = await db().user.findUniqueOrThrow({ where: { email: ADMIN.email } });
    const effective = await loadUserPermissions(db(), gestor.id);
    expect(BASELINE_PERMISSIONS.filter((p) => !effective.has(p as Permission))).toEqual([]);
  });

  it('toda rota de 9fb1786 exige exatamente a mesma regra de acesso de antes (nenhuma afrouxada)', () => {
    const now = new Map(catalog(app).map((r) => [`${r.method} ${r.url}`, r.access]));
    const changed: string[] = [];
    let compared = 0;
    for (const [key, access] of Object.entries(BASELINE_ROUTES)) {
      if (access === null) continue; // relógio de teste do E2E: fora do app padrão (ver F1-12b)
      compared += 1;
      const cur = now.get(key);
      expect(cur, `${key} sumiu do catálogo`).toBeDefined();
      const expected = ALLOWED_ACCESS_CHANGES[key] ?? access;
      if (JSON.stringify(cur) !== JSON.stringify(expected))
        changed.push(`${key}: ${JSON.stringify(access)} → ${JSON.stringify(cur)}`);
    }
    expect(compared).toBe(379);
    expect(changed).toEqual([]);
  });

  describe('amostra sensível pela API: financeiro, compras e presença recusam como em 9fb1786', () => {
    const DOMAINS = /^\/api\/v1\/(finance|purchase-orders|purchasing|suppliers|attendance)\b/;
    const sample = Object.entries(BASELINE_ROUTES)
      .filter((e): e is [string, AccessRule] => e[1] !== null && DOMAINS.test(split(e[0]).url))
      .map(([key, access]) => ({ ...split(key), access }));
    const users: Record<string, string[]> = {
      neutro: [],
      fin: ['financeiro.ver'],
      comp: ['compras.ver'],
      pres: ['presenca.ver'],
    };
    const clients: Record<string, Client> = {};
    beforeAll(async () => {
      const admin = await loginAdmin(app);
      for (const [tag, perms] of Object.entries(users))
        clients[tag] = await panelUserWith(app, admin, `r4b${tag}`, perms);
    });

    it('a amostra cobre rotas de leitura e de escrita dos três domínios', () => {
      expect(sample.filter((r) => r.url.startsWith('/api/v1/finance')).length).toBeGreaterThan(60);
      expect(sample.filter((r) => /purchas|suppliers/.test(r.url)).length).toBeGreaterThan(10);
      expect(sample.filter((r) => r.url.startsWith('/api/v1/attendance')).length).toBeGreaterThan(
        10,
      );
      expect(sample.some((r) => r.method !== 'GET')).toBe(true);
    });

    it.each(Object.keys(users))(
      'painel com %s: toda rota da amostra que a regra de 9fb1786 nega responde 403; leituras permitidas passam do controle de acesso',
      async (tag) => {
        const perms = new Set(['painel.acessar', ...users[tag]!]);
        const leaks: string[] = [];
        const refused: string[] = [];
        let denied = 0;
        for (const r of sample) {
          const allowed = webAllows(r.access, perms);
          if (allowed && (r.method !== 'GET' || r.url.includes(':'))) continue;
          const res = await clients[tag]!.req(
            r.method as 'GET',
            concrete(r.url),
            r.method === 'GET' ? undefined : {},
            { 'idempotency-key': idemKey() },
          );
          if (!allowed) {
            denied += 1;
            if (res.status !== 403) leaks.push(`${r.method} ${r.url} → ${res.status}`);
          } else if (res.status === 401 || res.status === 403 || res.status >= 500)
            // Permitida: não pode ser recusada (400 = filtro obrigatório ausente, já passou do acesso).
            refused.push(`${r.method} ${r.url} → ${res.status}`);
        }
        expect(denied).toBeGreaterThan(10);
        expect(leaks).toEqual([]);
        expect(refused).toEqual([]);
      },
    );
  });
});

// ─────────────────────────────────────── F1-12b ───────────────────────────────────────

describe('F1-12b — todos os endpoints de 9fb1786 continuam registrados (trava contra remoção)', () => {
  it('as 381 rotas (método + caminho) de 9fb1786 existem no app atual', () => {
    const keys = Object.keys(BASELINE_ROUTES);
    expect(keys.length).toBe(381);
    const missing = keys
      .filter((k) => BASELINE_ROUTES[k] !== null)
      .filter((k) => !app.app.hasRoute(split(k) as { method: 'GET'; url: string }));
    expect(missing).toEqual([]);
  });

  it('as rotas do relógio de teste (só com ENABLE_TEST_CLOCK) continuam registradas quando ligadas', async () => {
    const clockKeys = Object.keys(BASELINE_ROUTES).filter((k) => BASELINE_ROUTES[k] === null);
    expect(clockKeys.sort()).toEqual(['POST /api/test/attendance/check', 'POST /api/test/clock']);
    // No app padrão elas NÃO existem (nunca ficam expostas sem a chave).
    for (const k of clockKeys)
      expect(app.app.hasRoute(split(k) as { method: 'POST'; url: string })).toBe(false);
    const withClock = await createTestApp({ ENABLE_TEST_CLOCK: 'true', APP_ENV: 'test' });
    try {
      for (const k of clockKeys)
        expect(withClock.app.hasRoute(split(k) as { method: 'POST'; url: string }), k).toBe(true);
    } finally {
      await withClock.close();
    }
  });
});

// ─────────────────────────────────────── F1-13 ────────────────────────────────────────

/**
 * Comandos destrutivos aceitos em migrations posteriores a 9fb1786, um a um, com justificativa.
 * Chave: "<pasta da migration>: <comando normalizado>".
 */
const ALLOWED_DESTRUCTIVE: Record<string, string> = {
  '20270223000000_custo_operacional_equipe_propria: DROP CONSTRAINT "logistics_costs_phase6"':
    'Regra CHECK recriada na mesma migration com a mesma condição e um status a mais (OPERACIONAL): ' +
    'amplia o aceito, nenhuma linha é apagada nem alterada.',
};

describe('F1-13 — nenhuma tela removida, menu de materiais restaurado, nenhum dado excluído', () => {
  it('as 54 páginas Next de 9fb1786 continuam existindo', () => {
    expect(BASELINE_PAGES.length).toBe(54);
    expect(BASELINE_PAGES.filter((p) => !existsSync(join(ROOT, p)))).toEqual([]);
  });

  it('nenhuma página antiga virou redirecionamento (só a raiz, que já era)', () => {
    const redirects = BASELINE_PAGES.filter((p) =>
      /\bredirect\(/.test(readFileSync(join(ROOT, p), 'utf8')),
    );
    expect(redirects).toEqual(['apps/web/app/page.tsx']);
  });

  it('"Materiais aprovados" (/painel/materiais) voltou ao menu do painel', () => {
    const nav = readFileSync(join(ROOT, 'apps/web/components/admin/nav.ts'), 'utf8');
    expect(nav).toMatch(/href: '\/painel\/materiais',\s*label: 'Materiais aprovados'/);
  });

  it('as migrations de 9fb1786 continuam presentes e byte a byte iguais', () => {
    const dir = join(ROOT, 'packages/db/prisma/migrations');
    const changed = Object.entries(BASELINE_MIGRATIONS).filter(([name, sha]) => {
      const file = join(dir, name, 'migration.sql');
      return (
        !existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== sha
      );
    });
    expect(changed).toEqual([]);
  });

  it('migrations posteriores a 9fb1786 não apagam tabela, coluna nem dado (exceções justificadas)', () => {
    const dir = join(ROOT, 'packages/db/prisma/migrations');
    const last = Object.keys(BASELINE_MIGRATIONS).sort().at(-1)!;
    const newer = readdirSync(dir)
      .filter((n) => statSync(join(dir, n)).isDirectory() && n > last)
      .sort();
    // Hoje: as duas migrations da remediação (Rodadas 2 e 3). Novas entram na varredura sozinhas.
    expect(newer).toEqual(
      expect.arrayContaining([
        '20270216000000_notificacoes_resolvidas',
        '20270223000000_custo_operacional_equipe_propria',
      ]),
    );
    // DROP de qualquer coisa (inclusive "ALTER TABLE t DROP coluna", sem a palavra COLUMN), DELETE,
    // TRUNCATE e UPDATE: cada ocorrência precisa estar na lista de exceções justificadas.
    const destructive =
      /\b(DROP|DELETE\s+FROM|TRUNCATE|UPDATE)\s+((?:IF\s+EXISTS\s+)?(?:TABLE|COLUMN|SCHEMA|INDEX|CONSTRAINT|TYPE|VIEW|TRIGGER|FUNCTION)?\s*"?[\w.]+"?)/gi;
    const found: string[] = [];
    for (const name of newer) {
      const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8').replace(/--.*$/gm, '');
      for (const m of sql.matchAll(destructive)) {
        const cmd = `${m[1]!.toUpperCase()} ${m[2]}`.replace(/\s+/g, ' ').trim();
        found.push(`${name}: ${cmd}`);
        // Toda regra derrubada precisa ser recriada na mesma migration.
        const c = /DROP CONSTRAINT ("?[\w]+"?)/i.exec(cmd);
        if (c) expect(sql, `${name} recria ${c[1]}`).toContain(`ADD CONSTRAINT ${c[1]}`);
      }
    }
    expect(found.sort()).toEqual(Object.keys(ALLOWED_DESTRUCTIVE).sort());
  });
});

// ─────────────────────────────────────── F7-16 ────────────────────────────────────────

/**
 * Termos que definiriam a natureza jurídica da relação de trabalho (emprego formal ou autônomo).
 * Ficam fora: "Funcionário/equipe" (palavra operacional), "jornada"/"ponto eletrônico" (só usados
 * para NEGAR que a presença seja controle de jornada) e "Férias" como tipo de folga (ver abaixo).
 */
const LEGAL_TERMS: RegExp[] = [
  /\bCLT\b/,
  /\bCTPS\b/,
  /carteira (assinada|de trabalho)/i,
  /registro em carteira/i,
  /v[ií]nculo (empregat|trabalhist|de emprego)/i,
  /empregat[ií]ci/i,
  /rela[cç][aã]o de emprego/i,
  /contrato de trabalho/i,
  /\bsal[aá]rio/i,
  /\bsalarial/i,
  /\bencargos\b/i,
  /\bempregad[oa]s?\b/i,
  /\bempregador/i,
  /f[ée]rias (remunerad|vencid|proporcion|indenizad)/i,
  /(adicional|ter[cç]o|1\/3) de f[ée]rias/i,
  /per[ií]odo (aquisitivo|concessivo)/i,
  /\bFGTS\b/,
  /\bINSS\b/,
  /holerite|contracheque|folha de pagamento/i,
  /rescis[aã]o|aviso pr[eé]vio|justa causa/i,
  /trabalhista/i,
  /\baut[oô]nom[oa]s?\b/i,
  /prestador(a|es)? de servi[cç]os?/i,
];

function uiSources() {
  const web = sourceFiles(join(ROOT, 'apps/web'), /\.(ts|tsx)$/);
  const shared = sourceFiles(join(ROOT, 'packages/shared/src'), /\.ts$/);
  // Mensagens e notas da API também chegam à tela (erros, observações de relatório).
  const api = sourceFiles(join(ROOT, 'apps/api/src'), /\.ts$/);
  return [...web, ...shared, ...api].map((f) => ({
    file: relative(ROOT, f),
    text: stripComments(readFileSync(f, 'utf8')),
  }));
}

function scan(text: string) {
  return LEGAL_TERMS.flatMap((rx) => {
    const m = new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : rx.flags + 'g');
    return [...text.matchAll(m)].map((x) => x[0]);
  });
}

describe('F7-16 — a interface não define a natureza jurídica da relação de trabalho', () => {
  it('a varredura detecta os termos (controle: não passa no vazio)', () => {
    expect(
      scan('Funcionário CLT com carteira assinada e salário; férias remuneradas; autônomo'),
    ).toEqual(
      expect.arrayContaining([
        'CLT',
        'carteira assinada',
        'salário',
        'férias remunerad',
        'autônomo',
      ]),
    );
    expect(
      scan('Ausência presumida — não é ponto eletrônico, não calcula jornada. Folga ou férias.'),
    ).toEqual([]);
  });

  const hits = () =>
    uiSources().flatMap(({ file, text }) => scan(text).map((t) => `${file}: ${t}`));

  // Rodada 4 (F7-16): o achado deste teste ("salário"/"encargos" da equipe fixa, que
  // pressupõem vínculo de emprego, presentes desde a Fase 11) foi corrigido no texto da
  // interface; esta trava impede que qualquer termo jurídico de vínculo volte.
  it('nenhum texto da interface (web, rótulos do shared e mensagens da API) usa termo jurídico de vínculo', () => {
    expect(uiSources().length).toBeGreaterThan(300);
    expect(hits()).toEqual([]);
  });

  it('"Férias" aparece só como situação operacional de folga (rótulo do tipo ou junto de "folga")', () => {
    const odd: string[] = [];
    let seen = 0;
    for (const { file, text } of uiSources()) {
      for (const m of text.matchAll(/f[ée]rias/gi)) {
        if (m[0] === 'FERIAS') continue; // identificador do enum, não texto
        seen += 1;
        const at = m.index;
        const around = text.slice(Math.max(0, at - 40), at + 40);
        const label = text.slice(at - 1, at + 7) === "'Férias'";
        if (!label && !/folga/i.test(around)) odd.push(`${file}: …${around.replace(/\s+/g, ' ')}…`);
      }
    }
    expect(seen).toBeGreaterThan(3);
    expect(odd).toEqual([]);
  });

  it('a presença declara na tela que é operacional (não é ponto eletrônico nem controle de jornada)', () => {
    const team = readFileSync(join(ROOT, 'apps/web/components/attendance/team-page.tsx'), 'utf8');
    const company = readFileSync(join(ROOT, 'apps/web/components/admin/company-page.tsx'), 'utf8');
    expect(stripComments(team)).toMatch(/não é registro de ponto, não calcula jornada/);
    expect(stripComments(company)).toMatch(/não é ponto eletrônico/);
  });
});

// ─────────────────────────── F10-01 (lado da API do menu) ────────────────────────────

describe('F10-01 — "Recebimento de materiais" sem filtro de permissão no menu (nav.ts)', () => {
  /*
   * O item não tem `anyOf` porque a regra do recebimento é "qualquer funcionário autenticado"
   * (purchasing/common.ts ANY_EMPLOYEE). Prova abaixo que um usuário de painel SEM nenhuma
   * permissão de compras/estoque abre a página sem recusa: as rotas que ela usa aceitam.
   */
  it('as rotas do recebimento valem para qualquer sessão; a lista de chegadas físicas é restrita', () => {
    const rule = (k: string) => catalog(app).find((r) => `${r.method} ${r.url}` === k)?.access;
    expect(rule('GET /api/v1/material-receipts/pending')).toEqual({ session: 'any' });
    expect(rule('POST /api/v1/material-receipts')).toEqual({ session: 'any' });
    expect(rule('GET /api/v1/material-arrivals')).toEqual({
      session: 'WEB',
      anyPermissions: ['estoque.ver', 'compras.ver', 'estoque.gerenciar'],
    });
  });

  it('usuário de painel sem permissão de compras/estoque: a fila do recebimento responde 200 (link não leva a recusa)', async () => {
    const admin = await loginAdmin(app);
    const user = await panelUserWith(app, admin, 'r4bsemcompras', []);
    expect((await user.get('/api/v1/material-receipts/pending')).status).toBe(200);
    // A lista opcional de chegadas aguardando conferência é negada, e a página não a exibe:
    expect((await user.get('/api/v1/material-arrivals?status=PENDENTE_CONFERENCIA')).status).toBe(
      403,
    );
    const page = readFileSync(
      join(ROOT, 'apps/web/components/purchasing/material-receiving.tsx'),
      'utf8',
    );
    expect(page).toMatch(/conference && arrivals\.data\?\.length \?/);
    expect(page).not.toMatch(/arrivals\.(isError|error)/);
    // E a fila de pedidos é a principal: só ela trava a página com erro.
    expect(page).toMatch(/if \(pending\.isError\) return <Alert/);
  });
});
