import { GESTOR_ROLE_KEY } from '@cenario/shared';
import type { Tx } from '@cenario/db';
import { Errors } from '../../lib/errors';

/**
 * Garante que o sistema nunca fique sem ao menos um gestor ativo com acesso ao
 * painel (evita que o gestor se tranque fora do próprio sistema).
 */
export async function assertActiveGestorRemains(tx: Tx): Promise<void> {
  const count = await tx.user.count({
    where: {
      active: true,
      email: { not: null },
      passwordHash: { not: null },
      employee: { active: true },
      roles: { some: { role: { key: GESTOR_ROLE_KEY } } },
    },
  });
  if (count === 0) {
    throw Errors.business(
      'Operação bloqueada: o sistema precisa manter ao menos um gestor ativo com acesso ao painel.',
    );
  }
}

/** Serializa alterações que afetam a regra do "último gestor" (evita corrida entre requisições). */
export async function lockGestorInvariant(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(7263540002::bigint)`;
}
