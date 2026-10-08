import {
  ALL_PERMISSIONS,
  GESTOR_ROLE_KEY,
  resolvePermissions,
  type Permission,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';

/** Carrega as permissões efetivas do usuário (funções + concessões diretas). */
export async function loadUserPermissions(
  db: PrismaClient | Tx,
  userId: string,
): Promise<Set<Permission>> {
  const [roles, direct] = await Promise.all([
    db.userRole.findMany({
      where: { userId },
      select: { role: { select: { key: true, permissions: { select: { permission: true } } } } },
    }),
    db.userPermission.findMany({ where: { userId }, select: { permission: true } }),
  ]);
  // A função protegida Gestor sempre tem o catálogo completo (inclusive permissões
  // adicionadas em versões novas, antes mesmo de qualquer migração de dados).
  if (roles.some((r) => r.role.key === GESTOR_ROLE_KEY)) return new Set(ALL_PERMISSIONS);
  return new Set(
    resolvePermissions(
      roles.map((r) => r.role.permissions.map((p) => p.permission)),
      direct.map((d) => d.permission),
    ),
  );
}
