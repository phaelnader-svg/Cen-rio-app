/**
 * Reformulação por REMOÇÃO REAL — catálogo web da S0 (mesma regra do catálogo da API:
 * apps/api/test/remocao/catalogo.ts). Etapas concluídas em tests/remocao/etapas-concluidas.json.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Etapa = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8';
export const WEB = resolve(__dirname, '..');
export const ROOT = resolve(__dirname, '../../..');

export function etapasConcluidas(): Set<Etapa> {
  const j = JSON.parse(readFileSync(resolve(ROOT, 'tests/remocao/etapas-concluidas.json'), 'utf8'));
  return new Set(j.concluidas as Etapa[]);
}

/** Página removida: o arquivo não existe OU só mostra o aviso "funcionalidade removida". */
export function paginaRemovida(rota: string): boolean {
  const f = resolve(WEB, 'app', `.${rota}`, 'page.tsx');
  if (!existsSync(f)) return true;
  return /FuncionalidadeRemovida/.test(readFileSync(f, 'utf8'));
}
export function paginaExiste(rota: string): boolean {
  const f = resolve(WEB, 'app', `.${rota}`, 'page.tsx');
  return existsSync(f) && !/FuncionalidadeRemovida/.test(readFileSync(f, 'utf8'));
}

/** Itens de menu (href) e páginas que deixam de existir, por etapa. */
export const PAGINAS_REMOVIDAS: Record<Etapa, readonly string[]> = {
  S1: [],
  S2: ['/painel/prontidao'],
  S3: ['/painel/medicoes', '/painel/planejamento', '/painel/materiais'],
  S4: [
    '/painel/compras',
    '/painel/fornecedores',
    '/painel/recebimento-materiais',
    '/painel/estoque',
  ],
  S5: ['/painel/recebimentos'],
  S6: ['/painel/retiradas', '/painel/roteiro', '/painel/entregas'],
  S7: ['/painel/ajuda'],
  S8: [],
};

/** Componentes que deixam de existir (arquivo ausente), por etapa. */
export const COMPONENTES_REMOVIDOS: Record<Etapa, readonly string[]> = {
  S1: [],
  S2: ['components/purchasing/readiness-page.tsx'],
  S3: ['components/tablet/measurements.tsx', 'components/measurements'],
  S4: [
    'components/purchasing/purchasing-page.tsx',
    'components/purchasing/suppliers-page.tsx',
    'components/purchasing/material-receiving.tsx',
    'components/purchasing/stock-page.tsx',
  ],
  S5: [
    'components/tablet/arrivals.tsx',
    'components/commercial/receipts-page.tsx',
    'components/commercial/new-receipt-page.tsx',
  ],
  S6: [
    'components/tablet/logistics.tsx',
    'components/quality/route-page.tsx',
    'components/quality/delivery-pages.tsx',
    'components/commercial/pickups-page.tsx',
    'components/finance/trip-cost.tsx',
  ],
  S7: ['components/tablet/help.tsx', 'components/help'],
  S8: [],
};

/** Trechos de código que não podem mais aparecer em nenhum arquivo da web, por etapa. */
export const TRECHOS_PROIBIDOS: Record<Etapa, readonly string[]> = {
  S1: ['PackagingPanel', 'usePackaging', "'/api/v1/packaging"],
  S2: ['materialsGate', "'/api/v1/material-readiness"],
  S3: ["'/api/v1/measurements", 'CreateMeasurementDialog'],
  S4: [
    "'/api/v1/purchase-orders",
    "'/api/v1/suppliers",
    "'/api/v1/material-receipts",
    "'/api/v1/stock-",
  ],
  S5: ["'/api/v1/receipts"],
  // Interruptores: com a logística mantida, useModules e /api/company/modules ficam até a S6.
  S6: [
    "'/api/v1/pickups",
    "'/api/v1/logistics",
    "'/api/v1/finance/trip-costs",
    'useModules',
    "'/api/company/modules",
  ],
  S7: ["'/api/v1/help-requests"],
  S8: [],
};

/** Páginas que FICAM (Grupo A). */
export const PAGINAS_MANTIDAS = [
  '/painel/clientes',
  '/painel/servicos/novo',
  '/painel/os',
  '/painel/producao/mapa', // mapa da oficina (D7)
  '/painel/devolucoes', // devoluções pós-entrega (D4)
  '/painel/estoque-oficina', // estoque simples (D2)
  '/painel/qualidade',
  '/painel/financeiro',
  '/painel/funcionarios',
  '/painel/dispositivos',
] as const;
export const COMPONENTES_MANTIDOS = [
  'components/tablet/tasks.tsx',
  'components/tablet/quality.tsx',
  'components/tablet/my-week.tsx',
  'components/commercial/os-material-list.tsx', // lista simples de materiais
  'components/commercial/os-direct-delivery.tsx', // entrega direta na OS
  'components/inventory/inventory-page.tsx', // estoque simples (D2)
] as const;
