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

/**
 * Reformulação, Fase 4: as mesmas permissões de `loadUserPermissions`, para vários usuários em
 * duas consultas (antes, listas de equipe faziam duas consultas por pessoa).
 */
export async function loadUsersPermissions(
  db: PrismaClient | Tx,
  userIds: string[],
): Promise<Map<string, Set<Permission>>> {
  const out = new Map<string, Set<Permission>>();
  if (!userIds.length) return out;
  const [roles, direct] = await Promise.all([
    db.userRole.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        role: { select: { key: true, permissions: { select: { permission: true } } } },
      },
    }),
    db.userPermission.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, permission: true },
    }),
  ]);
  for (const id of userIds) {
    const mine = roles.filter((r) => r.userId === id);
    if (mine.some((r) => r.role.key === GESTOR_ROLE_KEY)) {
      out.set(id, new Set(ALL_PERMISSIONS));
      continue;
    }
    out.set(
      id,
      new Set(
        resolvePermissions(
          mine.map((r) => r.role.permissions.map((p) => p.permission)),
          direct.filter((d) => d.userId === id).map((d) => d.permission),
        ),
      ),
    );
  }
  return out;
}
