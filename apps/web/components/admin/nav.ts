import type { Permission } from '@cenario/shared';
import {
  Building2,
  CalendarRange,
  ClipboardList,
  FileSignature,
  Hammer,
  LayoutDashboard,
  PackageSearch,
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
  { label: 'Pedidos e contratos', icon: FileSignature },
  { label: 'Ordens de serviço', icon: ClipboardList },
  { label: 'Materiais e compras', icon: PackageSearch },
  { label: 'Programação semanal', icon: CalendarRange },
  { label: 'Produção', icon: Hammer },
  { label: 'Central de atenção', icon: Siren },
  { label: 'Qualidade', icon: BadgeCheck },
  { label: 'Entregas', icon: Truck },
];
