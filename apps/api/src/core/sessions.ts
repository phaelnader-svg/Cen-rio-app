import { EVENT_TYPES, type SessionKind } from '@cenario/shared';
import type { Prisma, Tx } from '@cenario/db';
import type { Env } from '../config/env';
import { randomToken } from '../lib/crypto';
import { appendEvent } from './events/append';
import type { ActorContext } from './types';

export type RevokeReason =
  | 'logout'
  | 'revoked_by_admin'
  | 'device_revoked'
  | 'user_deactivated'
  | 'credentials_changed'
  | 'replaced'
  | 'device_repaired';

/** Política de expiração: web com ociosidade + limite absoluto; tablet só por ociosidade. */
export function sessionExpiry(
  env: Env,
  kind: SessionKind,
  createdAt: Date,
  now = new Date(),
): Date {
  if (kind === 'DEVICE') {
    return new Date(now.getTime() + env.SESSION_DEVICE_IDLE_DAYS * 86_400_000);
  }
  const idle = now.getTime() + env.SESSION_WEB_IDLE_HOURS * 3_600_000;
  const absolute = createdAt.getTime() + env.SESSION_WEB_ABSOLUTE_DAYS * 86_400_000;
  return new Date(Math.min(idle, absolute));
}

export async function createSession(
  tx: Tx,
  env: Env,
  hashToken: (t: string) => string,
  input: {
    kind: SessionKind;
    userId: string;
    deviceId: string | null;
    ip: string | null;
    userAgent: string | null;
  },
) {
  const token = randomToken();
  const now = new Date();
  const session = await tx.session.create({
    data: {
      tokenHash: hashToken(token),
      kind: input.kind,
      userId: input.userId,
      deviceId: input.deviceId,
      expiresAt: sessionExpiry(env, input.kind, now, now),
      ipAddress: input.ip,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      createdAt: now,
      lastSeenAt: now,
    },
  });
  return { session, token };
}

/**
 * Revoga sessões ativas que atendam ao filtro e publica o evento que encerra
 * as conexões de tempo real correspondentes em todas as instâncias.
 */
export async function revokeSessions(
  tx: Tx,
  actor: ActorContext,
  where: Prisma.SessionWhereInput,
  reason: RevokeReason,
): Promise<string[]> {
  const targets = await tx.session.findMany({
    where: { ...where, revokedAt: null },
    select: { id: true, userId: true },
  });
  if (targets.length === 0) return [];
  const ids = targets.map((t) => t.id);
  await tx.session.updateMany({
    where: { id: { in: ids }, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason, revokedById: actor.userId },
  });
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.SESSION_REVOKED,
    aggregateType: 'session',
    aggregateId: ids[0]!,
    payload: { sessionIds: ids, userIds: [...new Set(targets.map((t) => t.userId))], reason },
    audience: 'permission:sessoes.ver',
  });
  return ids;
}
