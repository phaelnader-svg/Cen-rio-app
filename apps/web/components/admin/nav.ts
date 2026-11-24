import type { ModuleKey, Permission } from '@cenario/shared';
import {
  ClipboardPlus,
  Calculator,
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
  RotateCcw,
  Gauge,
  Wallet,
  CreditCard,
  BadgeCheck,
  UserCheck,
  Users,
  Workflow,
  Route,
  type LucideIcon,
  Warehouse,
  Sun,
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
  /** Só aparece com a cobrança ligada (BILLING_ENABLED). */
  billingOnly?: boolean;
  /** Multi-empresa: só para o dono da plataforma (gestor da Cenário Estofados). */
  platformOnly?: true;
  /**
   * Revisão geral (2026-11-18, item 3): telas irmãs viram abas de uma entrada só do menu. O item
   * com `parent` não aparece no menu; aparece como aba no topo das telas da família.
   */
  parent?: string;
  /** Nome da tela como aba (quando difere do nome no menu). */
  tabLabel?: string;
  /** Fora do menu e das abas: abre por link (ex.: pelo sininho ou pelo orçamento). */
  hidden?: true;
}

/**
 * Fase 10 (plano principal): seis áreas do menu (proposta da Simplificação 1, §13.2). Só
 * agrupa e ordena — os itens, nomes, endereços e permissões continuam os mesmos.
 */
export const NAV_GROUPS = [
  'Início',
  // 2026-11-18 (pedido do dono): Financeiro logo acima de Serviços.
  'Financeiro',
  'Serviços',
  'Produção',
  'Administração',
] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];
const GROUP_PREFIXES: [string, NavGroup][] = [
  ['/painel/atencao', 'Início'],
  ['/painel/servicos', 'Serviços'],
  ['/painel/clientes', 'Serviços'],
  ['/painel/orcamentos', 'Serviços'],
  ['/painel/pedidos', 'Serviços'],
  ['/painel/retiradas', 'Serviços'],
  ['/painel/roteiro', 'Serviços'],
  ['/painel/os', 'Serviços'],
  ['/painel/qualidade', 'Serviços'],
  ['/painel/entregas', 'Serviços'],
  ['/painel/devolucoes', 'Serviços'],
  ['/painel/retrabalhos', 'Serviços'],
  ['/painel/producao/modelos', 'Administração'],
  ['/painel/producao', 'Produção'],
  ['/painel/reprogramacao', 'Produção'],
  ['/painel/competencias', 'Produção'],
  ['/painel/presenca', 'Produção'],
  ['/painel/estoque-oficina', 'Produção'],
  ['/painel/produtividade', 'Produção'],
  ['/painel/funcionarios', 'Produção'],
  ['/painel/funcoes', 'Produção'],
  ['/painel/financeiro', 'Financeiro'],
];
export function navGroupOf(href: string): NavGroup {
  if (href === '/painel') return 'Início';
  return GROUP_PREFIXES.find(([p]) => href.startsWith(p))?.[1] ?? 'Administração';
}

export const NAV: NavItem[] = [
  { href: '/painel', label: 'Início', icon: LayoutDashboard },
  // Revisão geral (item 2): os avisos ficam no sininho; esta tela abre pelo "Ver todos" dele.
  {
    href: '/painel/atencao',
    label: 'Avisos e pendências',
    icon: Siren,
    anyOf: ['ocorrencias.ver', 'ocorrencias.gerenciar'],
    hidden: true,
  },
  {
    href: '/painel/financeiro',
    label: 'Financeiro',
    icon: Wallet,
    anyOf: ['financeiro.ver'],
  },
  // Revisão geral (itens 3 e 4): o menu segue o caminho real da peça. O serviço nasce do
  // orçamento aprovado ("Fechar serviço"); "Novo serviço" saiu do menu (a tela continua).
  {
    href: '/painel/orcamentos',
    label: 'Orçamentos',
    icon: Calculator,
    anyOf: ['orcamentos.ver', 'orcamentos.gerenciar'],
  },
  {
    href: '/painel/servicos/novo',
    label: 'Fechar serviço',
    icon: ClipboardPlus,
    // B1: a tela usa /api/v1/services/new-defaults e /api/v1/services, que exigem as duas.
    allOf: ['pedidos.gerenciar', 'retiradas.gerenciar'],
    hidden: true,
  },
  {
    href: '/painel/pedidos',
    label: 'Pedidos',
    icon: FileSignature,
    anyOf: ['pedidos.ver'],
  },
  // Reformulação, Fase 1: telas operacionais da logística somem com o módulo desligado (os dados
  // e o histórico continuam lá; as entregas passam a ser confirmadas na própria OS).
  {
    href: '/painel/retiradas',
    label: 'Retiradas',
    tabLabel: 'Agenda de retiradas',
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
    parent: '/painel/retiradas',
  },
  { href: '/painel/os', label: 'Ordens de serviço', icon: ClipboardList, anyOf: ['os.ver'] },
  // 2026-11-18: "Retrabalhos" substitui "Devoluções" no menu (o histórico das devoluções continua
  // guardado e abre pelo endereço antigo). Serviço a refazer: prazo, retirada e OS em vermelho.
  {
    href: '/painel/retrabalhos',
    label: 'Retrabalhos',
    icon: RotateCcw,
    anyOf: ['os.ver', 'os.gerenciar'],
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
  { href: '/painel/clientes', label: 'Clientes', icon: Contact, anyOf: ['clientes.ver'] },
  // Oficina sem tablet (2026-11-24): o que está na oficina hoje, por tapeceiro, com o botão da
  // próxima etapa (feito para o celular).
  {
    href: '/painel/producao/hoje',
    label: 'Hoje na oficina',
    icon: Sun,
    anyOf: ['os.ver', 'producao.ver', 'producao.planejar'],
  },
  // Revisão geral (item 8): a semana da oficina numa entrada só — montar, acompanhar e decidir
  // as mudanças. "Competências da equipe" segue por link.
  {
    href: '/painel/producao/programacao',
    label: 'Semana da oficina',
    tabLabel: 'Montar a semana',
    icon: CalendarRange,
    anyOf: ['producao.ver', 'producao.planejar'],
  },
  {
    href: '/painel/producao',
    label: 'Quadro de produção',
    tabLabel: 'Quem está fazendo o quê',
    icon: Hammer,
    anyOf: ['producao.ver', 'producao.planejar'],
    parent: '/painel/producao/programacao',
  },
  {
    href: '/painel/reprogramacao',
    label: 'Reprogramação',
    tabLabel: 'Mudanças para decidir',
    icon: GitPullRequestArrow,
    anyOf: ['producao.ver', 'producao.planejar'],
    parent: '/painel/producao/programacao',
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
  // Reformulação, Fase 1: estoque simples da oficina (independente das OS).
  {
    href: '/painel/estoque-oficina',
    label: 'Estoque da oficina',
    icon: Warehouse,
    anyOf: ['estoque.ver', 'estoque.gerenciar'],
  },
  // Revisão geral (item 3): a equipe numa entrada só (funcionários, presença, produtividade e
  // o que cada função pode fazer).
  {
    href: '/painel/funcionarios',
    label: 'Equipe',
    tabLabel: 'Funcionários',
    icon: Users,
    anyOf: ['funcionarios.ver'],
  },
  {
    href: '/painel/presenca',
    label: 'Presença da equipe',
    tabLabel: 'Presença',
    icon: UserCheck,
    anyOf: ['presenca.ver', 'presenca.gerenciar'],
    parent: '/painel/funcionarios',
  },
  // 2026-11-18: Produtividade saiu do Financeiro.
  {
    href: '/painel/produtividade',
    label: 'Produtividade',
    icon: Gauge,
    anyOf: ['financeiro.ver'],
    parent: '/painel/funcionarios',
  },
  {
    href: '/painel/funcoes',
    label: 'Funções e permissões',
    icon: ShieldCheck,
    anyOf: ['funcoes.ver'],
    parent: '/painel/funcionarios',
  },
  // Revisão geral (item 3): os ajustes da empresa numa entrada só.
  {
    href: '/painel/empresa',
    label: 'Empresa',
    tabLabel: 'Dados da empresa',
    icon: Building2,
    anyOf: ['empresa.ver'],
  },
  {
    href: '/painel/producao/modelos',
    // Reformulação, Fase 2: etapas + checklist + materiais padrão num só lugar.
    label: 'Modelos de serviço',
    icon: Workflow,
    anyOf: ['producao.ver', 'producao.planejar', 'qualidade.gerenciar', 'os.gerenciar'],
    parent: '/painel/empresa',
  },
  {
    href: '/painel/dispositivos',
    label: 'Tablets e acessos',
    icon: TabletSmartphone,
    anyOf: ['dispositivos.ver', 'sessoes.ver'],
    parent: '/painel/empresa',
  },
  // Cobrança: plano, situação e pagamento da assinatura do Cenário Gestão.
  {
    href: '/painel/assinatura',
    label: 'Assinatura',
    icon: CreditCard,
    anyOf: ['empresa.ver'],
    billingOnly: true,
    parent: '/painel/empresa',
  },
  {
    href: '/painel/auditoria',
    label: 'Histórico de alterações',
    tabLabel: 'Histórico',
    icon: ScrollText,
    anyOf: ['auditoria.ver'],
    parent: '/painel/empresa',
  },
  // Multi-empresa: empresas que usam o sistema (criadas pelo "Criar conta"); bloquear/liberar.
  {
    href: '/painel/empresas',
    label: 'Empresas',
    icon: Building2,
    anyOf: ['empresa.configurar'],
    platformOnly: true,
  },
  // Aplicativos com acesso delegado (ex.: Firma Viva): cadastrar, ver e revogar autorizações.
  {
    href: '/painel/aplicativos',
    label: 'Aplicativos conectados',
    icon: PlugZap,
    anyOf: ['empresa.configurar', 'sessoes.ver'],
    // Melhoria 157: tela técnica, só para o suporte da plataforma.
    platformOnly: true,
  },
  {
    href: '/painel/sincronizacao',
    label: 'Sincronização',
    icon: RadioTower,
    anyOf: ['sincronizacao.diagnosticar'],
    platformOnly: true,
  },
];

/** Módulos das próximas fases: exibidos como indisponíveis (sem link). */
export const UPCOMING: { label: string; icon: LucideIcon }[] = [];

type Visible = NavItem & { group: NavGroup };

/** Todas as telas que o perfil pode abrir (menu + abas), na ordem do menu. */
export function visiblePages(
  perms: ReadonlySet<Permission>,
  modules: Partial<Record<ModuleKey, boolean>>,
  platformOwner = false,
  billingEnabled = true,
): Visible[] {
  return NAV.filter((i) => !i.platformOnly || platformOwner)
    .filter((i) => !i.billingOnly || billingEnabled)
    .filter((i) => !i.anyOf || i.anyOf.some((p) => perms.has(p)))
    .filter((i) => !i.allOf || i.allOf.every((p) => perms.has(p)))
    .filter((i) => !i.module || modules[i.module])
    .map((i) => ({ ...i, group: navGroupOf(i.parent ?? i.href) }));
}

/** Raiz da família de uma tela (ela mesma, se não tiver `parent`). */
const rootOf = (i: NavItem) => i.parent ?? i.href;

/**
 * Itens do menu visíveis para um conjunto de permissões e funcionalidades ligadas, na ordem do
 * menu. Uma entrada por família: com o nome e o ícone da raiz e o endereço da primeira tela da
 * família que o perfil pode abrir (quem não abre a raiz entra pela aba que pode). `also` lista as
 * telas da família, para o item ficar marcado em qualquer uma delas.
 */
export function visibleNav(
  perms: ReadonlySet<Permission>,
  modules: Partial<Record<ModuleKey, boolean>>,
  platformOwner = false,
  billingEnabled = true,
): (Visible & { also: string[] })[] {
  const pages = visiblePages(perms, modules, platformOwner, billingEnabled);
  const out: (Visible & { also: string[]; n: number })[] = [];
  NAV.forEach((root, n) => {
    if (root.parent || root.hidden) return;
    const family = pages.filter((p) => rootOf(p) === root.href);
    if (family.length === 0) return;
    const entry = family.find((p) => p.href === root.href) ?? family[0]!;
    out.push({
      ...entry,
      label: root.label,
      icon: root.icon,
      group: navGroupOf(root.href),
      also: family.map((p) => p.href),
      n,
    });
  });
  return out
    .sort((a, b) => NAV_GROUPS.indexOf(a.group) - NAV_GROUPS.indexOf(b.group) || a.n - b.n)
    .map(({ n: _n, ...i }) => i);
}

/** Tela atual pelo endereço: a de prefixo mais longo entre as visíveis. */
export function currentPage<T extends { href: string }>(pathname: string, pages: T[]) {
  const matches = (href: string) =>
    href === '/painel' ? pathname === '/painel' : pathname.startsWith(href);
  return pages.filter((p) => matches(p.href)).sort((a, b) => b.href.length - a.href.length)[0];
}

/** Abas da família da tela atual (só quando há mais de uma tela visível na família). */
export function familyTabs(pathname: string, pages: Visible[]) {
  const cur = currentPage(pathname, pages);
  if (!cur || cur.hidden) return null;
  const family = pages.filter((p) => rootOf(p) === rootOf(cur));
  if (family.length < 2) return null;
  return {
    active: cur.href,
    tabs: family.map((p) => ({ href: p.href, label: p.tabLabel ?? p.label })),
  };
}
