import { resolvePermissions, type Permission } from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';

/** Carrega as permissões efetivas do usuário (funções + concessões diretas). */
export async function loadUserPermissions(
  db: PrismaClient | Tx,
  userId: string,
): Promise<Set<Permission>> {
  const [roles, direct] = await Promise.all([
    db.userRole.findMany({
      where: { userId },
      select: { role: { select: { permissions: { select: { permission: true } } } } },
    }),
    db.userPermission.findMany({ where: { userId }, select: { permission: true } }),
  ]);
  return new Set(
    resolvePermissions(
      roles.map((r) => r.role.permissions.map((p) => p.permission)),
      direct.map((d) => d.permission),
    ),
  );
}
