import { adminLoginSchema, changePasswordSchema } from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { loadUserPermissions } from '../../core/permissions';
import { createSession, revokeSessions } from '../../core/sessions';
import { AuthThrottle, POLICIES, clientIpKey } from '../../core/throttle';
import { burnVerification, hashSecret, verifySecret } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
import { cookieOptions } from '../../plugins/auth';
import { buildMe } from '../presenters';

export async function authRoutes(app: FastifyInstance) {
  const { prisma, env, hashToken, cookies } = app.ctx;
  const throttle = new AuthThrottle(prisma);

  /** Login do painel administrativo (e-mail + senha). */
  app.post('/api/auth/login', { config: { access: { public: true } } }, async (request, reply) => {
    const input = adminLoginSchema.parse(request.body);
    const accountKey = `email:${input.email}`;
    const ipKey = clientIpKey(request, 'ip');
    await throttle.assertAllowed([accountKey, ipKey]);

    const user = await prisma.user.findUnique({
      where: { email: input.email },
      include: { employee: { select: { active: true } } },
    });
    const ok = user?.passwordHash
      ? await verifySecret(user.passwordHash, input.password)
      : (await burnVerification(input.password), false);

    if (!user || !ok || !user.active || user.employee?.active === false) {
      await throttle.registerFailure(accountKey, POLICIES.account);
      await throttle.registerFailure(ipKey, POLICIES.ip);
      request.log.info({ event: 'auth.login_failed' }, 'Falha de login no painel');
      throw Errors.invalidCredentials('E-mail ou senha incorretos.');
    }

    const permissions = await loadUserPermissions(prisma, user.id);
    if (!permissions.has('painel.acessar')) {
      throw Errors.forbidden('Seu usuário não tem acesso ao painel administrativo.');
    }
    await throttle.reset(accountKey);

    const actor = { ...actorFrom(request), userId: user.id };
    const { session, token } = await prisma.$transaction(async (tx) => {
      const created = await createSession(tx, env, hashToken, {
        kind: 'WEB',
        userId: user.id,
        deviceId: null,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      await audit(
        tx,
        { ...actor, sessionId: created.session.id },
        {
          action: 'auth.login',
          entityType: 'session',
          entityId: created.session.id,
          summary: `${user.displayName} entrou no painel administrativo.`,
        },
      );
      return created;
    });

    const maxAge = Math.floor((session.expiresAt.getTime() - Date.now()) / 1000);
    void reply.setCookie(cookies.session, token, cookieOptions(env.COOKIE_SECURE, maxAge));
    return buildMe(prisma, {
      sessionId: session.id,
      kind: 'WEB',
      userId: user.id,
      deviceId: null,
      expiresAt: session.expiresAt,
      permissions,
    });
  });

  /** Encerra a sessão atual (painel ou tablet). No tablet, o dispositivo continua vinculado. */
  app.post(
    '/api/auth/logout',
    { config: { access: { session: 'any', surfaceExempt: true } } },
    async (request, reply) => {
      const auth = request.auth!;
      await prisma.$transaction(async (tx) => {
        const actor = actorFrom(request);
        await revokeSessions(tx, actor, { id: auth.sessionId }, 'logout');
        await audit(tx, actor, {
          action: 'auth.logout',
          entityType: 'session',
          entityId: auth.sessionId,
          summary: `${auth.displayName} saiu (${auth.kind === 'WEB' ? 'painel' : 'tablet'}).`,
        });
      });
      void reply.clearCookie(cookies.session, { path: '/' });
      return reply.status(204).send();
    },
  );

  app.get(
    '/api/auth/me',
    { config: { access: { session: 'any', surfaceExempt: true } } },
    async (request) => buildMe(prisma, request.auth!),
  );

  /** Troca da própria senha; encerra as demais sessões do usuário. */
  app.post(
    '/api/auth/password',
    { config: { access: { session: 'WEB' } } },
    async (request, reply) => {
      const auth = request.auth!;
      const input = changePasswordSchema.parse(request.body);
      const key = `password-change:${auth.userId}`;
      await throttle.assertAllowed([key]);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
      if (!user.passwordHash || !(await verifySecret(user.passwordHash, input.currentPassword))) {
        await throttle.registerFailure(key, POLICIES.account);
        throw Errors.invalidCredentials('Senha atual incorreta.');
      }
      await throttle.reset(key);
      const passwordHash = await hashSecret(input.newPassword);
      await prisma.$transaction(async (tx) => {
        const actor = actorFrom(request);
        await tx.user.update({
          where: { id: auth.userId },
          data: { passwordHash, credentialsChangedAt: new Date(), version: { increment: 1 } },
        });
        await revokeSessions(
          tx,
          actor,
          { userId: auth.userId, kind: 'WEB', id: { not: auth.sessionId } },
          'credentials_changed',
        );
        await audit(tx, actor, {
          action: 'auth.password_changed',
          entityType: 'user',
          entityId: auth.userId,
          summary: `${auth.displayName} alterou a própria senha.`,
        });
      });
      return reply.status(204).send();
    },
  );
}
