import type { PrismaClient } from '@cenario/db';
import type { FastifyBaseLogger } from 'fastify';

const MAINTENANCE_LOCK = 7_263_540_003;
const DAY = 86_400_000;

/**
 * Limpeza periódica (uma instância por vez, via advisory lock):
 * - chaves de idempotência expiradas;
 * - contadores de tentativas de login antigos e não bloqueados;
 * - sessões encerradas ou expiradas há mais de 90 dias.
 * Auditoria e eventos NÃO são apagados aqui (retenção é decisão do gestor).
 */
export async function runMaintenance(prisma: PrismaClient, log: FastifyBaseLogger) {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${MAINTENANCE_LOCK}::bigint) AS locked`;
    if (!rows[0]?.locked) return;
    const now = new Date();
    const idem = await tx.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } });
    const throttle = await tx.authThrottle.deleteMany({
      where: {
        updatedAt: { lt: new Date(now.getTime() - DAY) },
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
    });
    const cutoff = new Date(now.getTime() - 90 * DAY);
    const sessions = await tx.session.deleteMany({
      where: { OR: [{ revokedAt: { lt: cutoff } }, { expiresAt: { lt: cutoff } }] },
    });
    if (idem.count || throttle.count || sessions.count) {
      log.info(
        { idempotency: idem.count, throttle: throttle.count, sessions: sessions.count },
        'Manutenção periódica concluída',
      );
    }
  });
}
