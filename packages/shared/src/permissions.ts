/**
 * Catálogo de permissões do sistema.
 *
 * As permissões são definidas em código (fonte única da verdade) e sincronizadas
 * com o banco pelo seed. Funções (roles) agrupam permissões e são editáveis pelo
 * gestor; permissões individuais podem ser concedidas a um usuário específico
 * (ex.: tapeceiro autorizado a fazer medições extraordinárias em fases futuras).
 *
 * Toda verificação é feita no backend. O frontend usa este catálogo apenas para
 * esconder elementos de interface.
 */

export const PERMISSION_GROUPS = {
  acesso: 'Acesso aos ambientes',
  pessoas: 'Pessoas',
  seguranca: 'Funções e segurança',
  dispositivos: 'Dispositivos e sessões',
  empresa: 'Empresa',
  sistema: 'Sistema',
} as const;

export type PermissionGroup = keyof typeof PERMISSION_GROUPS;

interface PermissionDefinition {
  group: PermissionGroup;
  label: string;
  description: string;
  /** Permissões críticas exigem atenção extra ao conceder (destacadas na interface). */
  critical?: boolean;
}

export const PERMISSIONS = {
  'painel.acessar': {
    group: 'acesso',
    label: 'Acessar painel administrativo',
    description: 'Permite entrar no painel administrativo pelo navegador.',
  },
  'producao.acessar': {
    group: 'acesso',
    label: 'Acessar interface de produção',
    description: 'Permite entrar na interface dos tablets da oficina.',
  },
  'funcionarios.ver': {
    group: 'pessoas',
    label: 'Ver funcionários',
    description: 'Consultar o cadastro de funcionários.',
  },
  'funcionarios.gerenciar': {
    group: 'pessoas',
    label: 'Gerenciar funcionários',
    description: 'Cadastrar, editar, desativar funcionários e redefinir credenciais de acesso.',
    critical: true,
  },
  'funcoes.ver': {
    group: 'seguranca',
    label: 'Ver funções e permissões',
    description: 'Consultar funções e as permissões atribuídas.',
  },
  'funcoes.gerenciar': {
    group: 'seguranca',
    label: 'Gerenciar funções e permissões',
    description: 'Criar e alterar funções e conceder permissões.',
    critical: true,
  },
  'dispositivos.ver': {
    group: 'dispositivos',
    label: 'Ver dispositivos',
    description: 'Consultar tablets e dispositivos cadastrados.',
  },
  'dispositivos.gerenciar': {
    group: 'dispositivos',
    label: 'Gerenciar dispositivos',
    description: 'Cadastrar, vincular, bloquear e revogar dispositivos.',
    critical: true,
  },
  'sessoes.ver': {
    group: 'dispositivos',
    label: 'Ver sessões ativas',
    description: 'Consultar sessões abertas no painel e nos tablets.',
  },
  'sessoes.revogar': {
    group: 'dispositivos',
    label: 'Revogar sessões',
    description: 'Encerrar remotamente sessões de outros usuários.',
    critical: true,
  },
  'empresa.ver': {
    group: 'empresa',
    label: 'Ver configurações da empresa',
    description: 'Consultar dados e parâmetros operacionais da empresa.',
  },
  'empresa.configurar': {
    group: 'empresa',
    label: 'Configurar empresa',
    description: 'Alterar dados e parâmetros operacionais da empresa.',
    critical: true,
  },
  'auditoria.ver': {
    group: 'sistema',
    label: 'Ver auditoria',
    description: 'Consultar o registro de auditoria de ações críticas.',
  },
  'sincronizacao.diagnosticar': {
    group: 'sistema',
    label: 'Diagnóstico de sincronização',
    description: 'Enviar sinais de teste para verificar a sincronização entre dispositivos.',
  },
} as const satisfies Record<string, PermissionDefinition>;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

/**
 * Funções padrão criadas pelo seed. Funções marcadas como `system` não podem ser
 * excluídas e a função de gestor sempre mantém todas as permissões (evita que o
 * gestor perca acesso ao próprio sistema).
 */
export interface DefaultRoleDefinition {
  key: string;
  name: string;
  description: string;
  system: boolean;
  permissions: readonly Permission[];
}

export const GESTOR_ROLE_KEY = 'gestor';

export const DEFAULT_ROLES: readonly DefaultRoleDefinition[] = [
  {
    key: GESTOR_ROLE_KEY,
    name: 'Gestor',
    description:
      'Responsável por clientes, orçamentos, OS, compras, programação, decisões e entregas.',
    system: true,
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'tapeceiro',
    name: 'Tapeceiro',
    description: 'Corte, costura e montagem. Cada sofá tem um tapeceiro principal.',
    system: true,
    permissions: ['producao.acessar', 'sincronizacao.diagnosticar'],
  },
  {
    key: 'cabeceiras_qualidade',
    name: 'Cabeceiras, reparos e qualidade',
    description:
      'Fabricação de cabeceiras, reparos, preparação, instalações e inspeção final de qualidade.',
    system: true,
    permissions: ['producao.acessar', 'sincronizacao.diagnosticar'],
  },
  {
    key: 'ajudante',
    name: 'Ajudante',
    description: 'Desmontagem, preparação e apoio à produção.',
    system: true,
    permissions: ['producao.acessar', 'sincronizacao.diagnosticar'],
  },
];

/** Resolve o conjunto efetivo de permissões a partir das funções e concessões diretas. */
export function resolvePermissions(
  rolePermissions: readonly (readonly string[])[],
  directGrants: readonly string[] = [],
): Permission[] {
  const set = new Set<Permission>();
  for (const list of rolePermissions) {
    for (const p of list) if (isPermission(p)) set.add(p);
  }
  for (const p of directGrants) if (isPermission(p)) set.add(p);
  return ALL_PERMISSIONS.filter((p) => set.has(p));
}
