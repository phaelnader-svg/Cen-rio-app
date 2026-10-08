import type { Permission } from '@cenario/shared';
import {
  Boxes,
  Building2,
  ListChecks,
  PackagePlus,
  ShoppingCart,
  Store,
  Contact,
  PackageCheck,
  PackageOpen,
  CalendarCheck,
  CalendarRange,
  Layers,
  Ruler,
  ClipboardList,
  FileSignature,
  Hammer,
  LayoutDashboard,
  RadioTower,
  ScrollText,
  ShieldCheck,
  Siren,
  TabletSmartphone,
  Truck,
  BadgeCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  anyOf?: Permission[];
}

export const NAV: NavItem[] = [
  { href: '/painel', label: 'Início', icon: LayoutDashboard },
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
  { href: '/painel/retiradas', label: 'Retiradas', icon: Truck, anyOf: ['retiradas.ver'] },
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
    href: '/painel/planejamento',
    label: 'Planejamento de sexta',
    icon: CalendarCheck,
    anyOf: ['medicoes.gerenciar', 'materiais.ver', 'materiais.aprovar'],
  },
  {
    href: '/painel/materiais',
    label: 'Materiais aprovados',
    icon: Layers,
    anyOf: ['medicoes.gerenciar', 'materiais.ver', 'materiais.aprovar'],
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
  { href: '/painel/recebimento-materiais', label: 'Recebimento de materiais', icon: PackagePlus },
  {
    href: '/painel/estoque',
    label: 'Estoque',
    icon: Boxes,
    anyOf: ['estoque.ver', 'estoque.gerenciar', 'compras.ver'],
  },
  {
    href: '/painel/prontidao',
    label: 'Prontidão de materiais',
    icon: ListChecks,
    anyOf: ['os.ver', 'estoque.ver', 'compras.ver', 'materiais.ver'],
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
export const UPCOMING: { label: string; icon: LucideIcon }[] = [
  { label: 'Programação semanal', icon: CalendarRange },
  { label: 'Produção', icon: Hammer },
  { label: 'Central de atenção', icon: Siren },
  { label: 'Qualidade', icon: BadgeCheck },
  { label: 'Entregas', icon: PackageOpen },
];
