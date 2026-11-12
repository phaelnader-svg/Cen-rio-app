import type { ModuleKey, Permission } from '@cenario/shared';
import {
  ClipboardPlus,
  Boxes,
  Building2,
  ListChecks,
  PackagePlus,
  ShoppingCart,
  Store,
  Contact,
  PackageCheck,
  PackageOpen,
  CalendarRange,
  Ruler,
  ClipboardList,
  FileSignature,
  GitPullRequestArrow,
  HandHelping,
  Hammer,
  LayoutDashboard,
  RadioTower,
  ScrollText,
  ShieldCheck,
  Siren,
  TabletSmartphone,
  Truck,
  Undo2,
  Wallet,
  BadgeCheck,
  UserCheck,
  Users,
  Workflow,
  Route,
  type LucideIcon,
  Warehouse,
  Map as MapIcon,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  anyOf?: Permission[];
  /**
   * Todas obrigatórias (além de `anyOf`, se houver). Para itens cuja tela exige mais de uma
   * permissão na API — o menu nunca mostra o que a tela não deixaria usar.
   */
  allOf?: Permission[];
  /** Reformulação, Fase 0: some do menu quando a funcionalidade está desligada. */
  module?: ModuleKey;
}

/**
 * Fase 10 (plano principal): seis áreas do menu (proposta da Simplificação 1, §13.2). Só
 * agrupa e ordena — os itens, nomes, endereços e permissões continuam os mesmos.
 */
export const NAV_GROUPS = [
  'Início',
  'Serviços',
  'Produção',
  'Compras',
  'Financeiro',
  'Administração',
] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];
const GROUP_PREFIXES: [string, NavGroup][] = [
  ['/painel/atencao', 'Início'],
  ['/painel/servicos', 'Serviços'],
  ['/painel/clientes', 'Serviços'],
  ['/painel/pedidos', 'Serviços'],
  ['/painel/retiradas', 'Serviços'],
  ['/painel/roteiro', 'Serviços'],
  ['/painel/recebimentos', 'Serviços'],
  ['/painel/os', 'Serviços'],
  ['/painel/qualidade', 'Serviços'],
  ['/painel/entregas', 'Serviços'],
  ['/painel/devolucoes', 'Serviços'],
  ['/painel/producao', 'Produção'],
  ['/painel/ajuda', 'Produção'],
  ['/painel/reprogramacao', 'Produção'],
  ['/painel/competencias', 'Produção'],
  ['/painel/medicoes', 'Produção'],
  ['/painel/planejamento', 'Produção'],
  ['/painel/presenca', 'Produção'],
  ['/painel/compras', 'Compras'],
  ['/painel/fornecedores', 'Compras'],
  ['/painel/recebimento-materiais', 'Compras'],
  ['/painel/estoque', 'Compras'],
  ['/painel/prontidao', 'Compras'],
  ['/painel/materiais', 'Compras'],
  ['/painel/financeiro', 'Financeiro'],
];
export function navGroupOf(href: string): NavGroup {
  if (href === '/painel') return 'Início';
  return GROUP_PREFIXES.find(([p]) => href.startsWith(p))?.[1] ?? 'Administração';
}

export const NAV: NavItem[] = [
  { href: '/painel', label: 'Início', icon: LayoutDashboard },
  // Simplificação Fase 2: entrada principal do gestor (cliente + serviço + retirada).
  {
    href: '/painel/servicos/novo',
    label: 'Novo serviço',
    icon: ClipboardPlus,
    // B1: a tela usa /api/v1/services/new-defaults e /api/v1/services, que exigem as duas.
    allOf: ['pedidos.gerenciar', 'retiradas.gerenciar'],
  },
  {
    href: '/painel/atencao',
    label: 'Central de atenção',
    icon: Siren,
    anyOf: ['ocorrencias.ver', 'ocorrencias.gerenciar'],
  },
  { href: '/painel/funcionarios', label: 'Funcionários', icon: Users, anyOf: ['funcionarios.ver'] },
  {
    href: '/painel/funcoes',
    label: 'Funções e permissões',
    icon: ShieldCheck,
    anyOf: ['funcoes.ver'],
  },
  {
    href: '/painel/dispositivos',
    label: 'Dispositivos e sessões',
    icon: TabletSmartphone,
    anyOf: ['dispositivos.ver', 'sessoes.ver'],
  },
  { href: '/painel/clientes', label: 'Clientes', icon: Contact, anyOf: ['clientes.ver'] },
  {
    href: '/painel/pedidos',
    label: 'Pedidos comerciais',
    icon: FileSignature,
    anyOf: ['pedidos.ver'],
  },
  // Reformulação, Fase 1: telas operacionais da logística somem com o módulo desligado (os dados
  // e o histórico continuam lá; as entregas passam a ser confirmadas na própria OS).
  {
    href: '/painel/retiradas',
    label: 'Retiradas',
    icon: Truck,
    anyOf: ['retiradas.ver'],
    module: 'logistica',
  },
  {
    href: '/painel/roteiro',
    label: 'Roteiro do dia',
    icon: Route,
    anyOf: ['entregas.ver', 'retiradas.ver'],
    module: 'logistica',
  },
  {
    href: '/painel/recebimentos',
    label: 'Recebimentos',
    icon: PackageCheck,
    anyOf: ['recebimentos.registrar', 'pedidos.ver'],
  },
  { href: '/painel/os', label: 'Ordens de serviço', icon: ClipboardList, anyOf: ['os.ver'] },
  {
    href: '/painel/medicoes',
    label: 'Medições',
    icon: Ruler,
    anyOf: ['medicoes.gerenciar', 'materiais.ver', 'materiais.aprovar'],
  },
  {
    // Reformulação, Fase 3: "A planejar" + "Planejamento de produção" numa tela só. Os endereços
    // antigos continuam abrindo as abas correspondentes; "Planejamento de sexta" (medições) e
    // "Competências da equipe" saíram do menu e seguem por link (Medições e Programação semanal).
    href: '/painel/producao/programacao',
    label: 'Programação semanal',
    icon: CalendarRange,
    anyOf: ['producao.ver', 'producao.planejar'],
  },
  {
    href: '/painel/producao',
    label: 'Quadro de produção',
    icon: Hammer,
    anyOf: ['producao.ver', 'producao.planejar'],
  },
  // Reformulação, Fase 2: onde cada peça está fisicamente (áreas da oficina).
  {
    href: '/painel/producao/mapa',
    label: 'Mapa da oficina',
    icon: MapIcon,
    anyOf: [
      'os.ver',
      'producao.ver',
      'producao.planejar',
      'qualidade.gerenciar',
      'entregas.ver',
      'entregas.gerenciar',
    ],
  },
  {
    href: '/painel/ajuda',
    label: 'Pedidos de ajuda',
    icon: HandHelping,
    anyOf: ['producao.ver', 'producao.planejar'],
    module: 'ajuda',
  },
  {
    href: '/painel/reprogramacao',
    label: 'Reprogramação',
    icon: GitPullRequestArrow,
    anyOf: ['producao.ver', 'producao.planejar'],
  },
  {
    href: '/painel/producao/modelos',
    // Reformulação, Fase 2: etapas + checklist + materiais padrão num só lugar.
    label: 'Modelos de serviço',
    icon: Workflow,
    anyOf: ['producao.ver', 'producao.planejar', 'qualidade.gerenciar', 'os.gerenciar'],
  },
  {
    href: '/painel/compras',
    label: 'Compras',
    icon: ShoppingCart,
    anyOf: ['compras.ver', 'compras.gerenciar', 'compras.aprovar'],
  },
  {
    href: '/painel/fornecedores',
    label: 'Fornecedores',
    icon: Store,
    anyOf: ['compras.ver', 'compras.gerenciar'],
  },
  // Sem filtro de propósito: registrar a chegada de material é permitido a QUALQUER funcionário
  // (API: ANY_EMPLOYEE). Só a lista "aguardando conferência" exige estoque/compras — a tela a
  // esconde de quem não tem essas permissões (B2).
  { href: '/painel/recebimento-materiais', label: 'Recebimento de materiais', icon: PackagePlus },
  {
    href: '/painel/estoque',
    label: 'Estoque',
    icon: Boxes,
    anyOf: ['estoque.ver', 'estoque.gerenciar', 'compras.ver'],
  },
  // Reformulação, Fase 1: estoque simples da oficina (independente das OS).
  {
    href: '/painel/estoque-oficina',
    label: 'Estoque da oficina',
    icon: Warehouse,
    anyOf: ['estoque.ver', 'estoque.gerenciar'],
  },
  {
    href: '/painel/prontidao',
    label: 'Prontidão de materiais',
    icon: ListChecks,
    anyOf: ['os.ver', 'estoque.ver', 'compras.ver', 'materiais.ver'],
  },
  // Rodada 3 (F10-02): a lista consolidada (bruta) dos materiais aprovados não ficava acessível pelo
  // menu (só por um link no planejamento).
  {
    href: '/painel/materiais',
    label: 'Materiais aprovados',
    icon: ClipboardList,
    anyOf: ['materiais.ver', 'materiais.aprovar', 'compras.ver'],
  },
  {
    href: '/painel/qualidade',
    label: 'Qualidade',
    icon: BadgeCheck,
    anyOf: ['qualidade.gerenciar'],
  },
  {
    href: '/painel/entregas',
    label: 'Expedição e entregas',
    icon: PackageOpen,
    anyOf: ['entregas.ver', 'entregas.gerenciar'],
  },
  {
    href: '/painel/devolucoes',
    label: 'Devoluções',
    icon: Undo2,
    // B6: as mesmas permissões que a API aceita para consultar (RETURNS_VIEW); registrar,
    // confirmar e cancelar continuam exigindo devolucoes.gerenciar (a tela esconde as ações).
    anyOf: ['devolucoes.gerenciar', 'pedidos.ver'],
  },
  {
    href: '/painel/financeiro',
    label: 'Financeiro',
    icon: Wallet,
    anyOf: ['financeiro.ver'],
  },
  {
    href: '/painel/presenca',
    label: 'Presença da equipe',
    icon: UserCheck,
    anyOf: ['presenca.ver', 'presenca.gerenciar'],
  },
  { href: '/painel/empresa', label: 'Empresa', icon: Building2, anyOf: ['empresa.ver'] },
  { href: '/painel/auditoria', label: 'Auditoria', icon: ScrollText, anyOf: ['auditoria.ver'] },
  {
    href: '/painel/sincronizacao',
    label: 'Sincronização',
    icon: RadioTower,
    anyOf: ['sincronizacao.diagnosticar'],
  },
];

/** Módulos das próximas fases: exibidos como indisponíveis (sem link). */
export const UPCOMING: { label: string; icon: LucideIcon }[] = [];

/** Itens do menu visíveis para um conjunto de permissões e funcionalidades ligadas, na ordem do menu. */
export function visibleNav(
  perms: ReadonlySet<Permission>,
  modules: Partial<Record<ModuleKey, boolean>>,
): (NavItem & { group: NavGroup })[] {
  return NAV.filter((i) => !i.anyOf || i.anyOf.some((p) => perms.has(p)))
    .filter((i) => !i.allOf || i.allOf.every((p) => perms.has(p)))
    .filter((i) => !i.module || modules[i.module])
    .map((i, n) => ({ ...i, group: navGroupOf(i.href), n }))
    .sort((a, b) => NAV_GROUPS.indexOf(a.group) - NAV_GROUPS.indexOf(b.group) || a.n - b.n)
    .map(({ n: _n, ...i }) => i);
}
