import type { ModuleKey, Permission } from '@cenario/shared';
import {
  ClipboardPlus,
  Building2,
  Contact,
  PackageOpen,
  CalendarRange,
  ClipboardList,
  FileSignature,
  GitPullRequestArrow,
  Hammer,
  LayoutDashboard,
  RadioTower,
  ScrollText,
  ShieldCheck,
  Siren,
  TabletSmartphone,
  PlugZap,
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
  ['/painel/os', 'Serviços'],
  ['/painel/qualidade', 'Serviços'],
  ['/painel/entregas', 'Serviços'],
  ['/painel/devolucoes', 'Serviços'],
  ['/painel/producao', 'Produção'],
  ['/painel/reprogramacao', 'Produção'],
  ['/painel/competencias', 'Produção'],
  ['/painel/presenca', 'Produção'],
  ['/painel/estoque-oficina', 'Produção'],
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
  // Aplicativos com acesso delegado (ex.: Firma Viva): cadastrar, ver e revogar autorizações.
  {
    href: '/painel/aplicativos',
    label: 'Aplicativos conectados',
    icon: PlugZap,
    anyOf: ['empresa.configurar', 'sessoes.ver'],
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
  { href: '/painel/os', label: 'Ordens de serviço', icon: ClipboardList, anyOf: ['os.ver'] },
  {
    // Reformulação, Fase 3: "A planejar" + "Planejamento de produção" numa tela só. Os endereços
    // antigos continuam abrindo as abas correspondentes; "Competências da equipe" saiu do menu e
    // segue por link (Programação semanal).
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
  // Reformulação, Fase 1: estoque simples da oficina (independente das OS).
  {
    href: '/painel/estoque-oficina',
    label: 'Estoque da oficina',
    icon: Warehouse,
    anyOf: ['estoque.ver', 'estoque.gerenciar'],
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
