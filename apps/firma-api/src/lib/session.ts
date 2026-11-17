import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SESSION_COOKIE } from '../app';
import { randomToken } from './crypto';

/** Abre uma sessão do Firma Viva (cookie httpOnly) na organização indicada ou na primeira. */
export async function openSession(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  orgId: string | null,
) {
  const { db, env, hash } = app.firma;
  const token = randomToken();
  const expiresAt = new Date(Date.now() + env.FIRMA_SESSION_DAYS * 86_400_000);
  const firstOrg =
    orgId ??
    (await db.membership.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' } }))?.orgId ??
    null;
  await db.session.create({
    data: {
      tokenHash: hash(token),
      userId,
      orgId: firstOrg,
      expiresAt,
      ipAddress: request.ip?.slice(0, 64) ?? null,
      userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
    },
  });
  await db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  void reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.FIRMA_COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: env.FIRMA_SESSION_DAYS * 86_400,
  });
}
